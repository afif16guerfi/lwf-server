// routes/settings.js — read-only, public system settings. No auth required:
// the home page needs to know whether registration is open (and, in timer
// mode, when it closes) *before* anyone has logged in.

const express = require("express");
const db = require("../db");
const { getSettings, isRegistrationOpen, isSiteEnabled, SITE_DISABLED_MESSAGE } = require("../settingsCore");

const router = express.Router();

// ---- GET /api/settings/registration — public registration status ----
router.get("/registration", async (req, res) => {
  const data = await db.getAll();
  const settings = getSettings(data);
  res.json({ ...settings, isOpenNow: isRegistrationOpen(settings) });
});

// ---- GET /api/settings/site-status — public whole-platform status ----
// No auth required, by design: the home page (and every other page, for a
// logged-out visitor) needs to know whether the platform is disabled
// *before* anyone has logged in, so it can show the "الموقع متوقف مؤقتًا"
// notice instead of the normal login/signup forms.
router.get("/site-status", async (req, res) => {
  const data = await db.getAll();
  const settings = getSettings(data);
  res.json({ enabled: isSiteEnabled(settings), message: SITE_DISABLED_MESSAGE });
});

module.exports = router;
