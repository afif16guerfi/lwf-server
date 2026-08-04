// routes/settings.js — read-only, public system settings. No auth required:
// the home page needs to know whether registration is open (and, in timer
// mode, when it closes) *before* anyone has logged in.

const express = require("express");
const db = require("../db");
const { getSettings, isRegistrationOpen } = require("../settingsCore");

const router = express.Router();

// ---- GET /api/settings/registration — public registration status ----
router.get("/registration", async (req, res) => {
  const data = await db.getAll();
  const settings = getSettings(data);
  res.json({ ...settings, isOpenNow: isRegistrationOpen(settings) });
});

module.exports = router;
