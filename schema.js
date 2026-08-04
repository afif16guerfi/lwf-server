// schema.js — single source of truth for the application form fields and
// required documents. Shared conceptually between server validation and the
// frontend (the frontend keeps its own copy in sync, see public/app.js).

const SEASON = "2026/2027";

// ---- Referee account activation (separate from the application/file
// approval pipeline below). New signups start "pending": the admin must
// activate the account before the referee can do anything beyond messaging
// the admin directly. Existing accounts created before this field existed
// have no accountStatus at all — getAccountStatus() treats that as "active"
// so nobody already using the platform gets locked out retroactively. ----
const ACCOUNT_STATUS = { PENDING: "pending", ACTIVE: "active" };
function getAccountStatus(user) {
  return user && user.accountStatus === ACCOUNT_STATUS.PENDING ? ACCOUNT_STATUS.PENDING : ACCOUNT_STATUS.ACTIVE;
}

const FIELD_GROUPS = [
  {
    key: "personal",
    title: "المعلومات الشخصية",
    fields: [
      { key: "fullName", label: "اللقب والاسم", type: "text", required: true },
      { key: "birthDate", label: "تاريخ الازدياد", type: "date", required: true },
      { key: "birthPlace", label: "مكان الازدياد", type: "text", required: true },
      { key: "maritalStatus", label: "الحالة العائلية", type: "select", required: true, options: ["أعزب", "متزوج(ة)", "مطلق(ة)", "أرمل(ة)"] },
      { key: "educationLevel", label: "المستوى التعليمي", type: "text", required: true },
      { key: "address", label: "العنوان الشخصي", type: "textarea", required: true, full: true },
    ],
  },
  {
    key: "contact",
    title: "معلومات الاتصال",
    fields: [
      { key: "phone1", label: "رقم الهاتف", type: "tel", required: true },
      { key: "phone2", label: "الرقم الثاني (اختياري)", type: "tel", required: false },
      { key: "email", label: "البريد الإلكتروني", type: "email", required: true },
      { key: "job", label: "الوظيفة", type: "text", required: true },
      { key: "emergencyName", label: "اسم الشخص المتصل به في حالة الطوارئ", type: "text", required: true },
      { key: "emergencyPhone", label: "رقم هاتف شخص الطوارئ", type: "tel", required: true },
      { key: "ccp", label: "رقم الحساب الجاري البريدي (CCP)", type: "text", required: true, full: true },
    ],
  },
  {
    key: "refereeing",
    title: "معلومات التحكيم",
    fields: [
      { key: "clubMember", label: "هل تنتمي إلى نادٍ؟", type: "radio", required: true, options: ["نعم", "لا"] },
      { key: "clubName", label: "اسم النادي (إن وجد)", type: "text", required: false },
      { key: "avoidClubs", label: "النوادي التي قد تتجنبها", type: "text", required: false, full: true },
      { key: "refStartDate", label: "تاريخ الدخول في التحكيم", type: "date", required: true },
      { key: "refLevel", label: "الترقية (المستوى الحالي)", type: "text", required: true },
      { key: "availableWeekly", label: "هل أنت متاح خلال الأسبوع؟", type: "radio", required: true, options: ["نعم", "لا"] },
      { key: "shoeSize", label: "مقاس الحذاء", type: "text", required: true },
      { key: "clothingSize", label: "مقاس اللباس", type: "text", required: true },
    ],
  },
];

function allFieldKeys() {
  return FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
}

function blankData() {
  const data = {};
  allFieldKeys().forEach((k) => (data[k] = ""));
  return data;
}

module.exports = { SEASON, FIELD_GROUPS, allFieldKeys, blankData, ACCOUNT_STATUS, getAccountStatus };
