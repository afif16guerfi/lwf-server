const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { WebSocketServer } = require("ws");

const db = require("./db");
const realtime = require("./realtime");
const presence = require("./presence");
const { nowIso } = require("./chatCore");
const { PORT, ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET } = require("./config");

const authRoutes = require("./routes/auth");
const applicationRoutes = require("./routes/applications");
const adminRoutes = require("./routes/admin");
const requestRoutes = require("./routes/requests");
const chatRoutes = require("./routes/chat");
const announcementRoutes = require("./routes/announcements");
const notificationRoutes = require("./routes/notifications");
const settingsRoutes = require("./routes/settings");
const documentRequirementRoutes = require("./routes/documentRequirements");
const refereeListRoutes = require("./routes/refereeLists");
const financeRoutes = require("./routes/finance");

async function seedAdmin() {
  const data = await db.getAll();
  const hasAdmin = data.users.some((u) => u.role === "admin");
  if (!hasAdmin) {
    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
    data.users.push({
      id: uuidv4(),
      role: "admin",
      username: ADMIN_USERNAME,
      email: "admin@lwf-eloued.local",
      fullNameAr: "مدير المنصة",
      fullNameLatin: "Administrateur",
      password: hashed,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    await db.saveAll(data);
    console.log(`✔ تم إنشاء حساب الإدارة الافتراضي — اسم المستخدم: ${ADMIN_USERNAME}`);
  }
}

async function main() {
  console.log("⏳ جارِ الاتصال بقاعدة بيانات MongoDB Atlas...");
  try {
    await db.connect();
    console.log("✔ تم الاتصال بقاعدة البيانات بنجاح.");
  } catch (err) {
    console.error("✗ تعذّر الاتصال بقاعدة البيانات:");
    console.error("  " + err.message);
    console.error("\n  تأكد من وجود متغير البيئة MONGODB_URI وأنه يحتوي على رابط اتصال صحيح من MongoDB Atlas.");
    process.exit(1);
  }

  await seedAdmin();

  // Launches Chromium once at startup (not on the first PDF request) so a
  // broken PDF engine shows up immediately in the deploy/runtime logs —
  // exactly where you'd look right after a "تعذر إنشاء ملف PDF" report —
  // instead of only failing silently until someone clicks the PDF button.
  // Runs in the background; it does not block the server from starting.
  (async () => {
    console.log("⏳ جارِ التحقق من محرك توليد PDF (Chromium عبر Puppeteer)...");
    const { checkPdfEngine } = require("./pdfRenderer");
    const result = await checkPdfEngine();
    if (result.ok) {
      console.log("✔ محرك PDF يعمل بشكل سليم.");
    } else {
      console.error("✗ محرك PDF لا يعمل — تصدير PDF سيفشل حتى يُحل هذا:");
      console.error("  " + result.error);
      console.error("  " + result.hint);
      console.error("  (يمكن أيضًا التحقق لاحقًا عبر GET /api/finance/export/pdf/diagnostics بحساب مدير)");
    }
  })();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  // Plain express.static with no options sends conditional-cache headers
  // (ETag/Last-Modified) but no explicit Cache-Control, which several
  // mobile browsers (Samsung Internet in particular) treat as "cache this
  // for a while, don't even bother asking" rather than "revalidate every
  // time" — so after a redeploy, phones can keep serving the *previous*
  // version of styles.css/app.js/chat.js from disk cache with no visible
  // sign anything is stale. Forcing no-cache on exactly those three
  // extensions makes every load do a fast conditional GET (still a 304,
  // still cheap) instead of silently trusting a stale local copy; images/
  // fonts/etc. keep the default (harmless to cache, rarely change).
  app.use(express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if(/\.(html|css|js)$/i.test(filePath)){
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  }));

  app.use("/api/auth", authRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/requests", requestRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/announcements", announcementRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/document-requirements", documentRequirementRoutes);
  app.use("/api/admin/referee-lists", refereeListRoutes);
  app.use("/api/finance", financeRoutes);

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // The finance module is a separate mini-SPA (its own login-aware page,
  // not part of the 4000-line public/app.js referee-registration SPA) —
  // served at a clean URL rather than only reachable as /finance.html.
  // Must come before the "*" SPA fallback below.
  app.get("/finance", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "finance.html"));
  });

  // Multer / generic error handler
  app.use((err, req, res, next) => {
    if (err) {
      console.error(err);
      return res.status(400).json({ error: err.message || "حدث خطأ غير متوقع." });
    }
    next();
  });

  // SPA fallback
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // The chat module needs a real-time push channel — a WebSocket server
  // attached to the same HTTP server (same port, path /ws), authenticated
  // with the same JWT used for the REST API.
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    let userId = null;
    try {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.id;
    } catch (e) {
      ws.close();
      return;
    }
    // Heartbeat target — see the interval below. A connection that stops
    // answering pings (phone died, wifi cut instantly, power outage — none
    // of which send a proper close frame) gets terminated instead of
    // silently staying "online" forever.
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const { becameOnline } = realtime.register(userId, ws);
    if (becameOnline) presence.handleUserOnline(userId);
    // "مزامنة الوقت مع الخادم وليس مع ساعة الجهاز": the client anchors every
    // "منذ N دقائق"-style relative time against this, not against its own
    // (possibly wrong) clock — sent once per connection/reconnect.
    try { ws.send(JSON.stringify({ event: "server-time", payload: { now: nowIso() } })); } catch (e) {}

    const onGone = () => {
      const { becameOffline } = realtime.unregister(userId, ws);
      if (becameOffline) presence.handleUserOffline(userId);
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  });

  // Heartbeat sweep: ping every open socket, terminate any that didn't pong
  // since the last sweep. terminate() still fires "close" (see onGone above)
  // so a zombie connection flips to offline within one interval instead of
  // hanging until some unpredictable OS-level TCP timeout.
  const HEARTBEAT_MS = 25000;
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeatTimer));

  server.listen(PORT, () => {
    console.log(`🚀 منصة انخراط الحكام تعمل على المنفذ ${PORT}`);
    console.log(`   افتح المتصفح على: http://localhost:${PORT}`);
  });

  // ---- Keep-alive self-ping ----------------------------------------------
  // Render's free plan spins a web service down after ~15 minutes without
  // any incoming HTTP request, and the next real visitor then waits ~30-60s
  // for a cold start. Pinging our own public URL periodically counts as
  // incoming traffic and keeps resetting that idle timer, so the service
  // stays warm under normal use.
  //
  // Important limits of this approach (documented here, not hidden):
  //  - It only prevents the service from GOING idle — it cannot wake a
  //    dyno that has ALREADY spun down, because the very process running
  //    this setInterval would itself have been stopped by then. So this
  //    alone does not guarantee 24/7 uptime through, say, a multi-hour
  //    period with zero real traffic AND a missed ping.
  //  - It also runs on every deploy of this service, including any staging
  //    copy — RENDER_EXTERNAL_URL always points at the copy the code is
  //    actually running on, so each deploy only ever pings itself.
  // For genuine round-the-clock uptime, add an external free scheduler
  // (cron-job.org, UptimeRobot, or a scheduled GitHub Actions workflow)
  // hitting GET /api/health every 10-14 minutes — see README for the exact
  // steps. That external cron and this self-ping are complementary, not
  // alternatives: keep both, since an external cron with a missed run or a
  // rate-limited free tier is exactly when this internal ping covers the
  // gap, and vice versa.
  //
  // Activated automatically on Render (RENDER_EXTERNAL_URL is set for you
  // by the platform on every web service) — no configuration needed there.
  // Locally, or on any other host, it simply stays off unless you set
  // KEEP_ALIVE_URL yourself; nothing else about local dev changes.
  const KEEP_ALIVE_BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || null;
  if (KEEP_ALIVE_BASE_URL) {
    const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — comfortably under Render's ~15-minute idle timeout
    let pingUrl;
    try {
      pingUrl = new URL("/api/health", KEEP_ALIVE_BASE_URL).toString();
    } catch (e) {
      console.error(`✗ رابط KEEP_ALIVE_URL/RENDER_EXTERNAL_URL غير صالح: ${KEEP_ALIVE_BASE_URL}`);
      pingUrl = null;
    }
    if (pingUrl) {
      const selfPing = () => {
        fetch(pingUrl)
          .then((r) => { if (!r.ok) console.warn(`⚠️ نبضة التنشيط الذاتية رجعت بحالة ${r.status}`); })
          .catch((err) => console.warn(`⚠️ فشلت نبضة التنشيط الذاتية (سيُعاد المحاولة بعد ${KEEP_ALIVE_INTERVAL_MS / 60000} دقيقة): ${err.message}`));
      };
      setInterval(selfPing, KEEP_ALIVE_INTERVAL_MS);
      console.log(`⏰ نبضة التنشيط الذاتية مفعّلة كل ${KEEP_ALIVE_INTERVAL_MS / 60000} دقائق إلى: ${pingUrl}`);
    }
  } else {
    console.log("ℹ️ نبضة التنشيط الذاتية غير مفعّلة محليًا (طبيعي — ستُفعَّل تلقائيًا على Render، أو عيّن KEEP_ALIVE_URL يدويًا لتفعيلها هنا أيضًا).");
  }
}

main();

// Close the shared headless-Chromium instance used for PDF generation
// (pdfRenderer.js) on shutdown, so it doesn't linger as an orphaned
// process when the server restarts/redeploys.
const { closeBrowser } = require("./pdfRenderer");
["SIGTERM", "SIGINT"].forEach((sig) => {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
});
