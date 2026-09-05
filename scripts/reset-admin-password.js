// scripts/reset-admin-password.js
//
// استرجاع كلمة سر حساب الإدارة عند نسيانها.
// نفّذ هذا الأمر من داخل مجلد المشروع:
//
//   npm run reset-admin
//
// سيُنشئ كلمة سر عشوائية جديدة لكل حساب إدارة ويطبعها في الطرفية.
// يمكنك أيضًا تحديد كلمة سر مخصّصة بنفسك:
//
//   npm run reset-admin -- "كلمة-سري-الجديدة"
//
// هذا الإجراء يتطلب وصولاً مباشرًا لملفات الخادوم (أي جهازك أو الاستضافة)،
// وهو أبسط وأأمن طريقة استرجاع لأنه لا يعتمد على بريد إلكتروني.

const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db");

const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generateRandomPassword(length = 8) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARS[crypto.randomInt(0, PASSWORD_CHARS.length)];
  }
  return out;
}

async function main() {
  const customPassword = process.argv[2];
  if (customPassword && customPassword.length < 4) {
    console.error("✗ كلمة السر قصيرة جدًا (4 أحرف على الأقل).");
    process.exit(1);
  }

  let data;
  try {
    data = await db.getAll();
  } catch (err) {
    console.error("✗ تعذّر الاتصال بقاعدة البيانات:");
    console.error("  " + err.message);
    process.exit(1);
  }

  const admins = data.users.filter((u) => u.role === "admin");

  if (admins.length === 0) {
    console.error("✗ لا يوجد أي حساب إدارة في قاعدة البيانات. شغّل الخادوم مرة واحدة (npm start) ليُنشأ الحساب الافتراضي أولاً.");
    process.exit(1);
  }

  console.log("");
  for (const admin of admins) {
    const newPassword = customPassword || generateRandomPassword(8);
    admin.password = await bcrypt.hash(newPassword, 10);
    console.log("✔ تم إعادة تعيين كلمة سر حساب الإدارة:");
    console.log(`   اسم المستخدم : ${admin.username}`);
    console.log(`   كلمة السر الجديدة : ${newPassword}`);
    console.log("");
  }
  await db.saveAll(data);
  console.log("احتفظ بكلمة السر هذه في مكان آمن. يمكنك تسجيل الدخول بها الآن، ثم تغييرها لاحقًا من داخل لوحة الإدارة إن أردت.");
  process.exit(0);
}

main();
