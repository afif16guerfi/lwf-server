const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const db = require("./db");
const { PORT, ADMIN_USERNAME, ADMIN_PASSWORD } = require("./config");

const authRoutes = require("./routes/auth");
const applicationRoutes = require("./routes/applications");
const adminRoutes = require("./routes/admin");
const requestRoutes = require("./routes/requests");

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
  app.use(express.static(path.join(__dirname, "public")));

  app.use("/api/auth", authRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/requests", requestRoutes);

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

  app.listen(PORT, () => {
    console.log(`🚀 منصة انخراط الحكام تعمل على المنفذ ${PORT}`);
    console.log(`   افتح المتصفح على: http://localhost:${PORT}`);
  });
}

main();
