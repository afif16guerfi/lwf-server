// chatCore.js — small helpers shared between routes/chat.js and routes/auth.js
// (auth.js needs to enrol a brand-new referee into the public conversation at
// signup time, without importing the whole chat router).

const { v4: uuidv4 } = require("uuid");
const { ACCOUNT_STATUS, getAccountStatus } = require("./schema");

function nowIso() {
  return new Date().toISOString();
}

function findUser(data, id) {
  return data.users.find((u) => u.id === id);
}

function memberIdsOf(data, conversationId) {
  return data.conversationMembers.filter((m) => m.conversationId === conversationId).map((m) => m.userId);
}

function getMembership(data, conversationId, userId) {
  return data.conversationMembers.find((m) => m.conversationId === conversationId && m.userId === userId);
}

// Ensures the single "public — all referees + admin" conversation exists and
// that every current referee/admin account is a member of it. The platform
// has no migration tool (single-document Mongo store), so this runs
// opportunistically instead of a one-off migration: on signup and whenever
// the chat list is loaded. Idempotent — safe to call repeatedly.
function ensurePublicConversation(data) {
  let conversation = data.conversations.find((c) => c.type === "public");
  let changed = false;
  if (!conversation) {
    const iso = nowIso();
    conversation = {
      id: uuidv4(),
      type: "public",
      name: "الدردشة العامة للحكام",
      createdBy: null,
      ownerId: null,
      createdAt: iso,
      updatedAt: iso,
      lastMessageAt: iso,
      // Referees the admin explicitly removed from the public chat (see
      // routes/chat.js DELETE /groups/:id/members/:userId, extended to
      // also accept the public conversation). Without this, the
      // auto-enrolment loop below — which runs on nearly every chat
      // request to keep newly-activated referees enrolled — would just
      // re-add them on the very next request. An admin can always undo
      // this by re-adding the member, which clears the exclusion.
      excludedUserIds: [],
    };
    data.conversations.push(conversation);
    changed = true;
  }
  // Backfill for a public conversation created before admin-managed
  // removal existed (see comment above).
  if (!Array.isArray(conversation.excludedUserIds)) conversation.excludedUserIds = [];
  const excluded = new Set(conversation.excludedUserIds);
  const existing = new Set(memberIdsOf(data, conversation.id));
  data.users.forEach((u) => {
    const eligible = u.role === "admin" || (u.role === "referee" && getAccountStatus(u) === ACCOUNT_STATUS.ACTIVE);
    if (eligible && !existing.has(u.id) && !excluded.has(u.id)) {
      data.conversationMembers.push({
        id: uuidv4(),
        conversationId: conversation.id,
        userId: u.id,
        role: u.role === "admin" ? "owner" : "member",
        joinedAt: nowIso(),
        lastReadAt: nowIso(),
        lastDeliveredAt: nowIso(),
      });
      changed = true;
    }
  });
  return { conversation, changed };
}

// A referee whose account is currently pending must never be able to read,
// send to, or otherwise act on the public referees' conversation — even if a
// stale conversationMembers row still exists for them (e.g. the admin
// reactivated an account by mistake and reverted it back to "pending" via
// POST /admin/users/:id/activate + /deactivate — see routes/admin.js, which
// deliberately does NOT delete their old membership row so re-activation
// needs no extra step). This is the single choke point every access check in
// routes/chat.js goes through, so the rule can't be bypassed by a route that
// forgot to re-check account status. It only ever narrows access, and only
// for type "public" — private and group conversations behave exactly as
// before.
function canAccessConversation(data, conversationId, userId) {
  const membership = getMembership(data, conversationId, userId);
  if (!membership) return false;
  const conv = data.conversations.find((c) => c.id === conversationId);
  if (conv && conv.type === "public") {
    const user = findUser(data, userId);
    if (user && user.role === "referee" && getAccountStatus(user) !== ACCOUNT_STATUS.ACTIVE) return false;
  }
  return true;
}

// Same idea as canAccessConversation, but for the member-id lists used to
// decide who receives a real-time push (new/edited/deleted messages, typing,
// read/delivered receipts, etc.). Drop-in replacement for memberIdsOf at any
// broadcast call site — identical result for private/group conversations,
// and additionally excludes any currently-pending referee from a public
// conversation's recipient list.
function effectiveMemberIdsOf(data, conversationId) {
  const ids = memberIdsOf(data, conversationId);
  const conv = data.conversations.find((c) => c.id === conversationId);
  if (!conv || conv.type !== "public") return ids;
  return ids.filter((uid) => {
    const user = findUser(data, uid);
    return !(user && user.role === "referee" && getAccountStatus(user) !== ACCOUNT_STATUS.ACTIVE);
  });
}

// Every user who shares at least one conversation with userId — i.e. anyone
// who could ever legitimately see userId's name in the chat UI, and
// therefore the only people who need to be told when their presence changes
// (see presence.js). Deliberately NOT "every user on the platform": a
// platform-wide broadcast on every connect/disconnect would scale badly and
// nobody outside a shared conversation ever sees this user's presence
// anyway, so it would be wasted traffic — see "الأداء" requirement.
function contactsOf(data, userId) {
  const myConvIds = new Set(
    data.conversationMembers.filter((m) => m.userId === userId).map((m) => m.conversationId)
  );
  const out = new Set();
  data.conversationMembers.forEach((m) => {
    if (m.userId !== userId && myConvIds.has(m.conversationId)) out.add(m.userId);
  });
  return [...out];
}

module.exports = {
  nowIso,
  findUser,
  memberIdsOf,
  getMembership,
  ensurePublicConversation,
  canAccessConversation,
  effectiveMemberIdsOf,
  contactsOf,
};
