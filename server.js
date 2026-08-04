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
const settingsRoutes = require("./routes/settings");
const documentRequirementRoutes = require("./routes/documentRequirements");

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
      fullName: "مدير المنصة",
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
  app.use("/api/settings", settingsRoutes);
  app.use("/api/document-requirements", documentRequirementRoutes);

  app.get("/api/health", (req, res) => res.json({ ok: true }));

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
}

main();
