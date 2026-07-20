const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { JWT_SECRET } = require("../config");
const { requireAuth } = require("../middleware/auth");
const { blankData, SEASON } = require("../schema");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

function publicUser(u) {
  return { id: u.id, role: u.role, username: u.username, email: u.email, fullName: u.fullName };
}

router.post("/signup", async (req, res) => {
  try {
    const { fullName, username, email, password } = req.body;
    if (!fullName || !username || !email || !password) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة." });
    }
    if (String(password).length < 4) {
      return res.status(400).json({ error: "كلمة المرور قصيرة جدًا." });
    }
    const data = await db.getAll();
    if (data.users.some((u) => u.username === username)) {
      return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل." });
    }
    if (data.users.some((u) => u.email === email)) {
      return res.status(409).json({ error: "البريد الإلكتروني مستخدم بالفعل." });
    }
    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      role: "referee",
      username,
      email,
      fullName,
      password: hashed,
      createdAt: new Date().toISOString(),
    };
    data.users.push(newUser);

    const app = {
      id: uuidv4(),
      userId: newUser.id,
      status: "draft",
      season: SEASON,
      data: { ...blankData(), fullName, email },
      documents: {},
      declaration: false,
      flags: {},
      docFlags: {},
      rejectionSummary: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paidAt: null,
      submittedAt: null,
      reviewedAt: null,
      approvedAt: null,
      history: [{ at: new Date().toISOString(), event: "تم إنشاء الحساب وملف الانخراط" }],
    };
    data.applications.push(app);

    await db.saveAll(data);
    const token = signToken(newUser);
    res.json({ token, user: publicUser(newUser) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "أدخل اسم المستخدم وكلمة المرور." });
    const data = await db.getAll();
    const user = data.users.find((u) => u.username === username || u.email === username);
    if (!user) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
  res.json({ user: publicUser(user) });
});

// ---- Self-service password change (works for both referee and admin accounts) ----
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "أدخل كلمة السر الحالية والجديدة." });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: "كلمة السر الجديدة قصيرة جدًا." });
    }
    const data = await db.getAll();
    const user = data.users.find((u) => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: "كلمة السر الحالية غير صحيحة." });
    user.password = await bcrypt.hash(newPassword, 10);
    await db.saveAll(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "حدث خطأ في الخادوم." });
  }
});

module.exports = router;
