// schema.js — single source of truth for the application form fields and
// required documents. Shared conceptually between server validation and the
// frontend (the frontend keeps its own copy in sync, see public/app.js).

const SEASON = "2026/2027";

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

const DOC_TYPES = [
  { key: "photo", label: "الصورة الشمسية", icon: "🪪" },
  { key: "birthCert", label: "شهادة الميلاد", icon: "📄" },
  { key: "idCard", label: "نسخة من بطاقة التعريف", icon: "🆔" },
  { key: "qualification", label: "نسخة من المؤهل العلمي", icon: "🎓" },
  { key: "ccpDoc", label: "نسخة من صك بريدي (CCP)", icon: "💳" },
];

function allFieldKeys() {
  return FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
}

function blankData() {
  const data = {};
  allFieldKeys().forEach((k) => (data[k] = ""));
  return data;
}

module.exports = { SEASON, FIELD_GROUPS, DOC_TYPES, allFieldKeys, blankData };
