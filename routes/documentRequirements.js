// routes/documentRequirements.js — read-only endpoint referees (and the
// admin panel) use to fetch the CURRENT list of required/optional
// documents, dynamically, instead of a hardcoded list in the frontend.
// Management (add/edit/delete/template upload) lives under
// /api/admin/document-requirements in routes/admin.js (admin-only).

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { toPublic, sortedRequirements } = require("../documentRequirementsCore");

const router = express.Router();

// ---- GET /api/document-requirements — list of documents a referee must/can upload ----
// Any logged-in user (referee or admin) may read this list.
router.get("/", requireAuth, async (req, res) => {
  const data = await db.getAll();
  const list = sortedRequirements(data.documentRequirements).map(toPublic);
  res.json({ documentRequirements: list });
});

module.exports = router;
