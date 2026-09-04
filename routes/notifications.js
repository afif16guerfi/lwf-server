const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { unreadCountForUser, listForUser } = require("../notificationsCore");

const router = express.Router();

// Works for both referees and admins — every account (whichever role) only
// ever sees its own notifications, filtered server-side by userId, never
// trusting a client-supplied id.
router.use(requireAuth);

// ---- List all of my notifications (read + unread), newest first ----
router.get("/mine", async (req, res) => {
  const data = await db.getAll();
  res.json({ notifications: listForUser(data, req.user.id) });
});

// ---- Unread count only — cheap poll for the 🔔 bell badge ----
router.get("/mine/unread-count", async (req, res) => {
  const data = await db.getAll();
  res.json({ unreadCount: unreadCountForUser(data, req.user.id) });
});

// ---- Mark a single notification as read (idempotent) — also the moment
//      its read state/timestamp is persisted server-side, not just flipped
//      in the UI (see the sixth requirement). ----
router.post("/mine/:id/read", async (req, res) => {
  const data = await db.getAll();
  const n = (data.notifications || []).find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!n) return res.status(404).json({ error: "الإشعار غير موجود." });
  if (!n.isRead) {
    n.isRead = true;
    n.readAt = new Date().toISOString();
    await db.saveAll(data);
  }
  res.json({ notification: n, unreadCount: unreadCountForUser(data, req.user.id) });
});

// ---- Mark every one of my notifications as read at once ----
router.post("/mine/read-all", async (req, res) => {
  const data = await db.getAll();
  const iso = new Date().toISOString();
  let changed = false;
  (data.notifications || []).forEach((n) => {
    if (n.userId === req.user.id && !n.isRead) {
      n.isRead = true;
      n.readAt = iso;
      changed = true;
    }
  });
  if (changed) await db.saveAll(data);
  res.json({ ok: true, unreadCount: 0 });
});

module.exports = router;
