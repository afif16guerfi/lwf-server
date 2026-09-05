const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { refereeIsEligible, sortForReferees, toRefereeView } = require("../announcementsCore");

const router = express.Router();

// Every route here is referee-only; admins manage announcements from
// routes/admin.js instead. The RBAC check happens on the server for every
// request — never trust the frontend hiding the "الإعلانات" nav link.
router.use(requireAuth, requireRole("referee"));

function eligibilityError(res) {
  return res.status(403).json({
    error: "قسم الإعلانات متاح فقط بعد قبول ملف انخراطك وصدور وثيقتك الرسمية.",
    eligible: false,
  });
}

// ---- Eligibility + unread count (used to show/hide the nav link and its badge) ----
router.get("/eligibility", async (req, res) => {
  const data = await db.getAll();
  const eligible = refereeIsEligible(data, req.user.id);
  if (!eligible) return res.json({ eligible: false, unreadCount: 0 });
  const unreadCount = (data.announcements || []).filter(
    (a) => a.status === "published" && !(a.readBy || []).some((r) => r.userId === req.user.id)
  ).length;
  res.json({ eligible: true, unreadCount });
});

// ---- List all published announcements (pinned first, then newest) ----
router.get("/mine", async (req, res) => {
  const data = await db.getAll();
  if (!refereeIsEligible(data, req.user.id)) return eligibilityError(res);
  const published = (data.announcements || []).filter((a) => a.status === "published");
  const sorted = sortForReferees(published);
  res.json({ announcements: sorted.map((a) => toRefereeView(a, req.user.id)) });
});

// ---- Single announcement detail; marks it as read for this referee ----
router.get("/mine/:id", async (req, res) => {
  const data = await db.getAll();
  if (!refereeIsEligible(data, req.user.id)) return eligibilityError(res);
  const a = (data.announcements || []).find((x) => x.id === req.params.id && x.status === "published");
  if (!a) return res.status(404).json({ error: "الإعلان غير موجود." });

  // This is the ONLY place an announcement is ever marked as read — opening
  // the notification that pointed here does not count (see the tenth
  // requirement: the two are tracked completely separately). Never
  // downgrades an existing readAt on repeat visits.
  if (!(a.readBy || []).some((r) => r.userId === req.user.id)) {
    a.readBy = [...(a.readBy || []), { userId: req.user.id, readAt: new Date().toISOString() }];
    await db.saveAll(data);
  }
  res.json({ announcement: toRefereeView(a, req.user.id) });
});

module.exports = router;
