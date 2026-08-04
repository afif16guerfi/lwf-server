const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");
const db = require("../db");
const { ACCOUNT_STATUS, getAccountStatus } = require("../schema");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "يلزم تسجيل الدخول." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, role, username }
    next();
  } catch (e) {
    return res.status(401).json({ error: "الجلسة منتهية، يرجى تسجيل الدخول من جديد." });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "غير مصرح لك بالوصول لهذا المورد." });
    }
    next();
  };
}

// Blocks referees whose account hasn't been activated by the admin yet.
// Admins (and, by extension, any route this isn't attached to — most
// importantly the admin-DM chat endpoints) are never affected. Looks the
// user up fresh from the DB rather than trusting the JWT, since accountStatus
// can change (admin activates the account) without the referee logging out.
async function requireActiveAccount(req, res, next) {
  if (!req.user || req.user.role !== "referee") return next();
  const data = await db.getAll();
  const user = data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: "المستخدم غير موجود." });
  if (getAccountStatus(user) === ACCOUNT_STATUS.PENDING) {
    return res.status(403).json({
      error: "حسابك قيد المراجعة والتفعيل من طرف الإدارة لاستكمال التسجيل ورفع الملفات.",
      accountStatus: "pending",
    });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireActiveAccount };
