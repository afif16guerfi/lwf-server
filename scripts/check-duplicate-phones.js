// scripts/check-duplicate-phones.js
//
// فحص أرقام الهاتف المكررة في قاعدة البيانات قبل الاعتماد على منع التكرار.
// نفّذ هذا الأمر من داخل مجلد المشروع (على الجهاز/الاستضافة المتصلة بنفس
// قاعدة البيانات الفعلية عبر متغير البيئة MONGODB_URI):
//
//   node scripts/check-duplicate-phones.js
//
// هذا السكريبت للقراءة فقط — لا يعدّل أي بيانات ولا يحذف أي حساب. يطبع فقط
// أي رقم هاتف مستخدم في أكثر من حساب واحد، ليتسنى لك التعامل معه يدويًا
// (تصحيح الرقم الخاطئ في أحد الحسابين، أو التواصل مع الحكم المعني) قبل أن
// يمنع نظام التحقق الجديد أي رقم مكرر عند إنشاء حساب جديد.
//
// ملاحظة: منع التكرار نفسه (phoneTaken في routes/auth.js) يعمل بالفعل على
// مستوى التطبيق في كل مرة يُنشأ فيها حساب جديد — هذا السكريبت فقط للتأكد من
// عدم وجود تكرارات قديمة سابقة لهذا التعديل.

const db = require("../db");

async function main() {
  let data;
  try {
    data = await db.getAll();
  } catch (err) {
    console.error("✗ تعذّر الاتصال بقاعدة البيانات:");
    console.error("  " + err.message);
    process.exit(1);
  }

  const byPhone = new Map();
  data.users.forEach((u) => {
    const phone = String(u.phone || "").trim();
    if (!phone) return; // حسابات قديمة جدًا قد لا تملك رقم هاتف مسجَّل أصلًا
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(u);
  });

  const duplicates = Array.from(byPhone.entries()).filter(([, users]) => users.length > 1);

  console.log("");
  if (duplicates.length === 0) {
    console.log(`✔ لا يوجد أي رقم هاتف مكرر بين ${data.users.length} حساب. يمكن تفعيل منع التكرار بأمان.`);
  } else {
    console.log(`⚠ تم العثور على ${duplicates.length} رقم هاتف مستخدم في أكثر من حساب واحد:\n`);
    duplicates.forEach(([phone, users]) => {
      console.log(`  رقم الهاتف: ${phone}`);
      users.forEach((u) => {
        console.log(`    - ${u.username}  (${u.fullNameAr || u.fullNameLatin || "بلا اسم"})  —  id: ${u.id}`);
      });
      console.log("");
    });
    console.log("يرجى تصحيح هذه الحالات يدويًا (تعديل الرقم الخاطئ من لوحة الإدارة أو التواصل مع الحكم المعني) قبل الاعتماد الكامل على منع التكرار.");
  }
  console.log("");
  process.exit(0);
}

main();
