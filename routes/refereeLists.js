// routes/refereeLists.js — admin-only CRUD for قوائم الحكام (see
// refereeListsCore.js for the selection/column logic). Mounted at
// /api/admin/referee-lists in server.js.

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { allEligibleReferees, resolveReferees, sanitizeConfig, validateConfig } = require("../refereeListsCore");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

function findList(data, id) {
  return (data.refereeLists || []).find((l) => l.id === id);
}

// Attaches the CURRENT roster (resolved from live referee data) to a saved
// list config — this is what open/preview/edit/print all consume, so a
// list never shows stale rank/phone/kit-size info.
function withResolvedReferees(list, data) {
  return { ...list, resolvedReferees: resolveReferees(data, list) };
}

// ---- Referees eligible to appear on any list — used by the manual-pick
// checklist in the list editor. ----
router.get("/eligible-referees", async (req, res) => {
  const data = await db.getAll();
  res.json({ referees: allEligibleReferees(data) });
});

// ---- Saved lists: index (summaries only, no full referee data) ----
router.get("/", async (req, res) => {
  const data = await db.getAll();
  const lists = (data.refereeLists || [])
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((l) => ({
      id: l.id,
      title: l.title,
      selectionMode: l.selectionMode,
      orientation: l.orientation,
      refereeCount: resolveReferees(data, l).length,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    }));
  res.json({ lists });
});

// ---- One saved list, fully resolved (open / preview / edit / print) ----
router.get("/:id", async (req, res) => {
  const data = await db.getAll();
  const list = findList(data, req.params.id);
  if (!list) return res.status(404).json({ error: "القائمة غير موجودة." });
  res.json({ list: withResolvedReferees(list, data) });
});

// ---- Create a new list ----
router.post("/", async (req, res) => {
  const data = await db.getAll();
  const config = sanitizeConfig(req.body);
  const error = validateConfig(config, data);
  if (error) return res.status(400).json({ error });

  const nowIso = new Date().toISOString();
  const list = { id: uuidv4(), ...config, createdAt: nowIso, updatedAt: nowIso, createdBy: req.user.id };
  if (!Array.isArray(data.refereeLists)) data.refereeLists = [];
  data.refereeLists.push(list);
  await db.saveAll(data);
  res.json({ list: withResolvedReferees(list, data) });
});

// ---- Update an existing list's title/selection/columns/signature/orientation ----
router.put("/:id", async (req, res) => {
  const data = await db.getAll();
  const list = findList(data, req.params.id);
  if (!list) return res.status(404).json({ error: "القائمة غير موجودة." });

  const config = sanitizeConfig(req.body);
  const error = validateConfig(config, data);
  if (error) return res.status(400).json({ error });

  Object.assign(list, config, { updatedAt: new Date().toISOString() });
  await db.saveAll(data);
  res.json({ list: withResolvedReferees(list, data) });
});

// ---- Duplicate/clone a saved list to start a new one from it ----
router.post("/:id/duplicate", async (req, res) => {
  const data = await db.getAll();
  const source = findList(data, req.params.id);
  if (!source) return res.status(404).json({ error: "القائمة غير موجودة." });

  const nowIso = new Date().toISOString();
  const copy = {
    ...source,
    id: uuidv4(),
    title: `${source.title} (نسخة)`,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: req.user.id,
  };
  data.refereeLists.push(copy);
  await db.saveAll(data);
  res.json({ list: withResolvedReferees(copy, data) });
});

// ---- Delete a saved list (admin only, per the platform's existing
// permissions model — referees never see or touch this feature at all) ----
router.delete("/:id", async (req, res) => {
  const data = await db.getAll();
  const list = findList(data, req.params.id);
  if (!list) return res.status(404).json({ error: "القائمة غير موجودة." });
  data.refereeLists = data.refereeLists.filter((l) => l.id !== req.params.id);
  await db.saveAll(data);
  res.json({ ok: true });
});

module.exports = router;
