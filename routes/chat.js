const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const cloudinaryLib = require("../cloudinary");
const realtime = require("../realtime");
const { requireAuth, requireActiveAccount } = require("../middleware/auth");
const { MAX_UPLOAD_MB } = require("../config");
const { nowIso, findUser, memberIdsOf, getMembership, ensurePublicConversation, canAccessConversation, effectiveMemberIdsOf } = require("../chatCore");
const { ACCOUNT_STATUS, getAccountStatus } = require("../schema");

const router = express.Router();
router.use(requireAuth);

// ---- Reaction catalog: the single source of truth for which emojis are
//      valid reactions, used both for server-side validation below and by
//      the frontend's reaction picker (fetched once via GET /chat/reactions
//      rather than duplicated in public/chat.js, so adding a new reaction in
//      the future only ever means adding one entry to this array). ----
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡", "👏", "🔥", "🎉"];
function isValidReaction(emoji) {
  return typeof emoji === "string" && REACTIONS.includes(emoji);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/gif",
      "application/pdf",
      "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain", "application/zip",
    ];
    if (!allowed.includes(file.mimetype)) return cb(new Error("نوع الملف غير مدعوم."));
    cb(null, true);
  },
});

/* ================= helpers ================= */

function findConversation(data, id) {
  return data.conversations.find((c) => c.id === id);
}

// Every access check below goes through canAccessConversation (see
// chatCore.js) rather than a raw membership lookup: this is what keeps a
// referee out of the public chat the instant their account stops being
// "active", even if their old conversationMembers row is still there.
function isMember(data, conversationId, userId) {
  return canAccessConversation(data, conversationId, userId);
}

function roleFlags(conv, userId, userRole) {
  const isAdmin = userRole === "admin";
  const isGroup = conv.type === "group";
  const isOwner = isGroup && conv.ownerId === userId;
  return {
    canRename: isGroup && (isAdmin || isOwner),
    canAddMembers: isGroup && (isAdmin || isOwner),
    canRemoveMembers: isGroup && (isAdmin || isOwner),
    canDelete: isGroup && (isAdmin || isOwner),
    canClear: isAdmin,
    canLeave: isGroup && !isAdmin,
    // Delete-for-me: any member of any private/group conversation can remove it from
    // their own list; the public referees' chat can never be removed by anyone.
    canDeleteForMe: conv.type !== "public",
    isOwner,
    isAdmin,
  };
}

function lastMessageOf(data, conversationId) {
  const msgs = data.messages.filter((m) => m.conversationId === conversationId);
  if (!msgs.length) return null;
  return msgs.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b));
}

// A conversation the caller "deleted for me" (membership.hiddenAt set) stays out of
// their list/badge — unless a newer message has arrived since, in which case it
// reappears automatically (same behaviour referees already expect from the rest of
// the platform: nothing is silently lost, it's just off the list while inactive).
function isVisibleForUser(data, conv, userId) {
  const my = getMembership(data, conv.id, userId);
  if (!my || !my.hiddenAt) return true;
  const last = lastMessageOf(data, conv.id);
  const lastAt = last ? last.createdAt : conv.createdAt;
  return new Date(lastAt) > new Date(my.hiddenAt);
}

// Shared by every "start/open a private chat" endpoint (referee↔admin,
// admin↔referee, and referee↔referee) so the get-or-create logic and the
// conversation shape stay in exactly one place.
function getOrCreatePrivateConversation(data, userIdA, userIdB) {
  let conv = data.conversations.find((c) => {
    if (c.type !== "private") return false;
    const ids = memberIdsOf(data, c.id);
    return ids.includes(userIdA) && ids.includes(userIdB);
  });
  if (conv) return { conv, created: false };

  const iso = nowIso();
  conv = { id: uuidv4(), type: "private", name: null, createdBy: userIdA, ownerId: null, createdAt: iso, updatedAt: iso, lastMessageAt: iso };
  data.conversations.push(conv);
  data.conversationMembers.push(
    { id: uuidv4(), conversationId: conv.id, userId: userIdA, role: "member", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso },
    { id: uuidv4(), conversationId: conv.id, userId: userIdB, role: "member", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso }
  );
  return { conv, created: true };
}

function previewOf(msg) {
  if (!msg) return "لا توجد رسائل بعد";
  if (msg.deletedAt) return "🚫 تم حذف هذه الرسالة";
  if (msg.poll) return `📊 استطلاع: ${msg.poll.question}`;
  if (msg.attachment) return msg.message ? msg.message : `📎 ${msg.attachment.originalName || "مرفق"}`;
  return msg.message;
}

// A poll closes the instant its (optional) expiry time passes — computed on
// read rather than stored, so no background job is needed to "close" it.
function pollIsClosed(poll) {
  return !!(poll && poll.expiresAt && new Date(poll.expiresAt) <= new Date());
}

function serializeConversation(conv, data, userId, userRole) {
  const members = data.conversationMembers.filter((m) => m.conversationId === conv.id);
  const my = members.find((m) => m.userId === userId);
  const last = lastMessageOf(data, conv.id);

  let name = conv.name;
  let otherUserId = null;
  if (conv.type === "private") {
    const other = members.find((m) => m.userId !== userId);
    otherUserId = other ? other.userId : null;
    const otherUser = otherUserId ? findUser(data, otherUserId) : null;
    name = otherUser ? otherUser.fullName : "محادثة خاصة";
  }
  const avatarLabel = (name || "؟").trim().charAt(0) || "؟";

  const unreadCount = my
    ? data.messages.filter(
        (m) => m.conversationId === conv.id && m.senderId !== userId && !m.deletedAt &&
          new Date(m.createdAt) > new Date(my.lastReadAt || 0)
      ).length
    : 0;

  return {
    id: conv.id,
    type: conv.type,
    name,
    avatarLabel,
    memberCount: members.length,
    lastMessage: previewOf(last),
    lastMessageAt: last ? last.createdAt : conv.createdAt,
    unreadCount,
    myRole: my ? my.role : null,
    online: conv.type === "private" && otherUserId ? realtime.isOnline(otherUserId) : undefined,
    lastSeenAt: conv.type === "private" && otherUserId ? (findUser(data, otherUserId) || {}).lastSeenAt || null : undefined,
    otherUserId,
    permissions: roleFlags(conv, userId, userRole),
  };
}

function serializeMember(m, data) {
  const u = findUser(data, m.userId);
  return {
    userId: m.userId,
    fullName: u ? u.fullName : "مستخدم محذوف",
    role: m.role,
    userRole: u ? u.role : null,
    joinedAt: m.joinedAt,
    lastReadAt: m.lastReadAt || null,
    lastDeliveredAt: m.lastDeliveredAt || null,
    online: realtime.isOnline(m.userId),
    lastSeenAt: (u || {}).lastSeenAt || null,
  };
}

// `viewerId` personalizes the poll payload (which option — if any — the
// requesting user voted for), so it must be supplied fresh per-recipient
// when a message is broadcast in real time (see sendMessageEvent below),
// not computed once and reused for every member.
function serializePoll(poll, data, viewerId) {
  if (!poll) return null;
  const anonymous = !!poll.anonymous;
  let totalVotes = 0;
  let myOptionId = null;
  const options = poll.options.map((o) => {
    const voterIds = o.voterIds || [];
    totalVotes += voterIds.length;
    if (viewerId && voterIds.includes(viewerId)) myOptionId = o.id;
    return {
      id: o.id,
      text: o.text,
      votesCount: voterIds.length,
      // Real identities are only ever sent to the client when the poll is
      // NOT anonymous — this is enforced here, server-side, not just hidden
      // in the UI, so a secret poll's voters can't be recovered by anyone.
      voters: anonymous ? [] : voterIds.map((uid) => {
        const u = findUser(data, uid);
        return { id: uid, fullName: u ? u.fullName : "مستخدم محذوف" };
      }),
    };
  });
  return {
    question: poll.question,
    expiresAt: poll.expiresAt,
    createdBy: poll.createdBy,
    anonymous,
    totalVotes,
    votedByMe: !!myOptionId,
    myOptionId,
    options,
  };
}

// A message's reactions are stored as a map keyed by userId (one reaction
// per user, same as WhatsApp/Telegram/Messenger — reacting again with a
// different emoji replaces it, reacting again with the *same* emoji removes
// it; see POST /messages/:id/reactions). This groups that map into the
// per-emoji summary the UI actually renders: a count and full name list per
// emoji, plus whether the requesting viewer is one of them (so the client
// can highlight "your" reaction without guessing from the raw map).
function serializeReactions(reactions, data, viewerId) {
  const groups = {};
  Object.entries(reactions || {}).forEach(([userId, r]) => {
    if (!r || !r.emoji) return;
    if (!groups[r.emoji]) groups[r.emoji] = [];
    const u = findUser(data, userId);
    groups[r.emoji].push({ userId, fullName: u ? u.fullName : "مستخدم محذوف" });
  });
  return Object.entries(groups)
    .map(([emoji, users]) => ({
      emoji,
      count: users.length,
      mine: !!(viewerId && reactions && reactions[viewerId] && reactions[viewerId].emoji === emoji),
      users,
    }))
    // Most-reacted emoji first, matching the poll results ordering convention.
    .sort((a, b) => b.count - a.count);
}

function serializeMessage(m, data, viewerId) {
  const sender = findUser(data, m.senderId);
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: sender ? sender.fullName : "مستخدم محذوف",
    senderRole: sender ? sender.role : null,
    message: m.deletedAt ? "" : m.message,
    attachment: m.deletedAt ? null : m.attachment,
    poll: m.deletedAt ? null : serializePoll(m.poll, data, viewerId),
    reactions: m.deletedAt ? [] : serializeReactions(m.reactions, data, viewerId),
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    createdAt: m.createdAt,
  };
}

// Real-time message events (new / edited) carry a poll's "which option did
// *I* vote for" field, which is different per recipient. Broadcasting one
// pre-serialized payload to everyone (as every other event in this file
// does) would leak the sender's own vote to every other member. This sends
// each member their own personalized serialization instead.
function sendMessageEvent(data, conversationId, event, message, excludeUserId) {
  const seen = new Set();
  effectiveMemberIdsOf(data, conversationId).forEach((uid) => {
    if (uid === excludeUserId || seen.has(uid)) return;
    seen.add(uid);
    realtime.sendToUser(uid, event, serializeMessage(message, data, uid));
  });
}

async function uploadChatAttachment(file) {
  if (!file) return null;
  if (!cloudinaryLib.isConfigured()) {
    throw Object.assign(new Error("لم يتم إعداد تخزين الملفات (Cloudinary)."), { status: 500 });
  }
  const result = await cloudinaryLib.uploadBuffer(file.buffer, {
    public_id: `chat_${uuidv4()}`,
    resource_type: "auto",
  });
  return {
    originalName: file.originalname,
    mimetype: file.mimetype,
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type,
  };
}

async function destroyMessageAttachments(msgs) {
  for (const m of msgs) {
    if (m.attachment && m.attachment.publicId) {
      await cloudinaryLib.destroyAsset(m.attachment.publicId, m.attachment.resourceType);
    }
  }
}

/* ================= conversations list / access ================= */

// ---- List every conversation the caller belongs to ----
router.get("/conversations", async (req, res) => {
  const data = await db.getAll();
  const { changed } = ensurePublicConversation(data);
  if (changed) await db.saveAll(data);

  const list = data.conversations
    .filter((c) => canAccessConversation(data, c.id, req.user.id))
    .filter((c) => isVisibleForUser(data, c, req.user.id))
    .map((c) => serializeConversation(c, data, req.user.id, req.user.role))
    .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  res.json({ conversations: list });
});

// ---- Total unread count (for the topbar badge) ----
router.get("/summary", async (req, res) => {
  const data = await db.getAll();
  let totalUnread = 0;
  data.conversations
    .filter((c) => canAccessConversation(data, c.id, req.user.id))
    .filter((c) => isVisibleForUser(data, c, req.user.id))
    .forEach((c) => {
      totalUnread += serializeConversation(c, data, req.user.id, req.user.role).unreadCount;
    });
  res.json({ totalUnread });
});

// ---- Referee directory (any authenticated user) — used to pick members when creating a group ----
router.get("/directory", requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const referees = data.users
    .filter((u) => u.role === "referee" && u.id !== req.user.id)
    .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username }));
  res.json({ referees });
});

// ---- List referees (excluding the caller), with existing private-conversation id if any —
//      used by the "محادثة جديدة" / "بدء محادثة مع حكم" picker to start or resume a private chat.
//      Available to admins (chat with any referee) and referees (chat with any other referee). ----
router.get("/referees", requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const referees = data.users.filter((u) => u.role === "referee" && u.id !== req.user.id).map((u) => {
    const priv = data.conversations.find((c) => {
      if (c.type !== "private") return false;
      const ids = memberIdsOf(data, c.id);
      return ids.includes(u.id) && ids.includes(req.user.id);
    });
    return { id: u.id, fullName: u.fullName, username: u.username, conversationId: priv ? priv.id : null };
  });
  res.json({ referees });
});

// ---- Get-or-create the public conversation, ensuring the caller is a member.
//      requireActiveAccount here is what stops a pending referee's client
//      from learning anything about the public chat (name, member count,
//      even the last-message preview) via this endpoint directly — it isn't
//      enough to just rely on the frontend never calling it. ----
router.get("/public", requireActiveAccount, async (req, res) => {
  const data = await db.getAll();
  const { conversation, changed } = ensurePublicConversation(data);
  if (changed) await db.saveAll(data);
  res.json({ conversation: serializeConversation(conversation, data, req.user.id, req.user.role) });
});

// ---- Referee: get-or-create my private conversation with the admin ----
router.post("/private", async (req, res) => {
  if (req.user.role !== "referee") return res.status(403).json({ error: "هذه الميزة مخصصة للحكام." });
  const data = await db.getAll();
  const admin = data.users.find((u) => u.role === "admin");
  if (!admin) return res.status(500).json({ error: "لا يوجد حساب إدارة." });

  const { conv, created } = getOrCreatePrivateConversation(data, req.user.id, admin.id);
  if (created) {
    await db.saveAll(data);
    realtime.sendToUser(admin.id, "conversation:created", { conversationId: conv.id });
  }
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Referee: get-or-create my private conversation with the admin (GET,
//      idempotent, safe to call on every chat-page load). Exists alongside
//      POST /private for the same purpose — this one is what the pending
//      "wait for activation" screen calls, so a referee who deleted/hid
//      their admin chat can never end up stuck with no way to contact the
//      admin, even before their account is activated. ----
router.get("/get-or-create-admin-chat", async (req, res) => {
  if (req.user.role !== "referee") return res.status(403).json({ error: "هذه الميزة مخصصة للحكام." });
  const data = await db.getAll();
  const admin = data.users.find((u) => u.role === "admin");
  if (!admin) return res.status(500).json({ error: "لا يوجد حساب إدارة." });

  const { conv, created } = getOrCreatePrivateConversation(data, req.user.id, admin.id);
  // If the referee had previously "deleted for me" this conversation, un-hide
  // it again — that's the whole point of this endpoint.
  const membership = getMembership(data, conv.id, req.user.id);
  let changed = created;
  if (membership && membership.hiddenAt) {
    membership.hiddenAt = null;
    changed = true;
  }
  if (changed) {
    await db.saveAll(data);
    if (created) realtime.sendToUser(admin.id, "conversation:created", { conversationId: conv.id });
  }
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Get-or-create a private conversation between the caller and another referee.
//      - Admin caller -> any referee (admin's existing "بدء محادثة مع حكم" picker).
//      - Referee caller -> any other referee (new: judge-to-judge private chat).
//      Referee-to-admin has its own dedicated POST /private endpoint above. ----
router.post("/private/:refereeId", requireActiveAccount, async (req, res) => {
  if (req.user.role !== "admin" && req.user.role !== "referee") {
    return res.status(403).json({ error: "غير مصرح لك بالوصول لهذا المورد." });
  }
  if (req.params.refereeId === req.user.id) {
    return res.status(400).json({ error: "لا يمكنك بدء محادثة مع نفسك." });
  }
  const data = await db.getAll();
  const referee = data.users.find((u) => u.id === req.params.refereeId && u.role === "referee");
  if (!referee) return res.status(404).json({ error: "الحكم غير موجود." });

  const { conv, created } = getOrCreatePrivateConversation(data, req.user.id, referee.id);
  if (created) {
    await db.saveAll(data);
    realtime.sendToUser(referee.id, "conversation:created", { conversationId: conv.id });
  }
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Single conversation (header refresh) ----
router.get("/conversations/:id", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Members list ----
router.get("/conversations/:id/members", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });
  const members = data.conversationMembers
    .filter((m) => m.conversationId === conv.id)
    .map((m) => serializeMember(m, data))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1));
  res.json({ members });
});

// ---- Candidates to add (referees not already in this group) ----
router.get("/conversations/:id/candidates", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv) return res.status(404).json({ error: "المحادثة غير موجودة." });
  const flags = roleFlags(conv, req.user.id, req.user.role);
  if (conv.type !== "group" || !flags.canAddMembers) return res.status(403).json({ error: "غير مصرح لك بإضافة أعضاء." });
  const memberIds = new Set(memberIdsOf(data, conv.id));
  const candidates = data.users
    .filter((u) => u.role === "referee" && !memberIds.has(u.id))
    .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username }));
  res.json({ candidates });
});

/* ================= groups ================= */

// ---- Create a group (admin or referee) ----
router.post("/groups", requireActiveAccount, async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "يرجى إدخال اسم المجموعة." });
  const data = await db.getAll();
  const admin = data.users.find((u) => u.role === "admin");
  const iso = nowIso();
  const conv = { id: uuidv4(), type: "group", name: String(name).trim(), createdBy: req.user.id, ownerId: req.user.id, createdAt: iso, updatedAt: iso, lastMessageAt: iso };
  data.conversations.push(conv);

  const chosen = Array.isArray(memberIds)
    ? [...new Set(memberIds)].filter((id) => data.users.some((u) => u.id === id && u.role === "referee" && u.id !== req.user.id))
    : [];

  data.conversationMembers.push({ id: uuidv4(), conversationId: conv.id, userId: req.user.id, role: "owner", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso });
  if (admin && admin.id !== req.user.id) {
    data.conversationMembers.push({ id: uuidv4(), conversationId: conv.id, userId: admin.id, role: "admin", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso });
  }
  chosen.forEach((uid) => {
    data.conversationMembers.push({ id: uuidv4(), conversationId: conv.id, userId: uid, role: "member", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso });
  });

  await db.saveAll(data);
  const memberIdsFinal = memberIdsOf(data, conv.id);
  realtime.sendToUsers(memberIdsFinal, "conversation:created", { conversationId: conv.id }, req.user.id);
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Rename group ----
router.put("/groups/:id", async (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "يرجى إدخال اسم المجموعة." });
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || conv.type !== "group") return res.status(404).json({ error: "المجموعة غير موجودة." });
  const flags = roleFlags(conv, req.user.id, req.user.role);
  if (!flags.canRename) return res.status(403).json({ error: "غير مصرح لك بإعادة تسمية هذه المجموعة." });

  conv.name = String(name).trim();
  conv.updatedAt = nowIso();
  await db.saveAll(data);
  realtime.sendToUsers(memberIdsOf(data, conv.id), "group:renamed", { conversationId: conv.id, name: conv.name });
  res.json({ conversation: serializeConversation(conv, data, req.user.id, req.user.role) });
});

// ---- Delete group ----
router.delete("/groups/:id", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || conv.type !== "group") return res.status(404).json({ error: "المجموعة غير موجودة." });
  const flags = roleFlags(conv, req.user.id, req.user.role);
  if (!flags.canDelete) return res.status(403).json({ error: "غير مصرح لك بحذف هذه المجموعة." });

  const memberIds = memberIdsOf(data, conv.id);
  const msgs = data.messages.filter((m) => m.conversationId === conv.id);
  await destroyMessageAttachments(msgs);

  data.conversations = data.conversations.filter((c) => c.id !== conv.id);
  data.conversationMembers = data.conversationMembers.filter((m) => m.conversationId !== conv.id);
  data.messages = data.messages.filter((m) => m.conversationId !== conv.id);
  await db.saveAll(data);

  realtime.sendToUsers(memberIds, "conversation:deleted", { conversationId: conv.id });
  res.json({ ok: true });
});

// ---- Add members ----
router.post("/groups/:id/members", requireActiveAccount, async (req, res) => {
  const { memberIds } = req.body;
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || conv.type !== "group") return res.status(404).json({ error: "المجموعة غير موجودة." });
  const flags = roleFlags(conv, req.user.id, req.user.role);
  if (!flags.canAddMembers) return res.status(403).json({ error: "غير مصرح لك بإضافة أعضاء." });

  const existing = new Set(memberIdsOf(data, conv.id));
  const toAdd = Array.isArray(memberIds)
    ? [...new Set(memberIds)].filter((id) => !existing.has(id) && data.users.some((u) => u.id === id && u.role === "referee"))
    : [];
  if (!toAdd.length) return res.status(400).json({ error: "لا يوجد أعضاء جدد صالحين للإضافة." });

  const iso = nowIso();
  toAdd.forEach((uid) => {
    data.conversationMembers.push({ id: uuidv4(), conversationId: conv.id, userId: uid, role: "member", joinedAt: iso, lastReadAt: iso, lastDeliveredAt: iso });
  });
  conv.updatedAt = iso;
  await db.saveAll(data);

  realtime.sendToUsers(memberIdsOf(data, conv.id), "member:added", { conversationId: conv.id, addedUserIds: toAdd });
  res.json({ members: data.conversationMembers.filter((m) => m.conversationId === conv.id).map((m) => serializeMember(m, data)) });
});

// ---- Remove a member ----
router.delete("/groups/:id/members/:userId", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || conv.type !== "group") return res.status(404).json({ error: "المجموعة غير موجودة." });
  const flags = roleFlags(conv, req.user.id, req.user.role);
  if (!flags.canRemoveMembers) return res.status(403).json({ error: "غير مصرح لك بإزالة أعضاء." });

  const target = findUser(data, req.params.userId);
  if (target && target.role === "admin") return res.status(403).json({ error: "لا يمكن إزالة الإدارة من المجموعة." });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "استخدم مغادرة المجموعة لإزالة نفسك." });

  const before = memberIdsOf(data, conv.id);
  data.conversationMembers = data.conversationMembers.filter((m) => !(m.conversationId === conv.id && m.userId === req.params.userId));
  conv.updatedAt = nowIso();
  await db.saveAll(data);

  realtime.sendToUsers(before, "member:removed", { conversationId: conv.id, removedUserId: req.params.userId });
  res.json({ ok: true });
});

// ---- Leave group (ownership transfers to admin if the owner leaves) ----
router.post("/groups/:id/leave", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || conv.type !== "group") return res.status(404).json({ error: "المجموعة غير موجودة." });
  if (req.user.role === "admin") return res.status(400).json({ error: "لا يمكن للإدارة مغادرة المجموعة." });
  if (!isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "لست عضوًا في هذه المجموعة." });

  const before = memberIdsOf(data, conv.id);
  if (conv.ownerId === req.user.id) {
    const admin = data.users.find((u) => u.role === "admin");
    if (admin) {
      conv.ownerId = admin.id;
      const adminMembership = getMembership(data, conv.id, admin.id);
      if (adminMembership) adminMembership.role = "owner";
    }
  }
  data.conversationMembers = data.conversationMembers.filter((m) => !(m.conversationId === conv.id && m.userId === req.user.id));
  conv.updatedAt = nowIso();
  await db.saveAll(data);

  realtime.sendToUsers(before, "member:removed", { conversationId: conv.id, removedUserId: req.user.id });
  res.json({ ok: true });
});

/* ================= conversation-level moderation ================= */

// ---- Delete a conversation from *my* list only (private or group). Other members
//      keep it untouched; the public referees' chat can never be removed by anyone —
//      enforced here in the backend, not just hidden in the UI. ----
router.delete("/conversations/:id", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv) return res.status(404).json({ error: "المحادثة غير موجودة." });
  if (conv.type === "public") return res.status(403).json({ error: "لا يمكن حذف الدردشة العامة للحكام." });

  const membership = getMembership(data, conv.id, req.user.id);
  if (!membership) return res.status(404).json({ error: "لست عضوًا في هذه المحادثة." });

  // A referee whose account is still pending activation can only ever reach
  // the admin through this one private conversation — never let them delete
  // it, or they'd have no way left to contact the admin at all.
  const caller = findUser(data, req.user.id);
  if (caller && caller.role === "referee" && getAccountStatus(caller) === ACCOUNT_STATUS.PENDING) {
    return res.status(403).json({ error: "لا يمكن حذف محادثة الإدارة أثناء انتظار تفعيل حسابك." });
  }

  membership.hiddenAt = nowIso();
  await db.saveAll(data);
  realtime.sendToUser(req.user.id, "conversation:deleted", { conversationId: conv.id });
  res.json({ ok: true });
});

// ---- Clear conversation (admin only): delete messages, keep conversation & members ----
router.post("/conversations/:id/clear", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "غير مصرح لك بمسح هذه المحادثة." });
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv) return res.status(404).json({ error: "المحادثة غير موجودة." });

  const msgs = data.messages.filter((m) => m.conversationId === conv.id);
  await destroyMessageAttachments(msgs);
  await db.deleteMessagesByConversation(conv.id);

  realtime.sendToUsers(effectiveMemberIdsOf(data, conv.id), "conversation:cleared", { conversationId: conv.id });
  res.json({ ok: true });
});

/* ================= messages ================= */

// ---- List messages (paginated, oldest→newest, ?before=<iso>&limit=<n>) ----
router.get("/conversations/:id/messages", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before ? new Date(req.query.before) : null;

  let msgs = data.messages
    .filter((m) => m.conversationId === conv.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (before) msgs = msgs.filter((m) => new Date(m.createdAt) < before);
  const page = msgs.slice(Math.max(0, msgs.length - limit));

  res.json({ messages: page.map((m) => serializeMessage(m, data, req.user.id)), hasMore: msgs.length > page.length });
});

// ---- Send a message (text and/or attachment) ----
router.post("/conversations/:id/messages", upload.single("attachment"), async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });

  const text = (req.body.message || "").trim();
  if (!text && !req.file) return res.status(400).json({ error: "اكتب رسالة أو أرفق ملفًا." });

  let attachment = null;
  try {
    attachment = await uploadChatAttachment(req.file);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }

  const iso = nowIso();
  const message = {
    id: uuidv4(),
    conversationId: conv.id,
    senderId: req.user.id,
    message: text,
    attachment,
    reactions: {},
    editedAt: null,
    deletedAt: null,
    createdAt: iso,
  };
  await db.pushMessage(message);
  await db.touchConversation(conv.id, iso);

  const fresh = await db.getAll();
  // No excludeUserId: the sender's other open tabs/devices need this push too.
  sendMessageEvent(fresh, conv.id, "message:new", message);
  res.json({ message: serializeMessage(message, fresh, req.user.id) });
});

// ---- Edit a message (sender or admin) ----
router.put("/messages/:id", async (req, res) => {
  const { message } = req.body;
  if (!message || !String(message).trim()) return res.status(400).json({ error: "لا يمكن أن تكون الرسالة فارغة." });
  const data = await db.getAll();
  const msg = data.messages.find((m) => m.id === req.params.id);
  if (!msg || msg.deletedAt) return res.status(404).json({ error: "الرسالة غير موجودة." });
  if (msg.senderId !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "غير مصرح لك بتعديل هذه الرسالة." });
  }
  if (req.user.role !== "admin" && !isMember(data, msg.conversationId, req.user.id)) {
    return res.status(403).json({ error: "غير مصرح لك بتعديل هذه الرسالة." });
  }
  const iso = nowIso();
  await db.updateMessageById(msg.id, { message: String(message).trim(), editedAt: iso });

  const fresh = await db.getAll();
  const updated = fresh.messages.find((m) => m.id === msg.id);
  sendMessageEvent(fresh, msg.conversationId, "message:edited", updated);
  res.json({ message: serializeMessage(updated, fresh, req.user.id) });
});

// ---- Delete a message (soft delete — sender or admin) ----
router.delete("/messages/:id", async (req, res) => {
  const data = await db.getAll();
  const msg = data.messages.find((m) => m.id === req.params.id);
  if (!msg || msg.deletedAt) return res.status(404).json({ error: "الرسالة غير موجودة." });
  if (msg.senderId !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "غير مصرح لك بحذف هذه الرسالة." });
  }
  if (req.user.role !== "admin" && !isMember(data, msg.conversationId, req.user.id)) {
    return res.status(403).json({ error: "غير مصرح لك بحذف هذه الرسالة." });
  }
  if (msg.attachment && msg.attachment.publicId) {
    await cloudinaryLib.destroyAsset(msg.attachment.publicId, msg.attachment.resourceType);
  }
  const iso = nowIso();
  await db.updateMessageById(msg.id, { deletedAt: iso, message: "", attachment: null });

  realtime.sendToUsers(effectiveMemberIdsOf(data, msg.conversationId), "message:deleted", { id: msg.id, conversationId: msg.conversationId, deletedAt: iso });
  res.json({ ok: true });
});

// ---- Mark conversation as read ----
router.post("/conversations/:id/read", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });
  const membership = getMembership(data, conv.id, req.user.id);
  const iso = nowIso();
  membership.lastReadAt = iso;
  // Reading a message obviously means it was also delivered — keep the two
  // timestamps consistent so a message can never appear "read" but not yet
  // "delivered" in the UI.
  if (!membership.lastDeliveredAt || new Date(membership.lastDeliveredAt) < new Date(iso)) {
    membership.lastDeliveredAt = iso;
  }
  await db.saveAll(data);
  realtime.sendToUsers(effectiveMemberIdsOf(data, conv.id), "read:updated", { conversationId: conv.id, userId: req.user.id, readAt: membership.lastReadAt, deliveredAt: membership.lastDeliveredAt }, req.user.id);
  res.json({ ok: true });
});

// ---- Mark every conversation the caller belongs to as "delivered" up to
//      now. Called by the client whenever its device is actively connected
//      and receiving (WebSocket open/reconnect, or a live message push) —
//      this is what lets a message reach the ✓✓ "delivered" (grey) tick
//      even before the recipient opens that specific conversation. ----
router.post("/delivered", async (req, res) => {
  const data = await db.getAll();
  const iso = nowIso();
  const touchedConvIds = [];
  data.conversationMembers
    .filter((m) => m.userId === req.user.id)
    // Re-checks access per conversation rather than trusting the membership
    // row alone — excludes a public-chat row left over from before the
    // account was (re)set to pending.
    .filter((m) => isMember(data, m.conversationId, req.user.id))
    .forEach((m) => {
      if (!m.lastDeliveredAt || new Date(m.lastDeliveredAt) < new Date(iso)) {
        m.lastDeliveredAt = iso;
        touchedConvIds.push(m.conversationId);
      }
    });
  if (touchedConvIds.length) {
    await db.saveAll(data);
    touchedConvIds.forEach((convId) => {
      realtime.sendToUsers(effectiveMemberIdsOf(data, convId), "delivered:updated", { conversationId: convId, userId: req.user.id, deliveredAt: iso }, req.user.id);
    });
  }
  res.json({ ok: true });
});

// ---- Typing indicator (ephemeral, not persisted) ----
router.post("/conversations/:id/typing", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });
  const me = findUser(data, req.user.id);
  realtime.sendToUsers(effectiveMemberIdsOf(data, conv.id), "typing", { conversationId: conv.id, userId: req.user.id, fullName: me ? me.fullName : "" }, req.user.id);
  res.json({ ok: true });
});

/* ================= polls ================= */
//
// A poll is sent as a regular chat message with an extra `poll` field, so it
// reuses every existing message mechanism (storage, pagination, real-time
// delivery, soft-delete, per-conversation membership checks) instead of
// building a parallel system. Votes mutate that same message and are
// broadcast as a normal "message:edited" event, which the frontend already
// knows how to merge in place.

// ---- Create a poll (question + options, optional expiry) ----
router.post("/conversations/:id/polls", async (req, res) => {
  const data = await db.getAll();
  const conv = findConversation(data, req.params.id);
  if (!conv || !isMember(data, conv.id, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });

  const question = String(req.body.question || "").trim();
  if (!question) return res.status(400).json({ error: "يرجى كتابة سؤال الاستطلاع." });

  const rawOptions = Array.isArray(req.body.options) ? req.body.options : [];
  const options = rawOptions.map((o) => String(o || "").trim()).filter(Boolean);
  if (options.length < 2) return res.status(400).json({ error: "يجب إضافة خيارين على الأقل." });
  if (options.length > 20) return res.status(400).json({ error: "لا يمكن إضافة أكثر من 20 خيارًا." });

  let expiresAt = null;
  if (req.body.expiresAt) {
    const d = new Date(req.body.expiresAt);
    if (!isNaN(d.getTime())) expiresAt = d.toISOString();
  }

  const iso = nowIso();
  const message = {
    id: uuidv4(),
    conversationId: conv.id,
    senderId: req.user.id,
    message: "",
    attachment: null,
    poll: {
      question,
      options: options.map((text) => ({ id: uuidv4(), text, voterIds: [] })),
      expiresAt,
      createdBy: req.user.id,
      // Secret poll: voter identities are never sent to any client (see
      // serializePoll) — only vote counts and percentages.
      anonymous: !!req.body.anonymous,
    },
    reactions: {},
    editedAt: null,
    deletedAt: null,
    createdAt: iso,
  };
  await db.pushMessage(message);
  await db.touchConversation(conv.id, iso);

  const fresh = await db.getAll();
  sendMessageEvent(fresh, conv.id, "message:new", message);
  res.json({ message: serializeMessage(message, fresh, req.user.id) });
});

// ---- Vote on a poll option (one vote per member, enforced server-side) ----
router.post("/polls/:id/vote", async (req, res) => {
  const optionId = req.body.optionId;
  if (!optionId) return res.status(400).json({ error: "يرجى اختيار إجابة." });

  const data = await db.getAll();
  const msg = data.messages.find((m) => m.id === req.params.id);
  if (!msg || msg.deletedAt || !msg.poll) return res.status(404).json({ error: "الاستطلاع غير موجود." });
  if (!isMember(data, msg.conversationId, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });
  if (pollIsClosed(msg.poll)) return res.status(400).json({ error: "انتهى موعد التصويت على هذا الاستطلاع." });

  const alreadyVoted = msg.poll.options.some((o) => o.voterIds.includes(req.user.id));
  if (alreadyVoted) return res.status(400).json({ error: "لقد قمت بالتصويت في هذا الاستطلاع مسبقًا." });

  const option = msg.poll.options.find((o) => o.id === optionId);
  if (!option) return res.status(400).json({ error: "خيار غير صالح." });
  option.voterIds.push(req.user.id);

  await db.updateMessageById(msg.id, { poll: msg.poll });

  const fresh = await db.getAll();
  const updated = fresh.messages.find((m) => m.id === msg.id);
  sendMessageEvent(fresh, msg.conversationId, "message:edited", updated);
  res.json({ message: serializeMessage(updated, fresh, req.user.id) });
});

/* ================= reactions ================= */
//
// One reaction per user per message (WhatsApp/Telegram/Messenger model):
// tapping a new emoji sets/replaces the caller's reaction, tapping the same
// emoji again removes it. This single toggle endpoint serves both the
// double-tap-to-heart gesture and the full reaction picker — the frontend
// just decides which emoji to send.

// ---- Reaction catalog (see REACTIONS above) — fetched once by the
//      frontend's picker instead of hardcoding the list a second time, so
//      adding a new reaction only ever means editing REACTIONS in this file. ----
router.get("/reactions", (req, res) => {
  res.json({ reactions: REACTIONS });
});

// ---- Add / change / remove the caller's reaction to a message ----
router.post("/messages/:id/reactions", async (req, res) => {
  const emoji = req.body && req.body.emoji;
  if (!isValidReaction(emoji)) return res.status(400).json({ error: "تفاعل غير مدعوم." });

  const data = await db.getAll();
  const msg = data.messages.find((m) => m.id === req.params.id);
  if (!msg || msg.deletedAt) return res.status(404).json({ error: "الرسالة غير موجودة." });
  if (!isMember(data, msg.conversationId, req.user.id)) return res.status(404).json({ error: "المحادثة غير موجودة." });

  const reactions = { ...(msg.reactions || {}) };
  const existing = reactions[req.user.id];
  if (existing && existing.emoji === emoji) {
    delete reactions[req.user.id]; // same emoji tapped again -> remove
  } else {
    reactions[req.user.id] = { emoji, createdAt: nowIso() };
  }
  await db.updateMessageById(msg.id, { reactions });

  const fresh = await db.getAll();
  const updated = fresh.messages.find((m) => m.id === msg.id);
  // Reuses the existing "message:edited" event — the frontend already knows
  // how to merge any updated message (poll votes use the exact same path),
  // so no new realtime event type or client wiring is needed.
  sendMessageEvent(fresh, msg.conversationId, "message:edited", updated);
  res.json({ message: serializeMessage(updated, fresh, req.user.id) });
});

module.exports = router;
