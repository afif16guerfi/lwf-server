// refereeListsCore.js — "قوائم الحكام": admin-defined, print-ready rosters
// of referees (e.g. "يوم تكويني 22/12/2026", "قائمة الحكام المشاركين في
// الدورة التكوينية", "قائمة الحكام المعنيين بالمباراة").
//
// A saved list is just a SELECTION + DISPLAY configuration (title, which
// referees, which columns, whether to show an الإمضاء column at all and
// whether that column is filled in automatically with each referee's
// saved e-signature (includeSignatures) or left blank for hand-signing
// after printing (the default), page orientation) — it is resolved against
// the CURRENT referee data every time it's opened/previewed/printed, so a
// saved list never goes stale if a referee's rank, phone, kit size, etc.
// changes afterwards. Only the configuration itself is stored in
// data.refereeLists (see db.js).

const { REF_RANKS, REF_ROLES } = require("./schema");

const SELECTION_MODES = ["all", "filter", "manual"];
const ORIENTATIONS = ["portrait", "landscape"];

// ---- Columns a list can optionally show next to each referee's name.
// `fullNameAr` itself is always shown — it's rendered as a fixed column
// right after the row number, not offered as a toggle here. ----
const COLUMN_DEFS = [
  { key: "refRole", label: "صفة التحكيم" },
  { key: "refLevel", label: "الرتبة الحالية" },
  { key: "clothingSize", label: "مقاس اللباس" },
  { key: "shoeSize", label: "مقاس الحذاء" },
  { key: "phone1", label: "رقم الهاتف" },
  { key: "email", label: "البريد الإلكتروني" },
  { key: "refStartDate", label: "موسم الدخول إلى التحكيم" },
  { key: "job", label: "الوظيفة" },
  { key: "address", label: "العنوان الشخصي" },
  { key: "ccp", label: "الحساب البريدي (CCP)" },
];
const COLUMN_KEYS = COLUMN_DEFS.map((c) => c.key);

function sanitizeColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.filter((k) => COLUMN_KEYS.includes(k));
}
function sanitizeStringArray(arr, allowed) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => allowed.includes(v));
}
function sanitizeIdArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === "string" && v);
}

// ---- The pool a list draws from: every referee whose enrollment file is
// "approved" (a real, certified referee with an issued وثيقة انخراط, and
// therefore an actual rank/role/kit-size worth printing on a roster). ----
function eligiblePool(data) {
  return (data.applications || []).filter((a) => a.status === "approved");
}

// `signatureUrl` is looked up from the referee's own account (the same
// stored e-signature used on the وثيقة الانخراط — see routes/auth.js POST
// /signature) — never generated or guessed here, only ever the URL that's
// actually on file for that user, or null if they have none.
function refereeRow(app, usersById) {
  const d = app.data || {};
  const owner = usersById ? usersById.get(app.userId) : null;
  return {
    userId: app.userId,
    fullNameAr: d.fullNameAr || "",
    refRole: d.refRole || "",
    refLevel: d.refLevel || "",
    clothingSize: d.clothingSize || "",
    shoeSize: d.shoeSize || "",
    phone1: d.phone1 || "",
    email: d.email || "",
    refStartDate: d.refStartDate || "",
    job: d.job || "",
    address: d.address || "",
    ccp: d.ccp || "",
    signatureUrl: (owner && owner.signature && owner.signature.url) || null,
  };
}

// Every eligible referee, in the fixed shape used both for the manual-pick
// checklist and for resolving a saved list's roster — sorted alphabetically
// (Arabic collation) so the picker and the printed roster are predictable.
function allEligibleReferees(data) {
  const usersById = new Map((data.users || []).map((u) => [u.id, u]));
  return eligiblePool(data)
    .map((app) => refereeRow(app, usersById))
    .sort((a, b) => a.fullNameAr.localeCompare(b.fullNameAr, "ar"));
}

// ---- Resolve which referees a list config actually includes, right now ----
function resolveReferees(data, config) {
  const pool = allEligibleReferees(data);
  if (config.selectionMode === "manual") {
    const idSet = new Set(config.manualIds || []);
    return pool.filter((r) => idSet.has(r.userId));
  }
  if (config.selectionMode === "filter") {
    const roles = config.filterRefRole || [];
    const levels = config.filterRefLevel || [];
    return pool.filter((r) => {
      const roleOk = roles.length === 0 || roles.includes(r.refRole);
      const levelOk = levels.length === 0 || levels.includes(r.refLevel);
      return roleOk && levelOk;
    });
  }
  return pool; // "all"
}

function sanitizeConfig(body) {
  body = body || {};
  return {
    title: String(body.title || "").trim(),
    selectionMode: SELECTION_MODES.includes(body.selectionMode) ? body.selectionMode : "all",
    filterRefRole: sanitizeStringArray(body.filterRefRole, REF_ROLES),
    filterRefLevel: sanitizeStringArray(body.filterRefLevel, REF_RANKS),
    manualIds: sanitizeIdArray(body.manualIds),
    columns: sanitizeColumns(body.columns),
    showSignatureColumn: !!body.showSignatureColumn,
    // Optional, off by default (see refereeListsCore.js module note below):
    // when true AND showSignatureColumn is true, the signature column is
    // filled with each referee's saved e-signature instead of staying
    // blank for hand-signing. Meaningless without showSignatureColumn, so
    // it's sanitized down to false whenever that column is off, keeping
    // the two flags always consistent no matter what a client sends.
    includeSignatures: !!body.showSignatureColumn && !!body.includeSignatures,
    orientation: ORIENTATIONS.includes(body.orientation) ? body.orientation : "portrait",
  };
}

function validateConfig(config, data) {
  if (!config.title) return "يرجى كتابة عنوان القائمة.";
  if (config.selectionMode === "manual" && config.manualIds.length === 0) {
    return "يرجى اختيار حكم واحد على الأقل للقائمة.";
  }
  if (resolveReferees(data, config).length === 0) {
    return "لا يوجد أي حكم يطابق الاختيار الحالي — عدّل الفلترة أو الاختيار اليدوي.";
  }
  return null;
}

module.exports = {
  COLUMN_DEFS, COLUMN_KEYS, SELECTION_MODES, ORIENTATIONS,
  allEligibleReferees, resolveReferees, sanitizeConfig, validateConfig,
};
