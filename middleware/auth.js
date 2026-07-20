const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");

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

module.exports = { requireAuth, requireRole };
