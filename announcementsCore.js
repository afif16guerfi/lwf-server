// announcementsCore.js — small helpers shared between routes/admin.js
// (announcement management) and routes/announcements.js (referee-facing
// read-only access), so both agree on eligibility rules and sort order.

const STATUSES = ["draft", "published", "archived"];

// A referee only gains access to the "الإعلانات" section once their
// enrolment file has been approved and their official document issued —
// exactly the same condition the rest of the platform uses to unlock the
// post-approval referee features (absence/special/edit requests).
function findApprovedApplication(data, userId) {
  return data.applications.find((a) => a.userId === userId && a.status === "approved");
}

function refereeIsEligible(data, userId) {
  return Boolean(findApprovedApplication(data, userId));
}

// All referees currently eligible to receive announcements (approved
// application) — used both to fan out "📢 إعلان جديد" notifications and to
// build the admin's per-announcement read/unread table.
function eligibleRefereeIds(data) {
  return (data.applications || [])
    .filter((a) => a.status === "approved")
    .map((a) => a.userId);
}

// Pinned first, then newest-published first — matches the ordering rule
// required for the referee-facing list.
function sortForReferees(list) {
  return [...list].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt);
  });
}

// Very small allow-list sanitizer for the rich-text content field. The
// editor is admin-only, but we still strip anything that could execute
// script or run inline event handlers as defense in depth before the HTML
// is ever stored or served back to referees.
function sanitizeRichText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<\/?(script|style|iframe|object|embed|form)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*("|')/gi, '$1="#"');
}

// Shape returned to referees: never leak createdBy/history/full readBy list,
// only whether *this* referee has already read it.
function toRefereeView(a, userId) {
  return {
    id: a.id,
    title: a.title,
    summary: a.summary,
    content: a.content,
    image: a.image ? { url: a.image.url } : null,
    attachments: (a.attachments || []).map((att) => ({
      id: att.id,
      originalName: att.originalName,
      mimetype: att.mimetype,
      url: att.url,
      size: att.size,
    })),
    isPinned: Boolean(a.isPinned),
    isRead: (a.readBy || []).some((r) => r.userId === userId),
    publishedAt: a.publishedAt,
  };
}

module.exports = { STATUSES, findApprovedApplication, refereeIsEligible, eligibleRefereeIds, sortForReferees, sanitizeRichText, toRefereeView };
