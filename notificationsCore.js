// notificationsCore.js — shared helpers for the platform's in-app
// notification system (🔔), used by routes/notifications.js (list/read),
// routes/requests.js + routes/admin.js (request lifecycle notifications),
// and routes/admin.js's announcement routes (new announcement / update
// notifications). Kept separate from announcementsCore.js's `readBy` on
// purpose — a notification being opened and an announcement actually being
// read are two different, separately-tracked things (see the tenth
// requirement in the requests/notifications/announcements upgrade spec).

const { v4: uuidv4 } = require("uuid");
const realtime = require("./realtime");

// ---- Notification types (كل الأنواع المطلوبة للحكم وللإدارة) ----
const NOTIFICATION_TYPES = {
  REQUEST_NEW: "request_new", // -> to admins: a referee submitted a new request
  REQUEST_NEEDS_CLARIFICATION: "request_needs_clarification", // -> to referee
  REQUEST_RESUBMITTED: "request_resubmitted", // -> to admins
  REQUEST_APPROVED: "request_approved", // -> to referee
  REQUEST_REJECTED: "request_rejected", // -> to referee
  ANNOUNCEMENT_NEW: "announcement_new", // -> to eligible referees
  ANNOUNCEMENT_UPDATED: "announcement_updated", // -> to eligible referees (only if admin opts in)
  // ---- Account activation review (قيد المراجعة / يحتاج إلى تعديل / مفعّل / مرفوض) ----
  REGISTRATION_NEEDS_EDIT: "registration_needs_edit", // -> to referee: admin flagged field(s) to correct
  REGISTRATION_RESUBMITTED: "registration_resubmitted", // -> to admins: referee corrected and resent
  REGISTRATION_ACCEPTED: "registration_accepted", // -> to referee: account accepted & activated
  REGISTRATION_REJECTED: "registration_rejected", // -> to referee: account rejected
};

function findAdminUserIds(data) {
  return (data.users || []).filter((u) => u.role === "admin").map((u) => u.id);
}

// Creates one notification for one user. `link` is a client-side hash
// route (e.g. "#/requests", "#/announcement/<id>") the frontend navigates
// to when the notification is opened — never a raw API path.
function buildNotification({ userId, type, title, body, link, meta }) {
  return {
    id: uuidv4(),
    userId,
    type,
    title: String(title || ""),
    body: String(body || ""),
    link: link || null,
    meta: meta || {},
    isRead: false,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

// Mutates `data.notifications` in place (caller still owns db.saveAll).
// Returns the created notifications, so the caller can push them out over
// the realtime/WebSocket channel.
function notifyUsers(data, userIds, { type, title, body, link, meta }) {
  if (!Array.isArray(data.notifications)) data.notifications = [];
  const uniqueIds = Array.from(new Set((userIds || []).filter(Boolean)));
  const created = uniqueIds.map((userId) => buildNotification({ userId, type, title, body, link, meta }));
  data.notifications.push(...created);
  return created;
}

function notifyUser(data, userId, opts) {
  const [n] = notifyUsers(data, [userId], opts);
  return n || null;
}

function notifyAdmins(data, opts) {
  return notifyUsers(data, findAdminUserIds(data), opts);
}

function unreadCountForUser(data, userId) {
  return (data.notifications || []).filter((n) => n.userId === userId && !n.isRead).length;
}

function listForUser(data, userId) {
  return (data.notifications || [])
    .filter((n) => n.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Removes every notification pointing at a deleted resource (an announcement
// or request that no longer exists), so a referee/admin never opens a
// notification and lands on a broken link (see the eleventh requirement).
function removeNotificationsByMeta(data, matchFn) {
  if (!Array.isArray(data.notifications)) return;
  data.notifications = data.notifications.filter((n) => !matchFn(n));
}

// Pushes a realtime "notification:new" event to every user who just got a
// notification (each with their own up-to-date unread count), so an
// already-connected tab bumps its 🔔 badge immediately instead of waiting
// for the next page navigation's poll. `data` must be the SAME data object
// already saved via db.saveAll — unreadCountForUser reads from it directly
// so the pushed count reflects what's actually persisted.
function pushRealtime(data, createdNotifications) {
  createdNotifications.forEach((n) => {
    realtime.sendToUser(n.userId, "notification:new", {
      notification: n,
      unreadCount: unreadCountForUser(data, n.userId),
    });
  });
}

module.exports = {
  NOTIFICATION_TYPES,
  findAdminUserIds,
  notifyUser, notifyUsers, notifyAdmins,
  unreadCountForUser, listForUser,
  removeNotificationsByMeta,
  pushRealtime,
};
