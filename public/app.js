/* =========================================================
   LWF EL OUED — Referee Registration Platform (client)
   Talks to the Node/Express API — no data stored in the browser
   except the login token, so the same account works from any device.
   ========================================================= */

const SEASON = "2026/2027";
const SESSION_KEY = "lwf_session"; // { token, user }

// ---- Name script validation (kept in sync with schema.js on the server —
// see the comment there for why the name is captured twice, once per
// script). Character classes only (no anchors), so the same string can
// build both an HTML `pattern` attribute and a JS RegExp. ----
const ARABIC_NAME_CLASS = "\u0600-\u06FF\\s";
const LATIN_NAME_CLASS = "A-Za-zÀ-ÖØ-öø-ÿŒœ'\\-\\s";
const USERNAME_CLASS = "A-Za-z0-9";
const PHONE_CLASS = "0-9";
const SCRIPT_CLASSES = { ar: ARABIC_NAME_CLASS, latin: LATIN_NAME_CLASS, username: USERNAME_CLASS, phone: PHONE_CLASS, digits: PHONE_CLASS };

// ---- CCP / shoe size / clothing size (kept in sync with schema.js on the
// server — see the comment there). Digits-only fields (phone-family, shoe
// size) reuse the "phone" data-script filter above; CCP and clothing size
// need their own live-input handling (fixed prefix, uppercasing) wired
// further down via data-format. ----
const CCP_PREFIX = "00799999";
const CCP_TOTAL_LENGTH = 20;
const CLOTHING_SIZE_REGEX = /^(XS|S|M|L|XXXL|XXL|XL|[2-4]XL)$/i;
const SEASON_REGEX = /^(\d{4})\/(\d{4})$/;
// ---- Referee rank / capacity lists (kept in sync with schema.js) ----
const REF_RANKS = ["حكم جديد", "حكم متربص", "حكم ولائي", "حكم جهوي", "حكم مابين الرابطات", "حكم فدرالي", "حكم دولي"];
const REF_ROLES = ["حكم رئيسي", "حكم مساعد"];
function sanitizeSeasonValue(raw){
  let digits = String(raw||"").replace(/[^\d]/g,"").slice(0,8);
  if(digits.length <= 4) return digits;
  return `${digits.slice(0,4)}/${digits.slice(4)}`;
}
function isValidSeason(value){
  const m = SEASON_REGEX.exec(String(value||"").trim());
  if(!m) return false;
  return parseInt(m[2],10) === parseInt(m[1],10) + 1;
}
function sanitizeCcpValue(raw){
  let digits = String(raw||"").replace(/\D/g,"").slice(0, CCP_TOTAL_LENGTH);
  if(!digits.startsWith(CCP_PREFIX)){
    const extra = Math.max(0, digits.length - CCP_PREFIX.length);
    const suffix = extra > 0 ? digits.slice(digits.length - extra) : "";
    digits = (CCP_PREFIX + suffix).slice(0, CCP_TOTAL_LENGTH);
  }
  return digits;
}
function sanitizeClothingSizeValue(raw){
  return String(raw||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase().slice(0,4);
}
function isValidForScript(script, value){
  const cls = SCRIPT_CLASSES[script];
  if(!cls) return true;
  const v = String(value||"").trim();
  if(!v) return false;
  return new RegExp(`^[${cls}]+$`).test(v);
}
// Strips, live as the person types, any character that doesn't belong to
// the field's script — this is what makes it actually impossible to type
// e.g. Latin letters into the Arabic name field, not just a rejected-on-
// submit validation message.
function filterToScript(script, value){
  const cls = SCRIPT_CLASSES[script];
  if(!cls) return value;
  return String(value||"").replace(new RegExp(`[^${cls}]`, "g"), "");
}

/* =========================================================
   UNIFIED FIELD VALIDATION ENGINE
   ---------------------------------------------------------
   One central, reusable system that gives every validated input in the
   project (signup, login, change-password, admin login, and the whole
   application wizard) the same visual behaviour:
     - untouched field            -> no icon, no message
     - touched + valid            -> green ✓ badge
     - touched + invalid          -> red ✕ badge + explanation below
   "Touched" means the field lost focus once, or the surrounding form's
   next/submit button was pressed — never while the person is still mid-
   keystroke on a field they haven't finished with yet (see FIELD_TOUCHED
   below). Once a field HAS been marked touched, further typing re-checks
   live so a correction flips red -> green immediately.

   A field's rules are described by a small metadata object (the same
   shape as an entry in FIELD_GROUPS[].fields):
     { required, script, format, type, notFuture, minlength, matchField,
       matchLabel, custom, label, message }
   computeFieldValidity() is the single place that knows how to check
   each of those — every form below just supplies the metadata and lets
   the engine do the rest, instead of hand-rolling validation per input.
   ========================================================= */
// Kept in sync with schema.js on the server — local part/domain restricted
// to Latin letters, digits, and standard email separators, so Arabic (or
// any non-Latin script) anywhere in the address is rejected.
const EMAIL_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function computeFieldValidity(meta, rawValue, formEl){
  const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  const isEmpty = value === "" || value === undefined || value === null || value === false;
  if(isEmpty){
    if(meta.required) return { status:"bad", message: meta.requiredMessage || "هذا الحقل مطلوب." };
    return { status:null, message:"" }; // optional & empty — not an error, no icon
  }
  if(meta.script){
    if(!isValidForScript(meta.script, value)){
      return { status:"bad", message: meta.script==="ar" ? "الرجاء الكتابة بأحرف عربية فقط." : "الرجاء الكتابة بأحرف لاتينية (فرنسية/إنجليزية) فقط." };
    }
    return { status:"ok", message:"" };
  }
  if(meta.custom === "username"){
    if(!isValidForScript("username", value)) return { status:"bad", message:"أحرف لاتينية وأرقام فقط، بلا مسافات أو رموز." };
    return { status:"ok", message:"" };
  }
  if(meta.format === "phone"){
    if(!/^(05|06|07)[0-9]{8}$/.test(value)) return { status:"bad", message:"يجب أن يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام." };
    return { status:"ok", message:"" };
  }
  if(meta.format === "ccp"){
    const re = new RegExp(`^${CCP_PREFIX}\\d{${CCP_TOTAL_LENGTH-CCP_PREFIX.length}}$`);
    if(!re.test(value)) return { status:"bad", message:`يجب أن يبدأ بـ ${CCP_PREFIX} ويتكون من ${CCP_TOTAL_LENGTH} رقمًا إجمالًا.` };
    return { status:"ok", message:"" };
  }
  if(meta.format === "shoeSize"){
    if(!/^\d{1,2}$/.test(value)) return { status:"bad", message:"أرقام فقط، بحد أقصى رقمين." };
    return { status:"ok", message:"" };
  }
  if(meta.format === "clothingSize"){
    if(!CLOTHING_SIZE_REGEX.test(value)) return { status:"bad", message:"مقاسات مقبولة: S, M, L, XL, XXL, XXXL, 2XL, 3XL, 4XL." };
    return { status:"ok", message:"" };
  }
  if(meta.format === "season"){
    if(!SEASON_REGEX.test(value)) return { status:"bad", message:"الصيغة المطلوبة: xxxx/xxxx (مثال: 2014/2015)." };
    if(!isValidSeason(value)) return { status:"bad", message:"يجب أن تكون السنة الثانية = السنة الأولى + 1 (مثال: 2014/2015)." };
    return { status:"ok", message:"" };
  }
  if(meta.type === "email"){
    if(!EMAIL_REGEX.test(value)) return { status:"bad", message:"البريد الإلكتروني غير صحيح. يجب أن يتكوّن من أحرف لاتينية (وأرقام عند الحاجة) فقط، بلا أحرف عربية (مثال: exemple@gmail.com)." };
    return { status:"ok", message:"" };
  }
  if(meta.type === "date"){
    const d = new Date(value);
    if(Number.isNaN(d.getTime())) return { status:"bad", message:"تاريخ غير صحيح." };
    if(meta.notFuture && d.getTime() > Date.now()) return { status:"bad", message:"لا يمكن أن يكون التاريخ في المستقبل." };
    return { status:"ok", message:"" };
  }
  if(meta.matchField){
    const otherEl = formEl ? formEl.elements[meta.matchField] : null;
    const otherVal = otherEl ? otherEl.value : undefined;
    if(value !== otherVal) return { status:"bad", message: `يجب أن تطابق ${meta.matchLabel||"القيمة الأخرى"}.` };
    return { status:"ok", message:"" };
  }
  if((meta.type === "select" || meta.type === "radio") && Array.isArray(meta.options) && !meta.options.includes(value)){
    return { status:"bad", message:"يرجى اختيار قيمة من القائمة." };
  }
  if(meta.minlength && String(value).length < meta.minlength){
    return { status:"bad", message:`يجب ألا يقل الطول عن ${meta.minlength} أحرف.` };
  }
  // plain text/select/radio/number with no extra format rule: valid once non-empty (required already handled above)
  return { status:"ok", message:"" };
}

// ---- DOM wiring: inject the ✓/✕ badge + reuse (or create) the message
// element below the field, without having to touch every template string
// that renders an <input> across the project. ----
function ensureFieldControlWrap(input){
  if(input.type === "radio" || input.type === "checkbox" || input.tagName === "SELECT") return null; // border+message only, see CSS
  const passWrap = input.closest(".password-field-wrap");
  if(passWrap){
    if(!passWrap.querySelector(".field-status-icon")){
      const icon = document.createElement("span");
      icon.className = "field-status-icon"; icon.setAttribute("aria-hidden","true");
      passWrap.appendChild(icon);
    }
    return passWrap;
  }
  if(input.closest(".field-control")) return input.closest(".field-control");
  const wrap = document.createElement("div");
  wrap.className = "field-control";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const icon = document.createElement("span");
  icon.className = "field-status-icon"; icon.setAttribute("aria-hidden","true");
  wrap.appendChild(icon);
  return wrap;
}
function ensureFieldMessageEl(input){
  const fieldDiv = input.closest(".field");
  if(!fieldDiv) return null;
  // Reuse an existing .field-hint (e.g. signup's async uniqueness hints)
  // instead of creating a second message area for the same field.
  let el = fieldDiv.querySelector(".field-hint");
  if(!el){
    el = document.createElement("div");
    el.className = "field-hint";
    fieldDiv.appendChild(el);
  }
  return el;
}
function setFieldStatus(input, status, message){
  const wrap = ensureFieldControlWrap(input);
  if(wrap){
    const icon = wrap.querySelector(".field-status-icon");
    if(icon){
      icon.classList.remove("ok","bad");
      if(status === "ok"){ icon.classList.add("ok"); icon.textContent = "\u2713"; }
      else if(status === "bad"){ icon.classList.add("bad"); icon.textContent = "\u2715"; }
      else icon.textContent = "";
    }
  }
  const msgEl = ensureFieldMessageEl(input);
  if(msgEl){
    if(status === "bad" && message){ msgEl.textContent = message; msgEl.className = "field-hint bad"; }
    else { msgEl.textContent = ""; msgEl.className = "field-hint"; }
  }
  const fieldDiv = input.closest(".field");
  if(fieldDiv){
    fieldDiv.classList.toggle("field-valid", status === "ok");
    fieldDiv.classList.toggle("field-invalid", status === "bad");
  }
}
// Runs the check and paints the result. `force` bypasses the touched-gate
// (used by wiz-next / form submit, which must validate everything at once
// regardless of what's been blurred yet).
function runFieldValidation(input, meta, formEl, force){
  if(!meta) return true;
  const touched = force || input.dataset.vtouched === "1";
  if(!touched) return true; // don't show anything until touched — see engine header comment
  let value;
  if(input.type === "checkbox") value = input.checked ? "1" : "";
  else if(input.type === "radio"){
    const checked = formEl ? formEl.querySelector(`input[name="${input.name}"]:checked`) : null;
    value = checked ? checked.value : "";
  } else value = input.value;
  const { status, message } = computeFieldValidity(meta, value, formEl);
  if(input.type === "radio"){
    // paint every radio in the group's shared container, not just the one that fired the event
    const group = formEl ? formEl.querySelectorAll(`input[name="${input.name}"]`) : [input];
    group.forEach(r=>{
      const row = r.closest(".field");
      if(row){ row.classList.toggle("field-valid", status==="ok"); row.classList.toggle("field-invalid", status==="bad"); }
    });
    const msgEl = ensureFieldMessageEl(input);
    if(msgEl){
      if(status === "bad" && message){ msgEl.textContent = message; msgEl.className = "field-hint bad"; }
      else { msgEl.textContent = ""; msgEl.className = "field-hint"; }
    }
  } else {
    setFieldStatus(input, status, message);
  }
  return status !== "bad";
}
function wireValidatedField(input, meta, formEl){
  if(input.dataset.vwired === "1") return;
  input.dataset.vwired = "1";
  const evt = (input.tagName === "SELECT" || input.type === "radio" || input.type === "checkbox") ? "change" : "blur";
  input.addEventListener(evt, ()=>{ input.dataset.vtouched = "1"; runFieldValidation(input, meta, formEl); }, evt === "blur" ? true : false);
  if(evt === "blur"){
    input.addEventListener("input", ()=>{ if(input.dataset.vtouched === "1") runFieldValidation(input, meta, formEl); });
  }
}
// Wires every field in `metaByName` ({name: meta}) found inside `formEl`,
// and returns a function that fully (re-)validates the whole form on
// demand — used by wiz-next / submit handlers to gate navigation and
// focus the first invalid field.
function wireFormValidation(formEl, metaByName){
  if(!formEl) return ()=>true;
  Object.entries(metaByName).forEach(([name, meta])=>{
    const els = formEl.querySelectorAll(`[name="${name}"]`);
    els.forEach(el=> wireValidatedField(el, meta, formEl));
  });
  return function validateAll(){
    let firstInvalid = null;
    let allValid = true;
    Object.entries(metaByName).forEach(([name, meta])=>{
      const els = Array.from(formEl.querySelectorAll(`[name="${name}"]`));
      if(!els.length) return;
      const primary = els[0];
      primary.dataset.vtouched = "1";
      const ok = runFieldValidation(primary, meta, formEl, true);
      if(!ok && !firstInvalid) firstInvalid = primary;
      if(!ok) allValid = false;
    });
    if(firstInvalid){
      try{ firstInvalid.focus({preventScroll:false}); }catch(e){ firstInvalid.focus(); }
      firstInvalid.scrollIntoView({behavior:"smooth", block:"center"});
    }
    return allValid;
  };
}

const FIELD_GROUPS = [
  {
    key: "personal", title: "المعلومات الشخصية",
    fields: [
      { key: "fullNameAr", label: "الاسم واللقب (بالعربية)", type: "text", required: true, script: "ar" },
      { key: "fullNameLatin", label: "الاسم واللقب (باللاتينية)", type: "text", required: true, script: "latin" },
      { key: "birthDate", label: "تاريخ الازدياد", type: "date", required: true, notFuture: true },
      { key: "birthPlace", label: "مكان الازدياد", type: "text", required: true },
      { key: "maritalStatus", label: "الحالة العائلية", type: "select", required: true, options: ["أعزب","متزوج(ة)","مطلق(ة)","أرمل(ة)"] },
      { key: "educationLevel", label: "المستوى التعليمي", type: "text", required: true },
      { key: "address", label: "العنوان الشخصي", type: "textarea", required: true, full: true },
    ]
  },
  {
    key: "contact", title: "معلومات الاتصال",
    fields: [
      { key: "phone1", label: "رقم الهاتف", type: "tel", required: true, format: "phone" },
      { key: "phone2", label: "الرقم الثاني (اختياري)", type: "tel", required: false, format: "phone" },
      { key: "email", label: "البريد الإلكتروني", type: "email", required: true },
      { key: "job", label: "الوظيفة", type: "text", required: true },
      { key: "emergencyName", label: "اسم الشخص المتصل به في حالة الطوارئ", type: "text", required: true },
      { key: "emergencyPhone", label: "رقم هاتف شخص الطوارئ", type: "tel", required: true, format: "phone" },
      { key: "ccp", label: "رقم الحساب الجاري البريدي (CCP)", type: "text", required: true, full: true, format: "ccp" },
    ]
  },
  {
    key: "refereeing", title: "معلومات التحكيم",
    fields: [
      { key: "clubMember", label: "هل تنتمي إلى نادٍ؟", type: "radio", required: true, options: ["نعم","لا"] },
      { key: "clubName", label: "اسم النادي (إن وجد)", type: "text", required: false },
      { key: "avoidClubs", label: "النوادي التي قد تتجنبها", type: "text", required: false, full: true },
      { key: "refStartDate", label: "موسم الدخول إلى التحكيم", type: "text", required: true, format: "season", placeholder: "2014/2015" },
      { key: "refLevel", label: "الرتبة الحالية", type: "select", required: true, options: REF_RANKS },
      { key: "refRole", label: "صفة التحكيم", type: "radio", required: true, options: REF_ROLES },
      { key: "availableWeekly", label: "هل أنت متاح خلال الأسبوع؟", type: "radio", required: true, options: ["نعم","لا"] },
      { key: "shoeSize", label: "مقاس الحذاء", type: "text", required: true, format: "shoeSize" },
      { key: "clothingSize", label: "مقاس اللباس", type: "text", required: true, format: "clothingSize" },
    ]
  }
];
const DECLARATION_TEXT = "أنا الموقع أدناه، أشهد بصحة المعلومات المقدمة أعلاه في ممارسة وظيفتي، والاستجابة لأي تعيين (باستثناء حالات القوة القاهرة)، واحترام التوجيهات الفنية من المسؤولين، واحترام المبادئ والأخلاق التي تحددها لوائح كرة القدم للهواة ولوائح التحكيم والرابطة الوصية.";

/* ---------- Session ---------- */
function getSession(){ try{ return JSON.parse(localStorage.getItem(SESSION_KEY)); }catch(e){ return null; } }
function setSession(s){ localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession(){ localStorage.removeItem(SESSION_KEY); }

/* ---------- API helper ---------- */
async function api(path, { method="GET", body, isForm=false } = {}){
  const session = getSession();
  const headers = {};
  if(session && session.token) headers["Authorization"] = "Bearer " + session.token;
  let payload = body;
  if(body && !isForm){ headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch("/api" + path, { method, headers, body: payload });
  let data = null;
  try{ data = await res.json(); }catch(e){ data = null; }
  if(!res.ok){
    const err = new Error((data && data.error) || "حدث خطأ غير متوقع.");
    err.data = data; err.status = res.status;
    throw err;
  }
  return data;
}

function fmtDate(iso){ if(!iso) return "—"; const d=new Date(iso); return d.toLocaleDateString('ar-DZ',{year:'numeric',month:'2-digit',day:'2-digit'}); }
// Date + time together — used anywhere the exact moment matters (registration
// review timeline, account creation, disable/enable, audit log) rather than
// just the day, per the platform's "لا تعتمد على التاريخ فقط" requirement.
function fmtDateTime(iso){
  if(!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString('ar-DZ',{year:'numeric',month:'2-digit',day:'2-digit'});
  const time = d.toLocaleTimeString('ar-DZ',{hour:'2-digit',minute:'2-digit'});
  return `${date} - ${time}`;
}
function fmtBirthDate(ymd){
  if(!ymd) return "—";
  const parts = String(ymd).split("-");
  if(parts.length !== 3) return ymd;
  const [y,m,dd] = parts;
  return `${dd}/${m}/${y}`;
}
function escapeHtml(str){ if(str===undefined||str===null) return ""; return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function statusLabel(s){ return {draft:"مسودة",pending_payment:"بانتظار الدفع",pending_review:"قيد المراجعة",rejected:"مرفوض - يلزم التصحيح",approved:"مقبول"}[s] || s; }
function findFieldMeta(key){ for(const g of FIELD_GROUPS){ const f=g.fields.find(f=>f.key===key); if(f) return f; } return null; }

/* ---------- Admin list search/filter (client-side, no re-fetch) ---------- */
function applyAdminChangeLogFilter(){
  const table = document.getElementById("admin-changelog-table");
  if(!table) return;
  const query = (document.getElementById("admin-changelog-search")?.value || "").trim().toLowerCase();
  const rows = table.querySelectorAll("tbody tr");
  let visibleCount = 0;
  rows.forEach(row=>{
    const visible = !query || (row.getAttribute("data-search")||"").includes(query);
    row.style.display = visible ? "" : "none";
    if(visible) visibleCount++;
  });
  const emptyEl = document.getElementById("admin-changelog-empty");
  if(emptyEl) emptyEl.style.display = visibleCount === 0 ? "" : "none";
  table.style.display = visibleCount === 0 ? "none" : "";
}

/* ---------- Document lightbox (large preview popup for review) ---------- */
function escCloseDocLightbox(e){ if(e.key === "Escape") closeDocLightbox(); }
function closeDocLightbox(){
  const el = document.getElementById("doc-lightbox-overlay");
  if(el) el.remove();
  document.removeEventListener("keydown", escCloseDocLightbox);
}
function openDocLightbox(url, mimetype, title){
  closeDocLightbox();
  const overlay = document.createElement("div");
  overlay.id = "doc-lightbox-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,20,15,0.88);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;";
  overlay.addEventListener("click", (e)=>{ if(e.target===overlay) closeDocLightbox(); });

  const bar = document.createElement("div");
  bar.style.cssText = "width:100%;max-width:94vw;display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;";
  bar.innerHTML = `<span style="color:#fff;font-weight:700;font-size:15px;">${escapeHtml(title||"")}</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ إغلاق";
  closeBtn.className = "btn btn-outline btn-sm";
  closeBtn.style.cssText = "background:#fff;";
  closeBtn.addEventListener("click", closeDocLightbox);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);

  const box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:12px;max-width:94vw;max-height:82vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.4);";

  if(mimetype && mimetype.startsWith("image")){
    const img = document.createElement("img");
    img.src = url;
    img.style.cssText = "display:block;max-width:90vw;max-height:82vh;width:auto;height:auto;margin:0 auto;";
    box.appendChild(img);
  } else {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.style.cssText = "width:85vw;height:80vh;border:none;";
    box.appendChild(iframe);
  }
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", escCloseDocLightbox);
}

/* ---------- Router ---------- */
window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);

// Password show/hide toggle (👁️ / 🙈) — delegated on document so it works
// for every password field on every page, including ones swapped in via
// innerHTML without a full render() (e.g. switching the login/signup tab).
document.addEventListener("click", e=>{
  const btn = e.target.closest("[data-password-toggle]");
  if(!btn) return;
  const input = btn.parentElement.querySelector("input");
  if(!input) return;
  const nowVisible = input.type === "password";
  input.type = nowVisible ? "text" : "password";
  btn.innerHTML = nowVisible ? ICON_EYE_OFF : ICON_EYE;
  btn.setAttribute("aria-pressed", nowVisible ? "true" : "false");
  btn.setAttribute("aria-label", nowVisible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
  btn.title = nowVisible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور";
});
function go(hash){ location.hash = hash; }
function currentRoute(){ return (location.hash.replace(/^#\/?/, "")) || "home"; }

let CACHE = { myApp:null, adminList:null, adminReview:null, docRequirements:null };
async function ensureDocRequirements(){
  if(!CACHE.docRequirements){
    const { documentRequirements } = await api("/document-requirements");
    CACHE.docRequirements = documentRequirements;
  }
  return CACHE.docRequirements;
}
let REVIEW_DRAFT = null;
let WIZ_STEP = 0;
let ADMIN_EDIT_MODE = false;
let REG_STATUS = null; // cached response of GET /settings/registration, refreshed whenever pageHome/pageAdminSettings loads
let REG_COUNTDOWN_TIMER = null;
let SITE_STATUS = null; // cached response of GET /settings/site-status, re-fetched on every render()

async function render(){
  const root = document.getElementById("app");
  let session = getSession();
  const route = currentRoute();
  const seg = route.split("/")[0];

  if(REG_COUNTDOWN_TIMER){ clearInterval(REG_COUNTDOWN_TIMER); REG_COUNTDOWN_TIMER = null; }

  if(window.LWFChat) window.LWFChat.beforeRouteChange();

  // Whole-platform kill switch ("حالة الموقع") — re-checked on every single
  // route change, not just once at load, so a referee already inside the
  // app the moment the admin disables it gets stopped on their very next
  // navigation. Real enforcement lives server-side (see middleware/auth.js
  // and routes/auth.js) — this is what makes the block visible instead of
  // just a wall of failed-request errors. The admin account is always
  // exempt, and the admin-login page always stays reachable so the admin
  // can get back in to re-enable the platform.
  try{ SITE_STATUS = await api("/settings/site-status"); }
  catch(e){ SITE_STATUS = { enabled: true, message: "" }; }
  const isAdminSession = session && session.user.role === "admin";
  if(SITE_STATUS && SITE_STATUS.enabled === false && !isAdminSession && seg !== "admin-login"){
    root.innerHTML = pageSiteDisabled();
    window.scrollTo({top:0, behavior:"instant"});
    return;
  }

  // accountStatus can change server-side (admin activates the account)
  // without the referee logging out — refresh it here so the guards below
  // always see the current value instead of whatever was cached at login.
  if(session && session.user.role === "referee"){
    try{
      const { user } = await api("/auth/me");
      if(user.accountStatus !== session.user.accountStatus){
        session = { ...session, user: { ...session.user, accountStatus: user.accountStatus, reviewFields: user.reviewFields, reviewNote: user.reviewNote, rejectionReason: user.rejectionReason } };
        setSession(session);
      }
    }catch(e){
      if(e.status === 401){ if(window.LWFChat) window.LWFChat.disconnect(); clearSession(); go("home"); return; }
      // any other error (offline, etc.) — keep going with the cached session
    }
  }

  if(seg.startsWith("admin") && seg !== "admin-login"){
    if(!session || session.user.role !== "admin"){ go("admin-login"); return; }
  }
  if(["dashboard","form","certificate","profile","requests","announcements","announcement","registration-status"].includes(seg)){
    if(!session || session.user.role !== "referee"){ go("home"); return; }
  }
  // A referee whose account isn't active yet (still pending review, needs
  // edit, or rejected) only ever sees the dashboard (which renders the
  // right notice per state, see pageDashboard), the registration-status
  // screen (edit-and-resubmit / rejection reason), and the chat.
  const PENDING_LOCKED_SEGS = ["form","certificate","profile","requests","announcements","announcement"];
  if(session && session.user.role === "referee" && session.user.accountStatus !== "active" && PENDING_LOCKED_SEGS.includes(seg)){
    go("dashboard"); return;
  }
  if(seg === "account" || seg === "chat" || seg === "notifications"){
    if(!session){ go("home"); return; }
  }

  root.innerHTML = topbar(session) + `<div id="page-slot"><div class="page center-txt muted">جارِ التحميل...</div></div>` + footer();
  const slot = document.getElementById("page-slot");

  try{
    switch(seg){
      case "home": slot.innerHTML = await pageHome(session); break;
      case "admin-login": slot.innerHTML = pageAdminLogin(); break;
      case "dashboard": slot.innerHTML = await pageDashboard(session); break;
      case "form": slot.innerHTML = await pageForm(session); break;
      case "certificate": slot.innerHTML = await pageCertificate(session); break;
      case "profile": slot.innerHTML = await pageProfile(session); break;
      case "requests": slot.innerHTML = await pageRequests(session); break;
      case "announcements": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.listPage() : ""; break;
      case "announcement": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.detailPage(route.split("/")[1]) : ""; break;
      case "notifications": slot.innerHTML = window.LWFNotifications ? await window.LWFNotifications.listPage() : ""; break;
      case "admin": slot.innerHTML = await pageAdminList(); break;
      case "admin-users": slot.innerHTML = await pageAdminUsers(); break;
      case "registration-status": slot.innerHTML = await pageRegistrationStatus(session); break;
      case "admin-registration-review": slot.innerHTML = await pageAdminRegistrationReview(route.split("/")[1]); break;
      case "admin-review": slot.innerHTML = await pageAdminReview(route.split("/")[1]); break;
      case "admin-audit": slot.innerHTML = await pageAdminAudit(route.split("/")[1]); break;
      case "admin-requests": slot.innerHTML = await pageAdminRequests(); break;
      case "admin-announcements": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.adminListPage() : ""; break;
      case "admin-announcement-edit": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.adminEditPage(route.split("/")[1]) : ""; break;
      case "admin-announcement-stats": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.adminStatsPage(route.split("/")[1]) : ""; break;
      case "admin-settings": slot.innerHTML = await pageAdminSettings(); break;
      case "admin-doc-requirements": slot.innerHTML = await pageAdminDocRequirements(); break;
      case "admin-referee-lists": slot.innerHTML = await pageAdminRefereeLists(); break;
      case "admin-referee-list-editor": slot.innerHTML = await pageAdminRefereeListEditor(route.split("/")[1]); break;
      case "admin-changelog": slot.innerHTML = await pageAdminChangeLog(); break;
      case "account": slot.innerHTML = pageAccount(session); break;
      case "chat": slot.innerHTML = window.LWFChat ? window.LWFChat.shellHtml(session) : ""; break;
      default: slot.innerHTML = await pageHome(session);
    }
  }catch(e){
    if(e.status === 401){ if(window.LWFChat) window.LWFChat.disconnect(); clearSession(); go("home"); return; }
    slot.innerHTML = `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
  attachGlobalHandlers();
  if(session && window.LWFChat) window.LWFChat.ensureConnected(session);
  if(seg === "chat" && window.LWFChat) window.LWFChat.mount(session, route.split("/")[1]);
  if(session && window.LWFChat) window.LWFChat.refreshBadge();
  if(window.LWFAnnouncements) window.LWFAnnouncements.mount(seg, route.split("/")[1], session);
  if(session && window.LWFAnnouncements) window.LWFAnnouncements.refreshNav(session);
  if(window.LWFNotifications) window.LWFNotifications.mount(seg, route.split("/")[1], session);
  if(session && window.LWFNotifications) window.LWFNotifications.refreshNav(session);
  window.scrollTo({top:0, behavior:"instant"});
}

/* ---------- Chrome ---------- */
function chatNavLink(){
  return `<a href="#/chat" class="btn btn-outline btn-sm chat-nav-link">💬 الدردشة<span id="chat-unread-badge" class="chat-nav-badge" style="display:none;"></span></a>`;
}

const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
function themeToggleBtn(){
  const isDark = document.documentElement.classList.contains("dark-mode");
  return `<button type="button" class="theme-toggle-btn" id="theme-toggle-btn" title="${isDark ? 'التبديل إلى الوضع النهاري' : 'التبديل إلى الوضع الليلي'}" aria-label="تبديل الوضع الليلي">${isDark ? ICON_SUN : ICON_MOON}</button>`;
}
function notifNavLink(){
  return `<a href="#/notifications" class="btn btn-outline btn-sm chat-nav-link" title="الإشعارات">🔔<span id="notif-nav-badge" class="chat-nav-badge" style="display:none;"></span></a>`;
}
function topbar(session){
  let actions = "";
  if(session && session.user.role === "referee"){
    const notActive = session.user.accountStatus !== "active";
    actions = `
      <span class="pill status-ok">مرحبًا، ${escapeHtml(session.user.fullNameAr)}</span>
      <a href="#/dashboard" class="btn btn-outline btn-sm">لوحتي</a>
      ${notActive ? `<a href="#/registration-status" class="btn btn-outline btn-sm">📝 متابعة التسجيل</a>` : ""}
      <a href="#/announcements" id="announcements-nav-link" class="btn btn-outline btn-sm" style="display:none;">📢 الإعلانات<span id="announcements-unread-badge" class="chat-nav-badge" style="display:none;"></span></a>
      ${notifNavLink()}
      ${chatNavLink()}
      <a href="#/account" class="btn btn-ghost btn-sm" title="تغيير كلمة السر">⚙ حسابي</a>
      <button class="btn btn-ghost btn-sm" data-action="logout">تسجيل الخروج</button>`;
  } else if(session && session.user.role === "admin"){
    actions = `
      <span class="pill status-ok">لوحة الإدارة</span>
      <a href="#/admin" class="btn btn-outline btn-sm">طلبات الانخراط</a>
      <a href="#/admin-requests" class="btn btn-outline btn-sm">طلبات الحكام</a>
      <a href="#/admin-announcements" class="btn btn-outline btn-sm">📢 الإعلانات</a>
      <a href="#/admin-settings" class="btn btn-outline btn-sm">⚙ إعدادات التسجيل</a>
      <a href="#/admin-doc-requirements" class="btn btn-outline btn-sm">📑 وثائق الانخراط</a>
      <a href="#/admin-referee-lists" class="btn btn-outline btn-sm">🗒 قوائم الحكام</a>
      <a href="#/admin-changelog" class="btn btn-outline btn-sm">📜 سجل التعديلات</a>
      <a href="/finance" class="btn btn-outline btn-sm">💰 النظام المالي</a>
      ${notifNavLink()}
      ${chatNavLink()}
      <a href="#/account" class="btn btn-ghost btn-sm" title="تغيير كلمة السر">⚙ حسابي</a>
      <button class="btn btn-ghost btn-sm" data-action="logout">تسجيل الخروج</button>`;
  } else {
    // No "Admin Login" and no "حساب حكم" entry points here on purpose —
    // an anonymous visitor is already on/heading to the home page, which
    // has its own signup button, so a topbar link to the same page was
    // dead weight. The admin panel is reachable only by navigating
    // directly to #/admin-login.
    actions = "";
  }
  actions += themeToggleBtn();
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <a href="#/home" class="brand">
        <img src="/assets/logo.png" alt="شعار الرابطة">
        <div class="brand-text">
          <h1>الرابطة الولائية لكرة القدم الوادي</h1>
          <p>منصة انخراط الحكام — الموسم الرياضي ${SEASON}</p>
        </div>
      </a>
      <button type="button" class="nav-burger" id="nav-burger" aria-label="القائمة">☰</button>
      <div class="nav-actions" id="nav-actions">${actions}</div>
    </div>
  </header>`;
}
function footer(){
  return `<footer class="site-footer">
    <div>الرابطة الولائية لكرة القدم الوادي · شارع صلاح الدين الأيوبي - الوادي · lwf39eloued@gmail.com · 032.14.63.16</div>
    <div class="site-footer-credit">من تطوير الأستاذ قرفي عفيف</div>
  </footer>`;
}

// ---- Desktop nav bar: guarantees a single fixed, non-scrollable line for
// #nav-actions (see the @media(min-width:721px) rules in styles.css) by
// shrinking font-size/padding/gap — never by hiding an item, wrapping to a
// second line, or introducing any scroll/slider behavior. CSS alone
// (clamp()/vw) can't do this correctly because the row's total width
// depends on how many nav items the current role has (referee vs admin),
// which CSS has no way to know; this measures the row's actual
// `scrollWidth` (its content width, accurate even while overflow:hidden)
// against its available `clientWidth` and steps the --nav-* custom
// properties down in fixed increments — bounded at NAV_FIT_STEPS, so this
// can never loop indefinitely — until it fits or the floor is reached.
const NAV_FIT_STEPS = 24;
const NAV_FIT_BASE = { font:13, padX:14, padY:8, gap:10, btnGap:6 };
const NAV_FIT_FLOOR = { font:10.5, padX:5, padY:5, gap:3, btnGap:3 };
function applyNavFitStep(nav, t){
  const lerp = (a, b) => (a + (b - a) * t).toFixed(2) + "px";
  nav.style.setProperty("--nav-font", lerp(NAV_FIT_BASE.font, NAV_FIT_FLOOR.font));
  nav.style.setProperty("--nav-pad-x", lerp(NAV_FIT_BASE.padX, NAV_FIT_FLOOR.padX));
  nav.style.setProperty("--nav-pad-y", lerp(NAV_FIT_BASE.padY, NAV_FIT_FLOOR.padY));
  nav.style.setProperty("--nav-gap", lerp(NAV_FIT_BASE.gap, NAV_FIT_FLOOR.gap));
  nav.style.setProperty("--nav-btn-gap", lerp(NAV_FIT_BASE.btnGap, NAV_FIT_FLOOR.btnGap));
}
function fitNavActions(){
  const nav = document.getElementById("nav-actions");
  if(!nav) return;
  // Phone/tablet (<=720px) keep the existing burger-menu dropdown
  // untouched — it's not even necessarily visible in the DOM's normal
  // flow at that width, so measuring/shrinking it here would be
  // meaningless. Clear back to baseline so re-widening the window later
  // starts the fit fresh instead of inheriting a stale shrunk size.
  if(window.innerWidth <= 720){
    ["--nav-font","--nav-pad-x","--nav-pad-y","--nav-gap","--nav-btn-gap"].forEach(p=>nav.style.removeProperty(p));
    return;
  }
  applyNavFitStep(nav, 0);
  if(nav.scrollWidth <= nav.clientWidth) return; // already fits at full size
  for(let i=1;i<=NAV_FIT_STEPS;i++){
    applyNavFitStep(nav, i / NAV_FIT_STEPS);
    if(nav.scrollWidth <= nav.clientWidth) return;
  }
  // Still doesn't fit even at the floor (an extremely narrow desktop
  // window with many nav items) — stays at the floor rather than ever
  // scrolling, wrapping, or hiding an item; this is the smallest one-line
  // rendering the design allows.
}
let _navFitResizeRaf = null;
window.addEventListener("resize", ()=>{
  if(_navFitResizeRaf) cancelAnimationFrame(_navFitResizeRaf);
  _navFitResizeRaf = requestAnimationFrame(fitNavActions);
});

/* ============================================================
   HOME / AUTH
   ============================================================ */
async function pageHome(session){
  if(session && session.user.role==="referee"){ go("dashboard"); return ""; }
  try{ REG_STATUS = await api("/settings/registration"); }
  catch(e){ REG_STATUS = { is_registration_open:true, registration_mode:"always_open", registration_deadline:null, isOpenNow:true }; }
  const closed = REG_STATUS.isOpenNow === false;
  const showCountdown = REG_STATUS.registration_mode === "timer" && REG_STATUS.registration_deadline;
  return `
  <div class="page">
    <section class="hero">
      <span class="hero-eyebrow">استمارة انخراط الحكام · موسم ${SEASON}</span>
      <h2>سجّل انخراطك كحكم رسمي لدى<br>الرابطة الولائية لكرة القدم الوادي</h2>
      <p>أنشئ حسابك، أدخل معلوماتك الشخصية والتحكيمية، ارفع الوثائق المطلوبة، وأرسل ملفك. تراجع الإدارة ملفك وتصدر لك وثيقة الانخراط الرسمية فور الموافقة.</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="show-auth" data-tab="signup" ${closed ? 'disabled' : ''}>${closed ? '⛔ التسجيل مغلق حالياً' : 'إنشاء حساب حكم جديد'}</button>
        <button class="btn btn-outline" data-action="show-auth" data-tab="login">لدي حساب بالفعل</button>
      </div>
      ${showCountdown ? registrationCountdownHtml(REG_STATUS) : ""}
      ${(closed && !showCountdown) ? `<div class="notice-closed mt-16">⛔ التسجيل مغلق حالياً. يرجى التواصل مع الإدارة لمزيد من المعلومات.</div>` : ""}
      <div class="steps-strip">
        <div class="step-mini"><div class="num">1</div><h4>إنشاء الحساب</h4><p>بيانات دخول خاصة بك</p></div>
        <div class="step-mini"><div class="num">2</div><h4>تعبئة الاستمارة</h4><p>المعلومات الشخصية والتحكيمية</p></div>
        <div class="step-mini"><div class="num">3</div><h4>إيداع الملف للمراجعة</h4><p>تدقيق الإدارة لملفك</p></div>
        <div class="step-mini"><div class="num">4</div><h4>وثيقة الانخراط</h4><p>تصدر تلقائيًا عند القبول</p></div>
      </div>
    </section>
    <div id="auth-zone" class="mt-24" style="display:flex;justify-content:center;"></div>
  </div>`;
}

// Live countdown block shown on the home page when the admin has chosen the
// "timer" registration mode. Placeholder numbers here — wireRegistrationCountdown()
// (called from attachGlobalHandlers) fills them in and ticks every second.
function registrationCountdownHtml(reg){
  return `
  <div class="reg-countdown" id="reg-countdown" data-deadline="${escapeHtml(reg.registration_deadline)}">
    <div class="reg-countdown-label">⏳ الوقت المتبقي لإغلاق باب التسجيل</div>
    <div class="reg-countdown-grid">
      <div class="reg-countdown-unit"><span class="reg-countdown-num" data-unit="days">--</span><span class="reg-countdown-suffix">يوم</span></div>
      <div class="reg-countdown-unit"><span class="reg-countdown-num" data-unit="hours">--</span><span class="reg-countdown-suffix">ساعة</span></div>
      <div class="reg-countdown-unit"><span class="reg-countdown-num" data-unit="minutes">--</span><span class="reg-countdown-suffix">دقيقة</span></div>
      <div class="reg-countdown-unit"><span class="reg-countdown-num" data-unit="seconds">--</span><span class="reg-countdown-suffix">ثانية</span></div>
    </div>
  </div>`;
}

// Lucide-style eye / eye-off icons (MIT-licensed icon set), inlined as SVG so
// they render crisply at any size with no external icon-font dependency and
// no build step — they inherit color via currentColor (stroke).
const ICON_EYE = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Builds a password <div class="field"> with a show/hide toggle button baked
// in. Delegated click handling for the toggle is wired once, globally, near
// the bottom of this file — so this helper never needs its own re-wiring
// after re-renders (works the same whether the form was drawn by a full
// page render or a partial innerHTML swap like the login/signup tab switch).
function passwordFieldHtml(label, name, opts={}){
  const { minlength, required=true, disabled=false, id } = opts;
  const idAttr = id ? ` id="${id}"` : "";
  return `<div class="field">
    <label>${label}</label>
    <div class="password-field-wrap">
      <input type="password" name="${name}"${idAttr} ${minlength?`minlength="${minlength}"`:""} ${required?'required':''} ${disabled?'disabled':''}>
      <button type="button" class="password-toggle-btn" data-password-toggle aria-label="إظهار كلمة المرور" aria-pressed="false" title="إظهار كلمة المرور">${ICON_EYE}</button>
    </div>
  </div>`;
}

function authForm(tab){
  const isLogin = tab !== "signup";
  const regClosed = !isLogin && REG_STATUS && REG_STATUS.isOpenNow === false;
  return `
  <div class="panel auth-card">
    <div class="tabs">
      <button class="tab-btn ${isLogin?'active':''}" data-action="show-auth" data-tab="login">تسجيل الدخول</button>
      <button class="tab-btn ${!isLogin?'active':''}" data-action="show-auth" data-tab="signup">إنشاء حساب</button>
    </div>
    <div id="auth-error"></div>
    ${isLogin ? `
      <form id="login-form">
        <div class="field"><label>اسم المستخدم أو البريد الإلكتروني</label><input type="text" name="username" required></div>
        ${passwordFieldHtml('كلمة المرور', 'password')}
        <button type="submit" class="btn btn-primary btn-block">دخول</button>
      </form>` : `
      <form id="signup-form">
        ${regClosed ? `<div class="notice-closed mb-16">⛔ التسجيل مغلق حالياً. يرجى التواصل مع الإدارة لمزيد من المعلومات.</div>` : ""}
        <div class="field"><label>الاسم واللقب (بالعربية)</label><input type="text" name="fullNameAr" required data-script="ar" pattern="[${ARABIC_NAME_CLASS}]+" title="الرجاء الكتابة بأحرف عربية فقط" dir="rtl" ${regClosed?'disabled':''}></div>
        <div class="field"><label>الاسم واللقب (باللاتينية)</label><input type="text" name="fullNameLatin" required data-script="latin" pattern="[${LATIN_NAME_CLASS}]+" title="الرجاء الكتابة بأحرف لاتينية (فرنسية/إنجليزية) فقط" dir="ltr" ${regClosed?'disabled':''}></div>
        <div class="field"><label>رقم الهاتف</label><input type="tel" name="phone" id="signup-phone" required data-script="phone" pattern="(05|06|07)[0-9]{8}" maxlength="10" inputmode="numeric" title="يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام" dir="ltr" placeholder="0512345678" autocomplete="off" ${regClosed?'disabled':''}><div class="field-hint" id="signup-phone-hint"></div></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" name="username" id="signup-username" required data-script="username" pattern="[${USERNAME_CLASS}]+" title="أحرف لاتينية وأرقام فقط، بلا مسافات أو رموز" dir="ltr" autocomplete="off" ${regClosed?'disabled':''}><div class="field-hint" id="signup-username-hint"></div></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="email" name="email" id="signup-email" required pattern="[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+" title="أحرف لاتينية وأرقام فقط، بلا أحرف عربية (مثال: exemple@gmail.com)" placeholder="exemple@gmail.com" dir="ltr" autocomplete="off" ${regClosed?'disabled':''}><div class="field-hint" id="signup-email-hint"></div></div>
        ${passwordFieldHtml('كلمة المرور', 'password', {minlength:4, disabled:regClosed})}
        <button type="submit" class="btn btn-primary btn-block" ${regClosed?'disabled':''}>${regClosed ? 'التسجيل مغلق حالياً' : 'إنشاء الحساب والمتابعة'}</button>
      </form>`}
  </div>`;
}
function showAuthError(msg){ const el=document.getElementById("auth-error"); if(el) el.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }

function wireAvailabilityField(input, hintEl, field){
  if(!input) return;
  let timer = null;
  const requiredMsg = "هذا الحقل مطلوب.";
  input.addEventListener("blur", ()=>{
    input.dataset.vtouched = "1";
    if(!input.value.trim()) setFieldStatus(input, "bad", requiredMsg);
  }, true);
  input.addEventListener("input", ()=>{
    clearTimeout(timer);
    const val = input.value.trim();
    if(!val){ setFieldStatus(input, null, ""); return; }
    // A phone number is only worth checking once it's actually full length —
    // checking after every keystroke would flash a false "صيغة غير صحيحة"
    // the whole time the person is still typing "0512..." etc.
    if(field === "phone" && val.length < 10){ setFieldStatus(input, null, ""); return; }
    // Same reasoning for email — no point flashing an error while the
    // person has only typed the first few letters of the local part.
    if(field === "email" && !val.includes("@")){ setFieldStatus(input, null, ""); return; }
    if(hintEl){ hintEl.textContent = "جارٍ التحقق..."; hintEl.className = "field-hint checking"; }
    timer = setTimeout(async ()=>{
      try{
        const res = await api(`/auth/availability?field=${field}&value=${encodeURIComponent(val)}`);
        if(input.value.trim() !== val) return; // the person kept typing — this result is stale, a newer check is already queued
        if(res.available){
          setFieldStatus(input, "ok", "");
        } else if(res.reason === "format"){
          const formatMsg = { username:"أحرف لاتينية وأرقام فقط، بلا مسافات أو رموز.", phone:"يجب أن يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام.", email:"صيغة البريد الإلكتروني غير صحيحة. أحرف لاتينية وأرقام فقط، بلا أحرف عربية (مثال: exemple@gmail.com)." }[field] || "صيغة غير صحيحة.";
          setFieldStatus(input, "bad", formatMsg);
        } else {
          const takenMsg = { username:"اسم المستخدم مستخدم من قبل، يرجى اختيار اسم آخر.", email:"البريد الإلكتروني مستخدم من قبل، يرجى إدخال بريد آخر.", phone:"رقم الهاتف مستخدم من قبل، يرجى إدخال رقم آخر." }[field] || "هذه المعلومة مستعملة مسبقًا، يرجى إدخال قيمة أخرى.";
          setFieldStatus(input, "bad", takenMsg);
        }
      }catch(e){ setFieldStatus(input, null, ""); }
    }, 450);
  });
}
// Used right before a form with async-checked fields (signup) submits: a
// synchronous last check so a blatant format error or an already-known
// "taken" result (painted by wireAvailabilityField above) blocks the
// submit even if the person hits enter/click before the 450ms debounce
// above has resolved. Returns the first invalid field, or null if all ok.
function recheckAsyncFieldsOnSubmit(fields){
  let firstInvalid = null;
  fields.forEach(({input, meta})=>{
    if(!input) return;
    input.dataset.vtouched = "1";
    const val = input.value.trim();
    if(!val){ setFieldStatus(input, "bad", "هذا الحقل مطلوب."); if(!firstInvalid) firstInvalid = input; return; }
    const { status, message } = computeFieldValidity(meta, val, null);
    if(status === "bad"){ setFieldStatus(input, "bad", message); if(!firstInvalid) firstInvalid = input; return; }
    const fieldDiv = input.closest(".field");
    if(fieldDiv && fieldDiv.classList.contains("field-invalid") && !firstInvalid) firstInvalid = input;
  });
  if(firstInvalid){ firstInvalid.focus(); firstInvalid.scrollIntoView({behavior:"smooth", block:"center"}); }
  return firstInvalid;
}

const LOGIN_FIELD_META = { username: { required:true }, password: { required:true } };
const CHANGE_PASSWORD_FIELD_META = {
  currentPassword: { required:true },
  newPassword: { required:true, minlength:4 },
  confirmPassword: { required:true, matchField:"newPassword", matchLabel:"كلمة السر الجديدة" },
};
const SIGNUP_SYNC_FIELD_META = {
  fullNameAr: { required:true, script:"ar" },
  fullNameLatin: { required:true, script:"latin" },
  password: { required:true, minlength:4 },
};

function attachAuthHandlers(){
  const loginForm = document.getElementById("login-form");
  if(loginForm){
    const validateLogin = wireFormValidation(loginForm, LOGIN_FIELD_META);
    loginForm.addEventListener("submit", async e=>{
      e.preventDefault();
      if(!validateLogin()) return;
      const fd = new FormData(loginForm);
      try{
        const { token, user } = await api("/auth/login", { method:"POST", body:{ username: fd.get("username").trim(), password: fd.get("password") }});
        setSession({ token, user });
        go(user.role==="admin" ? "admin" : "dashboard");
      }catch(err){ showAuthError(err.message); }
    });
  }
  const signupForm = document.getElementById("signup-form");
  if(signupForm){
    const usernameInput = document.getElementById("signup-username");
    const emailInput = document.getElementById("signup-email");
    const phoneInput = document.getElementById("signup-phone");
    wireAvailabilityField(usernameInput, document.getElementById("signup-username-hint"), "username");
    wireAvailabilityField(emailInput, document.getElementById("signup-email-hint"), "email");
    wireAvailabilityField(phoneInput, document.getElementById("signup-phone-hint"), "phone");
    const validateSignupSync = wireFormValidation(signupForm, SIGNUP_SYNC_FIELD_META);
    signupForm.addEventListener("submit", async e=>{
    e.preventDefault();
    if(REG_STATUS && REG_STATUS.isOpenNow === false){ showAuthError("التسجيل مغلق حالياً"); return; }
    const syncOk = validateSignupSync();
    const firstAsyncInvalid = recheckAsyncFieldsOnSubmit([
      { input: usernameInput, meta:{ custom:"username" } },
      { input: emailInput, meta:{ type:"email" } },
      { input: phoneInput, meta:{ format:"phone" } },
    ]);
    if(!syncOk || firstAsyncInvalid) return;
    const fd = new FormData(signupForm);
    try{
      const { token, user } = await api("/auth/signup", { method:"POST", body:{
        fullNameAr: fd.get("fullNameAr").trim(), fullNameLatin: fd.get("fullNameLatin").trim(), username: fd.get("username").trim(),
        email: fd.get("email").trim(), phone: fd.get("phone").trim(), password: fd.get("password")
      }});
      setSession({ token, user });
      go("dashboard");
    }catch(err){ showAuthError(err.message); }
  });
  }
  const adminLoginForm = document.getElementById("admin-login-form");
  if(adminLoginForm){
    const validateAdminLogin = wireFormValidation(adminLoginForm, LOGIN_FIELD_META);
    adminLoginForm.addEventListener("submit", async e=>{
      e.preventDefault();
      if(!validateAdminLogin()) return;
      const fd = new FormData(adminLoginForm);
      try{
        const { token, user } = await api("/auth/login", { method:"POST", body:{ username: fd.get("username").trim(), password: fd.get("password") }});
        if(user.role !== "admin"){ showAuthError("هذا الحساب ليس حساب إدارة."); return; }
        setSession({ token, user });
        go("admin");
      }catch(err){ showAuthError(err.message); }
    });
  }
  const changePasswordForm = document.getElementById("change-password-form");
  if(changePasswordForm && !changePasswordForm.dataset.vformWired){
    changePasswordForm.dataset.vformWired = "1";
    const validateChangePw = wireFormValidation(changePasswordForm, CHANGE_PASSWORD_FIELD_META);
    changePasswordForm._validate = validateChangePw;
  }
}

/* ============================================================
   ACCOUNT — change password (shared by referee and admin)
   ============================================================ */
// Draws on a <canvas> with Pointer Events (unifies mouse/touch/pen — the
// same listeners work on Android, iOS and desktop without a separate touch
// code path). setPointerCapture keeps a fast finger swipe tracked reliably
// even if it briefly leaves the canvas bounds. Internal pixel size is
// scaled by devicePixelRatio so the stroke stays crisp on high-DPI phone
// screens instead of blurry/pixelated.
function wireSignaturePad(){
  const canvas = document.getElementById("sigpad-canvas");
  if(!canvas) return;
  const clearBtn = document.getElementById("sigpad-clear");
  const saveBtn = document.getElementById("sigpad-save");
  const errEl = document.getElementById("sigpad-error");

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 220;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1c2620";

  let drawing = false;
  let hasDrawn = false;
  function posFromEvent(e){
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function start(e){
    drawing = true;
    try{ canvas.setPointerCapture(e.pointerId); }catch(err){}
    const p = posFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    if(errEl) errEl.innerHTML = "";
  }
  function move(e){
    if(!drawing) return;
    const p = posFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasDrawn = true;
  }
  function stop(){ drawing = false; }

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", stop);

  if(clearBtn) clearBtn.addEventListener("click", ()=>{
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn = false;
    if(errEl) errEl.innerHTML = "";
  });
  if(saveBtn) saveBtn.addEventListener("click", async ()=>{
    if(!hasDrawn){
      if(errEl) errEl.innerHTML = `<div class="error-msg">لا يمكن حفظ إمضاء فارغ. يرجى رسم الإمضاء أولاً.</div>`;
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "جارِ الحفظ...";
    try{
      const dataUrl = canvas.toDataURL("image/png");
      const { user } = await api("/auth/signature", { method:"POST", body:{ dataUrl } });
      const session = getSession();
      if(session){ session.user = user; setSession(session); }
      render();
    }catch(err){
      if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 حفظ الإمضاء";
    }
  });
}
// ---- Signature is tied to the التعهد (pledge): once the referee submits
// the application with the pledge confirmed, the backend locks the
// signature (routes/applications.js /mine/submit + the hard lock in
// routes/auth.js POST /signature) and it becomes permanently read-only —
// no edit/clear/redraw option is offered here once locked, matching the
// backend rejection (defense in depth, not the only enforcement point).
// `opts.bare` renders the panel without its own .panel wrapper/heading, for
// embedding directly inside the pledge/review step of the wizard; the
// Account page uses the full wrapped version. ----
function signaturePanelHtml(session, opts){
  opts = opts || {};
  if(!session || session.user.role !== "referee") return "";
  const sig = session.user.signature;
  const locked = !!(sig && sig.locked);
  const intro = opts.introText || 'ارسم إمضاءك بإصبعك أو بالفأرة داخل المربع أدناه، ثم اضغط "حفظ الإمضاء". يُستخدم هذا الإمضاء تلقائيًا في وثيقة الانخراط عند إصدارها.';
  let body;
  if(locked){
    body = `
      <div class="sigpad-saved-preview mt-16" id="sigpad-saved-preview">
        <img src="${sig.url}" alt="الإمضاء المحفوظ">
        <div><div class="sigpad-status">✔ التوقيع نهائي ومرتبط بالتعهد الموقّع</div><p class="text-sm muted" style="margin:4px 0 0;">لا يمكن تعديل هذا التوقيع أو استبداله. لأي تصحيح استثنائي يرجى التواصل مع إدارة الرابطة.</p></div>
      </div>`;
  } else {
    body = `
      ${sig && sig.url ? `
        <div class="sigpad-saved-preview mt-16" id="sigpad-saved-preview">
          <img src="${sig.url}" alt="الإمضاء المحفوظ">
          <div><div class="sigpad-status">✔ يوجد إمضاء محفوظ</div><p class="text-sm muted" style="margin:4px 0 0;">يمكنك رسم إمضاء جديد أدناه لاستبداله. سيصبح نهائيًا بمجرد إرسال التعهد.</p></div>
        </div>` : ""}
      <div id="sigpad-error" class="mt-16"></div>
      <div class="sigpad-wrap mt-16">
        <canvas id="sigpad-canvas" class="sigpad-canvas" width="600" height="220"></canvas>
      </div>
      <div class="sigpad-actions">
        <button type="button" class="btn btn-outline btn-sm" id="sigpad-clear">🧹 مسح</button>
        <button type="button" class="btn btn-primary btn-sm" id="sigpad-save">💾 حفظ الإمضاء</button>
      </div>`;
  }
  const inner = `<p class="text-sm muted">${intro}</p>${body}`;
  if(opts.bare) return `<div class="section-title">التوقيع الإلكتروني</div>${inner}`;
  return `
    <div class="panel">
      <div class="panel-header"><h3>إمضاء الحكم</h3></div>
      ${inner}
    </div>`;
}
function pageAccount(session){
  const backLink = session.user.role === "admin" ? `<a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى لوحة الإدارة</a>` : `<a href="#/dashboard" class="btn btn-ghost btn-sm">→ عودة إلى لوحتي</a>`;
  return `
  <div class="page page-narrow">
    ${backLink}
    <div class="panel mt-16">
      <div class="panel-header"><h3>بيانات الحساب</h3></div>
      <div class="row2">
        <div class="field"><label>الاسم واللقب (بالعربية)</label><input type="text" value="${escapeHtml(session.user.fullNameAr)}" disabled dir="rtl"></div>
        <div class="field"><label>الاسم واللقب (باللاتينية)</label><input type="text" value="${escapeHtml(session.user.fullNameLatin)}" disabled dir="ltr"></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" value="${escapeHtml(session.user.username)}" disabled dir="ltr"></div>
        <div class="field"><label>رقم الهاتف</label><input type="text" value="${escapeHtml(session.user.phone)}" disabled dir="ltr"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header"><h3>تغيير كلمة السر</h3></div>
      <p class="text-sm muted">أدخل كلمة سرك الحالية ثم كلمة السر الجديدة التي تريدها.</p>
      <div id="change-password-result"></div>
      <form id="change-password-form" class="mt-16">
        ${passwordFieldHtml('كلمة السر الحالية', 'currentPassword')}
        ${passwordFieldHtml('كلمة السر الجديدة', 'newPassword', {minlength:4})}
        ${passwordFieldHtml('تأكيد كلمة السر الجديدة', 'confirmPassword', {minlength:4})}
        <button type="submit" class="btn btn-primary">تحديث كلمة السر</button>
      </form>
    </div>
    ${signaturePanelHtml(session)}
  </div>`;
}

function pageSiteDisabled(){
  return `
  <div class="site-disabled-shell">
    <div class="site-disabled-card">
      <img src="/assets/logo.png" alt="شعار الرابطة الولائية لكرة القدم الوادي">
      <h2>🚧 الموقع متوقف مؤقتًا</h2>
      <p>${escapeHtml((SITE_STATUS && SITE_STATUS.message) || "المنصة غير متاحة حاليًا، يرجى المحاولة لاحقًا.")}</p>
      <div class="admin-entry"><a href="#/admin-login" class="muted">دخول الإدارة ←</a></div>
    </div>
  </div>`;
}
function pageAdminLogin(){
  return `
  <div class="center-shell">
    <div class="panel auth-card">
      <h3 style="margin-top:0;color:var(--green-deep);">دخول الإدارة</h3>
      <p class="text-sm muted">هذه الواجهة مخصصة لمسؤولي الرابطة الولائية لمراجعة طلبات الانخراط.</p>
      <div id="auth-error"></div>
      <form id="admin-login-form" class="mt-16">
        <div class="field"><label>اسم المستخدم</label><input type="text" name="username" required></div>
        ${passwordFieldHtml('كلمة المرور', 'password')}
        <button type="submit" class="btn btn-primary btn-block">دخول</button>
      </form>
      <div class="center-txt mt-16"><a href="#/home" class="text-sm muted">عودة لواجهة الحكام ←</a></div>
    </div>
  </div>`;
}

/* ============================================================
   REFEREE DASHBOARD
   ============================================================ */
async function pageDashboard(session){
  if(session.user.accountStatus === "pending"){
    return `
    <div class="page page-narrow">
      <div class="panel center-txt">
        <div class="empty">
          <div class="icon">⏳</div>
          <h3>حسابك قيد المراجعة</h3>
          <p class="muted">حسابك قيد المراجعة والتفعيل من طرف الإدارة لاستكمال التسجيل ورفع الملفات.</p>
          <a href="#/chat" class="btn btn-primary btn-contact-admin mt-16">💬 تواصل مع الإدارة عبر الدردشة المباشرة</a>
        </div>
      </div>
    </div>`;
  }
  if(session.user.accountStatus === "needs_edit"){
    return `
    <div class="page page-narrow">
      <div class="panel center-txt">
        <div class="empty">
          <div class="icon">🔵</div>
          <h3>مطلوب تصحيح معلومات التسجيل</h3>
          <p class="muted">راجعت الإدارة تسجيلك وطلبت تصحيح بعض المعلومات قبل إتمام المراجعة.</p>
          <a href="#/registration-status" class="btn btn-primary mt-16">تصحيح المعلومات المطلوبة</a>
          <a href="#/chat" class="btn btn-outline btn-contact-admin mt-16">💬 تواصل مع الإدارة عبر الدردشة المباشرة</a>
        </div>
      </div>
    </div>`;
  }
  if(session.user.accountStatus === "rejected"){
    return `
    <div class="page page-narrow">
      <div class="panel center-txt">
        <div class="empty">
          <div class="icon">🔴</div>
          <h3>تم رفض تسجيلك</h3>
          <p class="muted">راجعت الإدارة تسجيلك ورفضته. يمكنك الاطلاع على سبب الرفض والتواصل مع الإدارة إذا كان لديك ما تضيفه.</p>
          <a href="#/registration-status" class="btn btn-primary mt-16">عرض سبب الرفض</a>
          <a href="#/chat" class="btn btn-outline btn-contact-admin mt-16">💬 تواصل مع الإدارة عبر الدردشة المباشرة</a>
        </div>
      </div>
    </div>`;
  }
  const { application: app } = await api("/applications/mine");
  CACHE.myApp = app;
  if(app.status === "rejected") await ensureDocRequirements();

  const steps = [
    {key:"draft", label:"تعبئة الاستمارة"},
    {key:"pending_review", label:"مراجعة الإدارة"},
    {key:"approved", label:"وثيقة الانخراط"},
  ];
  const order = ["draft","pending_review","approved"];
  const curIdx = app.status==="rejected" ? 1 : order.indexOf(app.status);

  const tracker = `
  <div class="tracker">
    ${steps.map((s,i)=>{
      let cls = "";
      if(app.status==="rejected" && i===1) cls="rejected";
      else if(i<curIdx) cls="complete";
      else if(i===curIdx) cls="current";
      return `<div class="tstep ${cls}"><div class="circ">${i<curIdx ? '✓' : i+1}</div><div class="tlabel">${s.label}</div></div>`;
    }).join("")}
  </div>`;

  let body = "";
  if(app.status==="draft"){
    body = `<div class="empty"><div class="icon">📝</div><h3>لم تكمل استمارة الانخراط بعد</h3>
      <p class="muted">أكمل جميع الأقسام ثم أرفق الوثائق المطلوبة وأرسل ملفك للمراجعة.</p>
      <a href="#/form" class="btn btn-primary mt-16">متابعة تعبئة الاستمارة</a></div>`;
  } else if(app.status==="pending_review"){
    body = `<div class="empty"><div class="icon">⏳</div><h3>ملفك قيد المراجعة</h3>
      <p class="muted">قامت الإدارة باستلام ملفك وستتم مراجعته والرد عليك في أقرب وقت. يمكنك تعديل معلوماتك أو وثائقك ما دام الملف قيد المراجعة.</p>
      <a href="#/form" class="btn btn-outline mt-16">تعديل الاستمارة أو الوثائق</a></div>`;
  } else if(app.status==="rejected"){
    const flaggedFields = Object.entries(app.flags||{});
    const flaggedDocs = Object.entries(app.docFlags||{});
    body = `
      <div class="reject-note-card">
        <b>تم رفض بعض عناصر ملفك ويلزم تصحيحها:</b>
        ${app.rejectionSummary ? `<p class="mt-8">${escapeHtml(app.rejectionSummary)}</p>` : ""}
        <ul style="margin:10px 0 0;padding-inline-start:20px;">
          ${flaggedFields.map(([k,note])=>{ const f=findFieldMeta(k); return `<li><b>${f?f.label:k}:</b> ${escapeHtml(note||"يرجى التصحيح")}</li>`; }).join("")}
          ${flaggedDocs.map(([k,note])=>{ const d=(CACHE.docRequirements||[]).find(d=>d.id===k); return `<li><b>${d?d.title:k} (وثيقة):</b> ${escapeHtml(note||"يرجى إعادة الرفع")}</li>`; }).join("")}
        </ul>
      </div>
      <a href="#/form" class="btn btn-danger">تصحيح الملف وإعادة الإرسال</a>`;
  } else if(app.status==="approved"){
    body = `<div class="empty"><div class="icon">✅</div><h3>تمت الموافقة على انخراطك — حسابك مفعَّل الآن!</h3>
      <p class="muted">تم اعتماد ملفك من قبل الرابطة الولائية بتاريخ ${fmtDate(app.approvedAt)}.</p>
      <a href="#/certificate" class="btn btn-primary mt-16">عرض وطباعة وثيقة الانخراط</a></div>`;
  }

  const activatedPanel = app.status === "approved" ? `
    <div class="panel">
      <div class="panel-header"><h3>خدمات الحكم المفعَّل</h3></div>
      <div class="steps-strip" style="margin-top:0;">
        <a href="#/profile" class="step-mini" style="text-decoration:none;color:inherit;cursor:pointer;">
          <div class="num" style="background:var(--green-deep);">👤</div><h4>ملفي الشخصي</h4><p>عرض كامل بياناتك ووثائقك</p>
        </a>
        <a href="#/requests" class="step-mini" style="text-decoration:none;color:inherit;cursor:pointer;">
          <div class="num" style="background:var(--gold);">📨</div><h4>طلباتي</h4><p>طلب غياب أو طلب خاص للإدارة</p>
        </a>
      </div>
    </div>` : "";

  return `
  <div class="page page-narrow">
    <div class="panel">
      <div class="panel-header"><h3>حالة ملف الانخراط</h3><span class="status-chip ${app.status}">${statusLabel(app.status)}</span></div>
      ${tracker}
      ${body}
    </div>
    ${activatedPanel}
    <div class="panel">
      <div class="panel-header"><h3>بيانات الحساب</h3></div>
      <div class="row2">
        <div class="field"><label>الاسم واللقب (بالعربية)</label><input type="text" value="${escapeHtml(session.user.fullNameAr)}" disabled dir="rtl"></div>
        <div class="field"><label>الاسم واللقب (باللاتينية)</label><input type="text" value="${escapeHtml(session.user.fullNameLatin)}" disabled dir="ltr"></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="text" value="${escapeHtml(session.user.email)}" disabled dir="ltr"></div>
        <div class="field"><label>رقم الهاتف</label><input type="text" value="${escapeHtml(session.user.phone)}" disabled dir="ltr"></div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   ACCOUNT ACTIVATION REVIEW — referee-facing "متابعة التسجيل"
   (قيد المراجعة / يحتاج إلى تعديل / مرفوض)
   ============================================================ */
const REGISTRATION_FIELD_META = [
  { key: "fullNameAr", label: "الاسم واللقب (بالعربية)", dir: "rtl" },
  { key: "fullNameLatin", label: "الاسم واللقب (باللاتينية)", dir: "ltr" },
  { key: "username", label: "اسم المستخدم", dir: "ltr" },
  { key: "email", label: "البريد الإلكتروني", dir: "ltr" },
  { key: "phone", label: "رقم الهاتف", dir: "ltr" },
];
function registrationHistoryHtml(entries){
  if(!entries || entries.length===0) return "";
  const rows = entries.slice().reverse().map(e=>`
    <li>
      <div class="text-sm"><b>${fmtDateTime(e.at)}</b> — ${escapeHtml(e.event)}${e.byRole==='admin' ? ' <span class="muted">(الإدارة)</span>' : e.byRole==='referee' ? ' <span class="muted">(الحكم)</span>' : ''}</div>
      ${e.note ? `<div class="text-sm muted">${escapeHtml(e.note)}</div>` : ""}
      ${e.reason ? `<div class="text-sm muted">${escapeHtml(e.reason)}</div>` : ""}
    </li>`).join("");
  return `<div class="panel mt-16"><div class="panel-header"><h3>السجل الزمني للحساب</h3></div><ul style="margin:0;padding-inline-start:20px;">${rows}</ul></div>`;
}
async function pageRegistrationStatus(session){
  const status = await api("/auth/registration-status");
  if(status.accountStatus === "active"){
    return `<div class="page page-narrow"><div class="panel center-txt"><div class="empty"><div class="icon">✅</div><h3>حسابك مفعّل</h3><a href="#/dashboard" class="btn btn-primary mt-16">الذهاب إلى لوحتك</a></div></div></div>`;
  }
  if(status.accountStatus === "pending"){
    return `<div class="page page-narrow"><div class="panel center-txt"><div class="empty"><div class="icon">⏳</div><h3>حسابك قيد المراجعة</h3><p class="muted">بانتظار مراجعة الإدارة لمعلومات تسجيلك.</p></div></div>${registrationHistoryHtml(status.registrationHistory)}</div>`;
  }
  if(status.accountStatus === "rejected"){
    return `
    <div class="page page-narrow">
      <div class="panel">
        <div class="empty"><div class="icon">🔴</div><h3>تم رفض تسجيلك</h3></div>
        <div class="reject-note-card"><b>سبب الرفض:</b><p class="mt-8">${escapeHtml(status.rejectionReason||"")}</p></div>
        <a href="#/chat" class="btn btn-outline mt-16">💬 تواصل مع الإدارة</a>
      </div>
      ${registrationHistoryHtml(status.registrationHistory)}
    </div>`;
  }
  // needs_edit — show the admin's note + only the flagged fields, editable, then resubmit
  const flagged = status.reviewFields || [];
  const fieldsHtml = REGISTRATION_FIELD_META.filter(f=>flagged.includes(f.key)).map(f=>`
    <div class="field">
      <label>${f.label}</label>
      <input type="text" name="${f.key}" id="reg-field-${f.key}" value="${escapeHtml(status.fields[f.key]||"")}" dir="${f.dir}">
      <div class="field-error" id="reg-field-error-${f.key}"></div>
    </div>`).join("");
  return `
  <div class="page page-narrow">
    <div class="panel">
      <div class="empty"><div class="icon">🔵</div><h3>مطلوب تصحيح معلومات التسجيل</h3></div>
      <div class="reject-note-card"><b>ملاحظة الإدارة:</b><p class="mt-8">${escapeHtml(status.reviewNote||"")}</p></div>
      <form id="registration-edit-form" class="mt-16">
        ${fieldsHtml}
        <div id="registration-edit-error"></div>
        <button type="submit" class="btn btn-primary btn-block mt-16">حفظ التعديلات</button>
      </form>
      <button type="button" id="registration-resubmit-btn" class="btn btn-primary btn-block mt-16" disabled title="احفظ التعديلات أولاً">📨 إعادة إرسال التسجيل</button>
    </div>
    ${registrationHistoryHtml(status.registrationHistory)}
  </div>`;
}

/* ============================================================
   ADMIN — ACCOUNT ACTIVATION REVIEW ("مراجعة التسجيل")
   ============================================================ */
async function pageAdminRegistrationReview(userId){
  const { users } = await api("/admin/users");
  const user = users.find(u=>u.id===userId);
  if(!user) return `<div class="page"><p class="muted">الحساب غير موجود.</p></div>`;
  const hist = await api(`/admin/users/${userId}/registration-history`);
  const values = { fullNameAr:user.fullNameAr, fullNameLatin:user.fullNameLatin, username:user.username, email:user.email, phone:user.phone };
  const canAct = user.accountStatus === "pending" || user.accountStatus === "needs_edit";

  const fieldsHtml = REGISTRATION_FIELD_META.map(f=>`
    <label class="radio-opt" style="display:flex;align-items:flex-start;gap:8px;">
      <input type="checkbox" name="reg-review-field" value="${f.key}" ${(user.reviewFields||[]).includes(f.key)?'checked':''} ${canAct?'':'disabled'}>
      <span>${f.label}: <b dir="${f.dir}">${escapeHtml(values[f.key]||"—")}</b></span>
    </label>`).join("");

  const statusChip = `<span class="status-chip ${user.accountStatus==='active'?'approved':user.accountStatus==='rejected'?'rejected':user.accountStatus==='needs_edit'?'pending':'pending'}">${escapeHtml(user.accountStatusLabel||user.accountStatus)}</span>`;

  return `
  <div class="page page-narrow">
    <a href="#/admin-users" class="btn btn-ghost btn-sm">→ عودة إلى كل الحسابات</a>
    <div class="panel-header" style="border:none;margin:16px 0 18px;"><h3 style="font-size:22px;">مراجعة تسجيل: ${escapeHtml(user.fullNameAr)} ${statusChip}</h3></div>

    <div class="panel">
      <div class="panel-header"><h3>معلومات التسجيل</h3></div>
      <div class="row2">
        <div class="field"><label>الاسم واللقب (بالعربية)</label><input type="text" value="${escapeHtml(user.fullNameAr)}" disabled dir="rtl"></div>
        <div class="field"><label>الاسم واللقب (باللاتينية)</label><input type="text" value="${escapeHtml(user.fullNameLatin)}" disabled dir="ltr"></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" value="${escapeHtml(user.username)}" disabled dir="ltr"></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="text" value="${escapeHtml(user.email)}" disabled dir="ltr"></div>
        <div class="field"><label>رقم الهاتف</label><input type="text" value="${escapeHtml(user.phone||'')}" disabled dir="ltr"></div>
        <div class="field"><label>تاريخ التسجيل</label><input type="text" value="${fmtDate(user.createdAt)}" disabled></div>
      </div>
    </div>

    ${user.accountStatus === "rejected" ? `
    <div class="panel">
      <div class="reject-note-card"><b>سبب الرفض:</b><p class="mt-8">${escapeHtml(user.rejectionReason||"")}</p></div>
      <button type="button" class="btn btn-outline" data-action="reopen-registration" data-userid="${user.id}">🔁 إعادة فتح المراجعة</button>
    </div>` : `
    <div class="panel">
      <div class="panel-header"><h3>قرار المراجعة</h3></div>
      ${user.accountStatus === "needs_edit" ? `<div class="reject-note-card"><b>آخر ملاحظة أُرسلت للحكم:</b><p class="mt-8">${escapeHtml(user.reviewNote||"")}</p></div>` : ""}
      <button type="button" class="btn btn-primary btn-block" data-action="accept-registration" data-userid="${user.id}" data-fullname="${escapeHtml(user.fullNameAr)}" ${canAct?'':'disabled'}>🟢 قبول الحساب</button>

      <form id="registration-request-edit-form" class="mt-16" data-userid="${user.id}">
        <div class="field"><label>المعلومات التي تحتاج إلى تعديل</label>${fieldsHtml}</div>
        <div class="field"><label>ملاحظة للحكم (إلزامية)</label><textarea name="note" placeholder="مثال: يرجى تصحيح الاسم واللقب حسب بطاقة التعريف." ${canAct?'':'disabled'}></textarea></div>
        <div id="registration-request-edit-error"></div>
        <button type="submit" class="btn btn-outline btn-block" ${canAct?'':'disabled'}>🔵 طلب توضيح / تعديل معلومة</button>
      </form>

      <form id="registration-reject-form" class="mt-16" data-userid="${user.id}">
        <div class="field"><label>سبب الرفض (إلزامي)</label><textarea name="reason" placeholder="مثال: المعلومات المقدمة غير مطابقة للوثائق الرسمية." ${canAct?'':'disabled'}></textarea></div>
        <div id="registration-reject-error"></div>
        <button type="submit" class="btn btn-danger btn-block" ${canAct?'':'disabled'}>🔴 رفض الحساب</button>
      </form>
    </div>`}

    ${registrationHistoryHtml(hist.registrationHistory)}
  </div>`;
}

/* ============================================================
   APPLICATION FORM (wizard)
   ============================================================ */
async function pageForm(session){
  if(!CACHE.myApp || CACHE.myApp.status===undefined){
    const { application } = await api("/applications/mine");
    CACHE.myApp = application;
  }
  await ensureDocRequirements();
  const app = CACHE.myApp;
  const docReqs = CACHE.docRequirements;
  const totalSteps = FIELD_GROUPS.length + 2;
  if(WIZ_STEP > totalSteps-1) WIZ_STEP = 0;

  const navItems = [
    ...FIELD_GROUPS.map((g,i)=>({label:g.title, idx:i})),
    {label:"الوثائق المطلوبة", idx: FIELD_GROUPS.length},
    {label:"المراجعة والإقرار", idx: FIELD_GROUPS.length+1},
  ];
  const navHtml = navItems.map(n=>{
    let cls = n.idx===WIZ_STEP ? "active" : (n.idx<WIZ_STEP ? "done":"");
    return `<div class="wnav-item ${cls}" data-action="wiz-goto" data-idx="${n.idx}"><div class="dot">${n.idx<WIZ_STEP?'✓':n.idx+1}</div><span>${n.label}</span></div>`;
  }).join("");

  let stepHtml = "";
  if(WIZ_STEP < FIELD_GROUPS.length) stepHtml = renderGroupStep(FIELD_GROUPS[WIZ_STEP], app);
  else if(WIZ_STEP === FIELD_GROUPS.length) stepHtml = renderDocsStep(app, docReqs);
  else stepHtml = renderReviewStep(app, docReqs);

  const isFirst = WIZ_STEP===0;
  const isLast = WIZ_STEP===totalSteps-1;

  return `
  <div class="page">
    ${app.status==='rejected' ? `<div class="reject-note-card" style="margin-bottom:18px;"><b>ملاحظة:</b> ملفك يحتوي على عناصر مرفوضة سابقًا. المواضع المعنية مظللة أدناه — صححها ثم أعد الإرسال.</div>` : ""}
    <div id="form-error"></div>
    <div class="wizard-shell">
      <nav class="wizard-nav">${navHtml}</nav>
      <div class="panel">
        <form id="wizard-form">
          ${stepHtml}
          <div class="wizard-actions">
            <button type="button" class="btn btn-outline" data-action="wiz-prev" ${isFirst?'disabled':''}>السابق</button>
            ${isLast ? `<button type="submit" class="btn btn-primary">${app.status==='rejected' ? 'إعادة إرسال الملف' : app.status==='pending_review' ? 'حفظ التعديلات' : 'إرسال الملف للمراجعة'}</button>`
                     : `<button type="submit" class="btn btn-primary">التالي</button>`}
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function renderGroupStep(group, app){
  const flags = app.flags || {};
  return `
    <div class="panel-header"><span class="badge-num">${FIELD_GROUPS.indexOf(group)+1}</span><h3>${group.title}</h3></div>
    <div class="row2">${group.fields.map(f=> renderField(f, app.data[f.key], flags[f.key])).join("")}</div>`;
}
function renderField(f, value, flagNote){
  const flagged = flagNote!==undefined;
  const style = f.full ? 'style="grid-column:1/-1;"' : '';
  let control = "";
  if(f.type==="select"){
    control = `<select name="${f.key}" ${f.required?'required':''}>
      <option value="" disabled ${!value?'selected':''}>اختر...</option>
      ${f.options.map(o=>`<option value="${o}" ${value===o?'selected':''}>${o}</option>`).join("")}
    </select>`;
  } else if(f.type==="radio"){
    control = `<div class="radio-row">${f.options.map(o=>`<label class="radio-opt"><input type="radio" name="${f.key}" value="${o}" ${value===o?'checked':''} ${f.required?'required':''}> ${o}</label>`).join("")}</div>`;
  } else if(f.type==="textarea"){
    control = `<textarea name="${f.key}" ${f.required?'required':''}>${escapeHtml(value||"")}</textarea>`;
  } else if(f.script){
    const cls = SCRIPT_CLASSES[f.script];
    const title = f.script==="ar" ? "الرجاء الكتابة بأحرف عربية فقط" : "الرجاء الكتابة بأحرف لاتينية (فرنسية/إنجليزية) فقط";
    control = `<input type="${f.type}" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''} data-script="${f.script}" pattern="[${cls}]+" title="${title}" dir="${f.script==='ar'?'rtl':'ltr'}">`;
  } else if(f.format==="phone"){
    // Same rules as the account signup phone field (see authForm below):
    // digits only, must start with 05/06/07, exactly 10 digits.
    control = `<input type="tel" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''} data-script="phone" pattern="(05|06|07)[0-9]{8}" maxlength="10" inputmode="numeric" title="يبدأ بـ 05 أو 06 أو 07 ويتكون من 10 أرقام" dir="ltr" placeholder="0512345678">`;
  } else if(f.format==="shoeSize"){
    control = `<input type="text" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''} data-script="digits" pattern="\\d{1,2}" maxlength="2" inputmode="numeric" title="أرقام فقط، رقمان كحد أقصى" dir="ltr">`;
  } else if(f.format==="clothingSize"){
    // Uppercased live (see the data-format="clothingSize" listener below),
    // so by the time the person stops typing the value already matches the
    // (uppercase) pattern below regardless of the case they typed in.
    control = `<input type="text" name="${f.key}" value="${escapeHtml((value||"").toUpperCase())}" ${f.required?'required':''} data-format="clothingSize" pattern="(XS|S|M|L|XXXL|XXL|XL|[2-4]XL)" maxlength="4" title="مقاسات مقبولة: S, M, L, XL, XXL, XXXL, 2XL, 3XL, 4XL" dir="ltr" placeholder="XL">`;
  } else if(f.format==="season"){
    // Auto-inserts the "/" as the person types (see the data-format="season"
    // listener below) — only digits are ever typeable, so "2014-2015" or
    // letters can never be entered in the first place.
    control = `<input type="text" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''} data-format="season" pattern="\\d{4}/\\d{4}" maxlength="9" inputmode="numeric" title="الصيغة المطلوبة: xxxx/xxxx (مثال: 2014/2015)" dir="ltr" placeholder="${f.placeholder||'2014/2015'}">`;
  } else if(f.format==="ccp"){
    // Always pre-filled with the fixed prefix — see the data-format="ccp"
    // listener below, which stops the person from ever editing it away.
    const ccpValue = sanitizeCcpValue(value || CCP_PREFIX);
    control = `<input type="text" name="${f.key}" value="${escapeHtml(ccpValue)}" ${f.required?'required':''} data-format="ccp" pattern="${CCP_PREFIX}\\d{${CCP_TOTAL_LENGTH-CCP_PREFIX.length}}" maxlength="${CCP_TOTAL_LENGTH}" inputmode="numeric" title="يبدأ بـ ${CCP_PREFIX} ويتكون من ${CCP_TOTAL_LENGTH} رقمًا" dir="ltr">`;
  } else if(f.type==="email"){
    control = `<input type="email" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''} dir="ltr" placeholder="exemple@gmail.com">`;
  } else {
    control = `<input type="${f.type}" name="${f.key}" value="${escapeHtml(value||"")}" ${f.required?'required':''}>`;
  }
  return `<div class="field ${flagged?'flagged':''}" ${style}>
    <label>${f.label}${f.required?' *':''}</label>
    ${control}
    ${flagged ? `<div class="hint" style="color:var(--red-accent);font-weight:700;">⚠ ملاحظة الإدارة: ${escapeHtml(flagNote||"يرجى التصحيح")}</div>` : ""}
  </div>`;
}
function renderDocsStep(app, docReqs){
  const flags = app.docFlags || {};
  return `
    <div class="panel-header"><span class="badge-num">${FIELD_GROUPS.length+1}</span><h3>الوثائق المطلوبة</h3></div>
    <p class="text-sm muted">الرجاء رفع صور أو مستندات واضحة (JPG, PNG أو PDF، بحد أقصى 8MB لكل ملف). اضغط على 🔍 لمراجعة الوثيقة بحجم كبير قبل الإرسال.</p>
    <div class="uploads-grid mt-16">
      ${docReqs.map(d=>{
        const val = app.documents[d.id];
        const flagged = flags[d.id]!==undefined;
        const cls = flagged ? "rejected" : (val ? "filled" : "");
        return `<div>
          <div class="upload-box ${cls}" data-doc="${d.id}">
            <input type="file" accept="image/*,application/pdf" data-doc-input="${d.id}">
            ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img class="upload-preview" src="${val.url}">` : `<div class="icon">📎</div>`) : `<div class="icon">${d.icon||'📎'}</div>`}
            <div class="label">${escapeHtml(d.title)}${d.isRequired ? '' : ' <span class="muted" style="font-weight:400;">(اختياري)</span>'}</div>
            <div class="sub" data-doc-status="${d.id}">${val ? (val.originalName || 'تم الرفع') : 'اضغط للرفع'}</div>
          </div>
          ${d.description ? `<p class="text-sm muted" style="margin:6px 0 0;">${escapeHtml(d.description)}</p>` : ""}
          ${d.hasTemplate && d.templateUrl ? `<a href="${d.templateUrl}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="width:100%;margin-top:8px;">⬇ تحميل النموذج (PDF)</a>` : ""}
          ${val ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" style="width:100%;margin-top:8px;" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d.title)}">🔍 عرض</button>` : ""}
          ${flagged ? `<div class="hint" style="color:var(--red-accent);font-weight:700;">⚠ ${escapeHtml(flags[d.id]||"يرجى إعادة الرفع")}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}
function renderReviewStep(app, docReqs){
  return `
    <div class="panel-header"><span class="badge-num">${FIELD_GROUPS.length+2}</span><h3>المراجعة والإقرار</h3></div>
    ${FIELD_GROUPS.map(g=>`
      <div class="section-title">${g.title}</div>
      ${g.fields.map(f=>`<div class="review-field"><div><div class="rf-label">${f.label}</div><div class="rf-value">${escapeHtml(app.data[f.key]||"—")}</div></div></div>`).join("")}
    `).join("")}
    <div class="section-title">الوثائق</div>
    ${docReqs.map(d=>`<div class="review-field"><div><div class="rf-label">${escapeHtml(d.title)}${d.isRequired?'':' (اختياري)'}</div><div class="rf-value">${app.documents[d.id] ? '✓ تم الرفع — '+escapeHtml(app.documents[d.id].originalName||'') : (d.isRequired ? '⚠ لم يتم الرفع' : '—')}</div></div></div>`).join("")}
    <div class="field mt-24" style="grid-column:1/-1;background:var(--green-pale);padding:16px;border-radius:10px;">
      <label style="display:flex;gap:10px;align-items:flex-start;font-weight:600;">
        <input type="checkbox" name="declaration" id="declaration-check" ${app.declaration?'checked':''} required style="margin-top:4px;">
        <span>${DECLARATION_TEXT}</span>
      </label>
      <div class="field-hint bad" id="declaration-error"></div>
      ${signaturePanelHtml(getSession(), { bare:true, introText:'وقّع هنا لإتمام التعهد أعلاه. بعد حفظ التعهد يصبح هذا التوقيع نهائيًا ولا يمكن تعديله أو استبداله.' })}
      <div class="field-hint bad" id="sigpad-required-error"></div>
    </div>`;
}

function collectStepFields(app){
  const form = document.getElementById("wizard-form");
  if(!form) return null;
  if(WIZ_STEP < FIELD_GROUPS.length){
    const group = FIELD_GROUPS[WIZ_STEP];
    const fields = {};
    group.fields.forEach(f=>{
      if(f.type==="radio"){
        const checked = form.querySelector(`input[name="${f.key}"]:checked`);
        fields[f.key] = checked ? checked.value : "";
      } else {
        const el = form.elements[f.key];
        fields[f.key] = el ? el.value : "";
      }
      app.data[f.key] = fields[f.key];
    });
    return { fields };
  } else if(WIZ_STEP === FIELD_GROUPS.length + 1){
    const chk = document.getElementById("declaration-check");
    app.declaration = chk ? chk.checked : false;
    return { declaration: app.declaration };
  }
  return null;
}
function validateStepClientSide(){
  const form = document.getElementById("wizard-form");
  if(!form) return true;
  if(form._validateFields){
    if(!form._validateFields()) return false;
  } else if(!form.reportValidity()){
    return false;
  }
  if(WIZ_STEP === FIELD_GROUPS.length){
    const docReqs = CACHE.docRequirements || [];
    const missing = docReqs.filter(d=>d.isRequired && !CACHE.myApp.documents[d.id]);
    if(missing.length){ alert("يرجى رفع جميع الوثائق المطلوبة: " + missing.map(d=>d.title).join("، ")); return false; }
  }
  if(WIZ_STEP === FIELD_GROUPS.length + 1){
    const chk = document.getElementById("declaration-check");
    const msgEl = document.getElementById("declaration-error");
    if(!chk || !chk.checked){
      if(msgEl) msgEl.textContent = "يجب الموافقة على الإقرار للمتابعة.";
      chk?.closest(".field")?.classList.add("field-invalid");
      chk?.focus();
      return false;
    }
    if(msgEl) msgEl.textContent = "";
    chk.closest(".field")?.classList.remove("field-invalid");

    // The signature is tied to this pledge — it must already be drawn and
    // saved (client-side gate; the authoritative check is server-side in
    // POST /applications/mine/submit) before the pledge can be submitted.
    const sigMsgEl = document.getElementById("sigpad-required-error");
    const session = getSession();
    const hasSignature = !!(session && session.user.signature && session.user.signature.url);
    if(!hasSignature){
      if(sigMsgEl) sigMsgEl.textContent = "يجب رسم التوقيع وحفظه لإتمام التعهد قبل المتابعة.";
      document.getElementById("sigpad-canvas")?.scrollIntoView({ behavior:"smooth", block:"center" });
      return false;
    }
    if(sigMsgEl) sigMsgEl.textContent = "";
  }
  return true;
}

/* ============================================================
   CERTIFICATE
   ============================================================ */
async function pageCertificate(session){
  const { application: app } = await api("/applications/mine");
  if(!app || app.status !== "approved"){ go("dashboard"); return ""; }
  return `
  <div class="page page-narrow">
    ${certificateHtml(app, session.user)}
    <div class="cert-actions no-print">
      <button class="btn btn-primary" onclick="window.print()">🖨 طباعة / تنزيل PDF</button>
      <a href="#/dashboard" class="btn btn-outline">عودة إلى لوحتي</a>
    </div>
  </div>`;
}
function certificateHtml(app, user){
  const d = app.data;
  return `
  <div class="cert">
    <div class="cert-head">
      <div class="htext">
        <h2>الاتحاد الجزائري لكرة القدم</h2>
        <p>الرابطة الجهوية لكرة القدم ورقلة — الرابطة الولائية لكرة القدم الوادي</p>
      </div>
      <img src="/assets/logo.png" alt="شعار">
    </div>
    <div class="cert-body">
      <div class="cert-title"><h1>وثيقة انخراط حكم</h1><p>الموسم الرياضي ${app.season} — رقم الملف: ${app.id.slice(0,8).toUpperCase()}</p></div>

      <div class="cert-name-row">
        <div class="cert-name-block">
          <div class="k">اللقب والاسم (بالعربية)</div>
          <div class="cert-name-value cert-name-center">${escapeHtml(d.fullNameAr)}</div>
          <div class="k mt-8">اللقب والاسم (باللاتينية) / Nom et prénom</div>
          <div class="cert-name-value cert-name-center" dir="ltr">${escapeHtml(d.fullNameLatin)}</div>
          <div class="k mt-8">تاريخ ومكان الميلاد</div>
          <div class="cert-birth-value cert-name-center">${fmtBirthDate(d.birthDate)} - ${escapeHtml(d.birthPlace)}</div>
        </div>
        ${app.documents.photo ? `<img class="cert-photo" src="${app.documents.photo.url}">` : ""}
      </div>

      <div class="cert-grid">
        <div class="cert-cell"><div class="k">الحالة العائلية</div><div class="v">${escapeHtml(d.maritalStatus)}</div></div>
        <div class="cert-cell"><div class="k">المستوى التعليمي</div><div class="v">${escapeHtml(d.educationLevel)}</div></div>
        <div class="cert-cell"><div class="k">العنوان الشخصي</div><div class="v">${escapeHtml(d.address)}</div></div>
        <div class="cert-cell"><div class="k">الهاتف</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.phone1)}</div></div>
        <div class="cert-cell"><div class="k">البريد الإلكتروني</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.email)}</div></div>
        <div class="cert-cell"><div class="k">الوظيفة</div><div class="v">${escapeHtml(d.job)}</div></div>
        <div class="cert-cell"><div class="k">رقم الحساب الجاري البريدي</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.ccp)}</div></div>
        <div class="cert-cell"><div class="k">موسم الدخول إلى التحكيم</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.refStartDate)}</div></div>
        <div class="cert-cell"><div class="k">الرتبة الحالية</div><div class="v">${escapeHtml(d.refLevel)}</div></div>
        <div class="cert-cell"><div class="k">صفة التحكيم</div><div class="v">${escapeHtml(d.refRole)}</div></div>
        <div class="cert-cell"><div class="k">متاح خلال الأسبوع</div><div class="v">${escapeHtml(d.availableWeekly)}</div></div>
        <div class="cert-cell"><div class="k">مقاس الحذاء</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.shoeSize)}</div></div>
        <div class="cert-cell"><div class="k">مقاس اللباس</div><div class="v" dir="ltr" style="text-align:right;">${escapeHtml(d.clothingSize)}</div></div>
      </div>

      <div class="section-title cert-declaration-title">التعهد</div>
      <p class="cert-declaration-text">${DECLARATION_TEXT}</p>

      <div class="cert-footer">
        <div>
          <div class="k text-sm muted">حرر بالوادي في</div>
          <div class="v" style="font-weight:800;margin-bottom:16px;">${fmtDate(app.approvedAt)}</div>
          <div class="k text-sm muted">إمضاء المعني</div>
          ${user && user.signature && user.signature.url
            ? `<img class="cert-signature-img" src="${user.signature.url}" alt="إمضاء الحكم">`
            : `<div class="signature-line"></div>`}
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   REFEREE — FULL PROFILE (available once approved)
   ============================================================ */
// ---- Fields whose value is always Latin/numeric and must always render
// flush against the right edge, in every screen the field appears on
// (editable or read-only), regardless of whether the value is empty or
// filled. See the CSS rule above scoped to input[dir="ltr"]. ----
const LTR_RIGHT_ALIGN_KEYS = new Set(["fullNameLatin","phone1","phone2","emergencyPhone","username","shoeSize","clothingSize","ccp","email","phone","refStartDate"]);
function ltrDirAttr(key){ return LTR_RIGHT_ALIGN_KEYS.has(key) ? ' dir="ltr"' : ""; }
async function pageProfile(session){
  const { application: app } = await api("/applications/mine");
  if(!app || app.status !== "approved"){ go("dashboard"); return ""; }
  const docReqs = await ensureDocRequirements();
  const d = app.data;

  const fieldsHtml = FIELD_GROUPS.map(g=>`
    <div class="section-title">${g.title}</div>
    <div class="row2">
      ${g.fields.map(f=>`<div class="field"><label>${f.label}</label><input type="text" value="${escapeHtml(d[f.key]||"—")}"${ltrDirAttr(f.key)} disabled></div>`).join("")}
    </div>
  `).join("");

  const docsHtml = docReqs.map(d2=>{
    const val = app.documents[d2.id];
    return `<div class="review-field">
      <div style="flex:1;">
        <div class="rf-label">${escapeHtml(d2.title)}</div>
        ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img src="${val.url}" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid var(--line);margin-top:6px;">` : `<div class="rf-value">📎 <a href="${val.url}" target="_blank">${escapeHtml(val.originalName||'ملف مرفق')}</a></div>`) : `<div class="rf-value muted">—</div>`}
      </div>
      ${val ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d2.title)}">🔍 عرض</button>` : ""}
    </div>`;
  }).join("");

  return `
  <div class="page">
    <a href="#/dashboard" class="btn btn-ghost btn-sm">→ عودة إلى لوحتي</a>
    <div class="panel mt-16">
      <div class="panel-header"><h3>ملفي الشخصي الكامل</h3><span class="status-chip approved">مفعَّل</span></div>
      ${fieldsHtml}
      <div class="section-title">الوثائق</div>
      ${docsHtml}
    </div>
    <div class="panel center-txt">
      <a href="#/certificate" class="btn btn-primary">عرض وثيقة الانخراط</a>
      <a href="#/requests" class="btn btn-outline">✎ طلب تعديل معلومة</a>
    </div>
  </div>`;
}

/* ============================================================
   REFEREE — REQUESTS (absence / special), available once approved
   ============================================================ */
function requestStatusLabel(s){ return {pending:"🟠 قيد المراجعة", needs_clarification:"🔵 يحتاج إلى توضيح/تعديل", approved:"🟢 مقبول", rejected:"🔴 مرفوض"}[s] || s; }
function requestStatusChipClass(s){ return {pending:"pending", needs_clarification:"pending_review", approved:"approved", rejected:"rejected"}[s] || "draft"; }

// سجل الطلب الزمني (Timeline) — every stage the request went through,
// who did it, and when. Rendered identically for the referee and the
// admin so both sides see the same history.
function requestTimelineHtml(r){
  const events = Array.isArray(r.history) ? r.history : [];
  if(!events.length) return "";
  const items = events.map(h => `
    <li>
      <span class="text-sm">${escapeHtml(h.event)}</span>
      <span class="text-sm muted"> — ${fmtDate(h.at)}</span>
      ${h.note ? `<div class="text-sm muted">«${escapeHtml(h.note)}»</div>` : ""}
    </li>`).join("");
  return `<details class="mt-8"><summary class="text-sm muted" style="cursor:pointer;">📜 سجل الطلب (${events.length})</summary>
    <ul style="margin:8px 0 0;padding-inline-start:18px;display:flex;flex-direction:column;gap:6px;">${items}</ul>
  </details>`;
}

function requestTypeLabel(r){
  if(r.type==='absence') return '🗓 طلب غياب';
  if(r.type==='edit') return '✎ طلب تعديل معلومة';
  return '✉️ طلب خاص';
}

function myRequestCardHtml(r){
  // Once the admin decides (🟢 مقبول / 🔴 مرفوض) the request is final and
  // closed for the referee — no edit, no delete, no status change, ever.
  // Editing is allowed while the request is still قيد المراجعة for the
  // first time (admin hasn't touched it yet) OR while the admin has
  // explicitly asked for توضيح/تعديل (🔵). Deleting is allowed ONLY while
  // it's still قيد المراجعة for the first time — once the admin has acted
  // on it in any way (طلب توضيح، قبول، رفض) it can never be deleted.
  const everHandledByAdmin = (r.history||[]).some(h=>h.by==='admin');
  const canEdit = r.status === 'needs_clarification' || r.status === 'pending';
  const canDelete = r.status === 'pending' && !everHandledByAdmin;
  let bodyHtml = "";
  if(r.type==='special'){
    bodyHtml = `<div class="mt-8"><b>${escapeHtml(r.title)}</b></div><p class="mt-8">${escapeHtml(r.details)}</p>`;
  } else if(r.type==='absence'){
    bodyHtml = `<div class="mt-8 text-sm"><b>من:</b> ${escapeHtml(r.dateFrom)} &nbsp; <b>إلى:</b> ${escapeHtml(r.dateTo)}</div><p class="mt-8">${escapeHtml(r.details)}</p>
      ${r.attachment ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger mt-8" data-zoom-url="${r.attachment.url}" data-zoom-mime="${r.attachment.mimetype||''}" data-zoom-title="تبرير الغياب">🔍 عرض تبرير الغياب</button>` : ''}`;
  } else if(r.type==='edit'){
    const fm = findFieldMeta(r.fieldKey);
    bodyHtml = `<div class="mt-8 text-sm"><b>${fm?fm.label:r.fieldKey}:</b> ${escapeHtml(r.oldValue||'—')} ← <span style="color:var(--green-deep);font-weight:800;">${escapeHtml(r.newValue||'')}</span></div><p class="mt-8">${escapeHtml(r.details)}</p>`;
  }
  const noteColor = r.status === 'rejected' ? 'var(--red-accent)' : (r.status === 'needs_clarification' ? '#1d5b93' : 'var(--green-deep)');
  return `<div class="panel" style="margin-top:14px;" id="my-request-${r.id}">
    <div class="panel-header">
      <h3>${requestTypeLabel(r)}</h3>
      <span class="status-chip ${requestStatusChipClass(r.status)}">${requestStatusLabel(r.status)}</span>
    </div>
    <div class="text-sm muted">تاريخ الإرسال: ${fmtDate(r.createdAt)}</div>
    ${bodyHtml}
    ${r.adminNote ? `<div class="text-sm mt-8" style="color:${noteColor};"><b>ملاحظة الإدارة:</b> ${escapeHtml(r.adminNote)}</div>` : ''}
    ${r.status === 'approved' ? `<div class="text-sm mt-8" style="color:var(--green-deep);font-weight:700;">✅ تم قبول طلبك.</div>` : ''}
    ${(canEdit || canDelete) ? `<div class="flex gap-12 mt-16">
      ${canEdit ? `<button type="button" class="btn btn-outline btn-sm" data-action="my-request-edit-toggle" data-reqid="${r.id}">✎ ${r.status==='pending' ? 'تعديل الطلب' : 'تعديل الطلب وإعادة الإرسال'}</button>` : ''}
      ${canDelete ? `<button type="button" class="btn btn-danger-outline btn-sm" data-action="my-request-delete" data-reqid="${r.id}">🗑 حذف الطلب</button>` : ''}
    </div>` : ''}
    <div id="my-request-edit-form-${r.id}" style="display:none;" class="mt-16"></div>
    ${requestTimelineHtml(r)}
  </div>`;
}

function myRequestEditFormHtml(r){
  if(r.type === 'absence'){
    return `
      <form data-my-request-edit-form="${r.id}" data-req-type="absence" data-req-id="${r.id}">
        <div class="row2">
          <div class="field"><label>من تاريخ</label><input type="date" name="dateFrom" value="${r.dateFrom||''}" required></div>
          <div class="field"><label>إلى تاريخ</label><input type="date" name="dateTo" value="${r.dateTo||''}" required></div>
        </div>
        <div class="field"><label>سبب الغياب</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
        <div class="field"><label>تبرير الغياب (اختياري، صورة أو PDF) — اتركه فارغًا للإبقاء على المرفق الحالي</label><input type="file" name="attachment" accept="image/*,application/pdf"></div>
        <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ التعديل</button><button type="button" class="btn btn-ghost btn-sm" data-action="my-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
      </form>`;
  }
  if(r.type === 'special'){
    return `
      <form data-my-request-edit-form="${r.id}" data-req-type="special" data-req-id="${r.id}">
        <div class="field"><label>عنوان الطلب</label><input type="text" name="title" value="${escapeHtml(r.title||'')}" required></div>
        <div class="field"><label>تفاصيل الطلب</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
        <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ التعديل</button><button type="button" class="btn btn-ghost btn-sm" data-action="my-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
      </form>`;
  }
  if(r.type === 'edit'){
    const fm = findFieldMeta(r.fieldKey);
    return `
      <form data-my-request-edit-form="${r.id}" data-req-type="edit" data-req-id="${r.id}">
        <div class="field"><label>القيمة الجديدة لـ «${fm?fm.label:r.fieldKey}»</label><input type="text" name="newValue" value="${escapeHtml(r.newValue||'')}" required></div>
        <div class="field"><label>سبب التعديل</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
        <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ التعديل</button><button type="button" class="btn btn-ghost btn-sm" data-action="my-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
      </form>`;
  }
  return "";
}

async function pageRequests(session){
  const { application: app } = await api("/applications/mine");
  if(!app || app.status !== "approved"){ go("dashboard"); return ""; }
  const { requests } = await api("/requests/mine");
  CACHE.myRequests = requests;

  const listHtml = requests.length === 0 ? `<div class="empty"><div class="icon">📭</div><h3>لا توجد طلبات سابقة</h3></div>` : requests.map(myRequestCardHtml).join("");

  const fieldOptions = FIELD_GROUPS.map(g=>`<optgroup label="${g.title}">${g.fields.map(f=>`<option value="${f.key}">${f.label}</option>`).join("")}</optgroup>`).join("");

  return `
  <div class="page">
    <a href="#/dashboard" class="btn btn-ghost btn-sm">→ عودة إلى لوحتي</a>
    <div class="panel mt-16">
      <div class="panel-header"><h3>طلب غياب</h3></div>
      <p class="text-sm muted">أرسل طلب غياب عن مباراة أو فترة محددة للإدارة، مع إمكانية إرفاق تبرير.</p>
      <div id="absence-request-error"></div>
      <form id="absence-request-form" class="mt-16">
        <div class="row2">
          <div class="field"><label>من تاريخ</label><input type="date" name="dateFrom" required></div>
          <div class="field"><label>إلى تاريخ</label><input type="date" name="dateTo" required></div>
        </div>
        <div class="field"><label>سبب الغياب</label><textarea name="details" required placeholder="اذكر سبب الغياب..."></textarea></div>
        <div class="field"><label>تبرير الغياب (اختياري، صورة أو PDF)</label><input type="file" name="attachment" accept="image/*,application/pdf"></div>
        <button type="submit" class="btn btn-primary">إرسال طلب الغياب</button>
      </form>
    </div>
    <div class="panel">
      <div class="panel-header"><h3>طلب خاص</h3></div>
      <p class="text-sm muted">اكتب أي طلب آخر موجَّه للإدارة (نقل، استفسار، إلخ) لتوافق عليه أو ترفضه.</p>
      <div id="special-request-error"></div>
      <form id="special-request-form" class="mt-16">
        <div class="field"><label>عنوان الطلب</label><input type="text" name="title" required placeholder="مثال: طلب نقل إلى رابطة أخرى"></div>
        <div class="field"><label>تفاصيل الطلب</label><textarea name="details" required placeholder="اكتب تفاصيل طلبك..."></textarea></div>
        <button type="submit" class="btn btn-primary">إرسال الطلب</button>
      </form>
    </div>
    <div class="panel">
      <div class="panel-header"><h3>طلب تعديل معلومة</h3></div>
      <p class="text-sm muted">بعد قبول انخراطك، لا يمكنك تعديل معلوماتك مباشرة. اختر المعلومة، أدخل القيمة الجديدة، واذكر السبب — تُطبَّق تلقائيًا في ملفك بعد موافقة الإدارة.</p>
      <div id="edit-request-error"></div>
      <form id="edit-request-form" class="mt-16">
        <div class="field">
          <label>المعلومة المراد تعديلها</label>
          <select name="fieldKey" required>
            <option value="" disabled selected>اختر...</option>
            ${fieldOptions}
          </select>
        </div>
        <div class="field"><label>القيمة الجديدة</label><input type="text" name="newValue" required></div>
        <div class="field"><label>سبب التعديل</label><textarea name="details" required placeholder="اشرح سبب طلب التعديل..."></textarea></div>
        <button type="submit" class="btn btn-primary">إرسال طلب التعديل</button>
      </form>
    </div>
    <div class="panel">
      <div class="panel-header"><h3>طلباتي السابقة</h3></div>
      ${listHtml}
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — LIST
   ============================================================ */
let ADMIN_APPS_STATE = { page: 1, pageSize: 20, status: "all", q: "" };

async function pageAdminList(){
  const params = new URLSearchParams({ page: ADMIN_APPS_STATE.page, pageSize: ADMIN_APPS_STATE.pageSize, status: ADMIN_APPS_STATE.status });
  if (ADMIN_APPS_STATE.q) params.set("q", ADMIN_APPS_STATE.q);
  const { applications: apps, total, page, pageSize, totalPages, counts } = await api(`/admin/applications?${params.toString()}`);
  const { total: totalAccounts } = await api("/admin/users");
  const rows = apps.map(a=>{
    return `<tr>
      <td>${escapeHtml(a.data.fullNameAr || "—")}${a.data.fullNameLatin ? `<div class="text-sm muted" dir="ltr" style="text-align:right;">${escapeHtml(a.data.fullNameLatin)}</div>` : ""}</td>
      <td>${escapeHtml(a.data.phone1||"—")}</td>
      <td>${escapeHtml(a.data.email||"—")}</td>
      <td>${fmtDateTime(a.submittedAt || a.updatedAt)}</td>
      <td><span class="status-chip ${a.status}">${statusLabel(a.status)}</span></td>
      <td><a href="#/admin-review/${a.id}" class="btn btn-outline btn-sm">مراجعة الملف</a></td>
      <td><a href="#/admin-audit/${a.id}" class="btn btn-outline btn-sm">🔍 شاشة التدقيق الجانبية</a></td>
    </tr>`;
  }).join("");
  const statusTabs = [
    ["all", "إجمالي الحسابات", totalAccounts, "var(--ink-soft)"],
    ["pending_review", "قيد المراجعة", counts.pending_review, "#1d5b93"],
    ["approved", "مقبولة", counts.approved, "var(--green-deep)"],
    ["rejected", "مرفوضة", counts.rejected, "var(--red-accent)"],
  ];
  const pagerBtn = (label, targetPage, disabled) => `<button type="button" class="btn btn-outline btn-sm" data-action="admin-apps-page" data-page="${targetPage}" ${disabled ? "disabled" : ""}>${label}</button>`;
  const pageNumbers = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pageNumbers.push(p);
  return `
  <div class="page">
    <div class="panel-header" style="border:none;margin-bottom:18px;">
      <h3 style="font-size:22px;">طلبات انخراط الحكام</h3>
      <a href="#/admin-users" class="btn btn-outline btn-sm">👥 كل الحسابات المسجَّلة (${totalAccounts})</a>
    </div>
    <div class="steps-strip" style="margin-top:0;margin-bottom:20px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
      ${statusTabs.map(([key,label,count,color])=>`
        <div class="step-mini" data-action="admin-apps-status" data-status="${key}" style="cursor:pointer;${ADMIN_APPS_STATE.status===key?'box-shadow:0 0 0 2px var(--green-deep);':''}">
          <div class="num" style="background:${color};">${count}</div><h4>${label}</h4>
        </div>`).join("")}
    </div>
    <div class="panel">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;">
        <div class="field" style="max-width:420px;flex:1;">
          <label>🔍 البحث عن حكم (بالاسم، الهاتف، أو البريد الإلكتروني)</label>
          <input type="text" id="admin-apps-search" placeholder="اكتب للبحث..." value="${escapeHtml(ADMIN_APPS_STATE.q)}">
        </div>
        <div class="field" style="max-width:160px;">
          <label>عدد النتائج</label>
          <select id="admin-apps-pagesize">
            ${[5,10,20,50].map(n=>`<option value="${n}" ${pageSize===n?'selected':''}>${n}</option>`).join("")}
          </select>
        </div>
      </div>
      ${apps.length===0 ? `<div class="empty"><div class="icon">📭</div><h3>لا توجد نتائج مطابقة</h3></div>` : `
      <div class="table-wrap"><table id="admin-apps-table">
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>البريد الإلكتروني</th><th>تاريخ الإرسال</th><th>الحالة</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;flex-wrap:wrap;gap:10px;">
        <span class="text-sm muted">عرض ${apps.length} من ${total} — الصفحة ${page} من ${totalPages}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${pagerBtn("« الأولى", 1, page===1)}
          ${pagerBtn("‹ السابقة", page-1, page===1)}
          ${pageNumbers.map(p=>`<button type="button" class="btn btn-sm ${p===page?'btn-primary':'btn-outline'}" data-action="admin-apps-page" data-page="${p}">${p}</button>`).join("")}
          ${pagerBtn("التالية ›", page+1, page===totalPages)}
          ${pagerBtn("الأخيرة »", totalPages, page===totalPages)}
        </div>
      </div>`}
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — ALL REGISTERED ACCOUNTS
   ============================================================ */
let ADMIN_USERS_STATE = { page: 1, pageSize: 20, status: "all", q: "", sort: "newest" };

async function pageAdminUsers(){
  const params = new URLSearchParams({
    page: ADMIN_USERS_STATE.page, pageSize: ADMIN_USERS_STATE.pageSize,
    status: ADMIN_USERS_STATE.status, sort: ADMIN_USERS_STATE.sort,
  });
  if (ADMIN_USERS_STATE.q) params.set("q", ADMIN_USERS_STATE.q);
  const { users, total, page, pageSize, totalPages, counts } = await api(`/admin/users?${params.toString()}`);

  const statusTabs = [
    ["all", "إجمالي الحسابات", counts.all, "var(--ink-soft)"],
    ["pending", "قيد المراجعة", counts.pending, "#1d5b93"],
    ["needs_edit", "يحتاج إلى تعديل", counts.needs_edit, "#7a5b1d"],
    ["active", "مفعّلة", counts.active, "var(--green-deep)"],
    ["rejected", "مرفوضة", counts.rejected, "var(--red-accent)"],
    ["disabled", "معطّلة", counts.disabled, "#8a1f1f"],
  ];

  const rows = users.map(u=>{
    const statusChipClass = u.accountStatus==='rejected' ? 'rejected' : u.accountStatus==='active' ? 'approved' : 'pending';
    const statusIcon = { pending:'🟠', needs_edit:'🔵', active:'🟢', rejected:'🔴' }[u.accountStatus] || '';
    return `<tr data-userid="${u.id}">
      <td>
        <span class="admin-user-view">${escapeHtml(u.fullNameAr)}${u.fullNameLatin ? `<div class="text-sm muted" dir="ltr" style="text-align:right;">${escapeHtml(u.fullNameLatin)}</div>` : ""}</span>
        <input class="admin-user-edit" data-field="fullNameAr" style="display:none;width:100%;" value="${escapeHtml(u.fullNameAr)}">
      </td>
      <td>
        <span class="admin-user-view">${escapeHtml(u.username)}</span>
        <input class="admin-user-edit" data-field="username" style="display:none;width:100%;" dir="ltr" value="${escapeHtml(u.username)}">
      </td>
      <td>${escapeHtml(u.email)}</td>
      <td dir="ltr" style="text-align:right;">${escapeHtml(u.phone||"—")}</td>
      <td>${fmtDateTime(u.createdAt)}</td>
      <td>
        <span class="status-chip ${statusChipClass}">${statusIcon} ${escapeHtml(u.accountStatusLabel||u.accountStatus)}</span>
        ${u.disabled ? `<div class="status-chip rejected" style="margin-top:4px;">🚫 معطّل إداريًا${u.disabledAt ? ` — ${fmtDate(u.disabledAt)}` : ""}</div>` : ""}
      </td>
      <td><span class="status-chip ${u.applicationStatus}">${statusLabel(u.applicationStatus)}</span></td>
      <td>${u.applicationId ? `<a href="#/admin-review/${u.applicationId}" class="btn btn-outline btn-sm">عرض الملف</a>` : `<span class="text-sm muted">لم يبدأ الاستمارة بعد</span>`}</td>
      <td>${u.accountStatus === "active"
          ? `<button type="button" class="btn btn-outline btn-sm" data-action="deactivate-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullNameAr)}">⏸ إعادة إلى قيد المراجعة</button>`
          : `<a href="#/admin-registration-review/${u.id}" class="btn btn-primary btn-sm">🔍 مراجعة التسجيل</a>`}</td>
      <td>${u.signatureLocked
          ? `<button type="button" class="btn btn-outline btn-sm" data-action="unlock-signature" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullNameAr)}" title="يسمح للحكم برسم إمضاء جديد بشكل استثنائي">🔓 فتح قفل التوقيع</button>`
          : `<span class="text-sm muted">—</span>`}</td>
      <td><button type="button" class="btn btn-outline btn-sm" data-action="chat-with-referee" data-userid="${u.id}">💬 محادثة</button></td>
      <td>
        <span class="admin-user-view-actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="edit-referee-start" data-userid="${u.id}">✏️ تعديل</button>
        </span>
        <span class="admin-user-edit-actions" style="display:none;">
          <button type="button" class="btn btn-primary btn-sm" data-action="edit-referee-save" data-userid="${u.id}">✓ حفظ</button>
          <button type="button" class="btn btn-outline btn-sm" data-action="edit-referee-cancel" data-userid="${u.id}">✕ إلغاء</button>
          <input class="admin-user-edit" data-field="password" type="password" placeholder="كلمة مرور جديدة (اختياري)" style="display:block;width:100%;margin-top:6px;">
        </span>
      </td>
      <td>${u.disabled
          ? `<button type="button" class="btn btn-outline btn-sm" data-action="enable-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullNameAr)}">✅ إعادة تفعيل</button>`
          : `<button type="button" class="btn btn-outline btn-sm" data-action="disable-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullNameAr)}">🚫 تعطيل</button>`}</td>
      <td><button type="button" class="btn btn-outline btn-sm" data-action="reset-password" data-userid="${u.id}" data-username="${escapeHtml(u.username)}" data-fullname="${escapeHtml(u.fullNameAr)}">🔑 إعادة تعيين كلمة السر</button></td>
      <td><button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullNameAr)}">🗑 حذف الحكم</button></td>
    </tr>`;
  }).join("");

  const pagerBtn = (label, targetPage, disabled) => `<button type="button" class="btn btn-outline btn-sm" data-action="admin-users-page" data-page="${targetPage}" ${disabled ? "disabled" : ""}>${label}</button>`;
  const pageNumbers = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pageNumbers.push(p);

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 18px;"><h3 style="font-size:22px;">جميع الحسابات المسجَّلة (${total})</h3></div>
    <div id="reset-password-result"></div>
    <div class="steps-strip" style="margin-bottom:20px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
      ${statusTabs.map(([key,label,count,color])=>`
        <div class="step-mini" data-action="admin-users-status" data-status="${key}" style="cursor:pointer;${ADMIN_USERS_STATE.status===key?'box-shadow:0 0 0 2px var(--green-deep);':''}">
          <div class="num" style="background:${color};">${count}</div><h4>${label}</h4>
        </div>`).join("")}
    </div>
    <div class="panel">
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;">
        <div class="field" style="max-width:420px;flex:1;">
          <label>🔍 البحث عن حكم (بالاسم، اسم المستخدم، أو البريد الإلكتروني)</label>
          <input type="text" id="admin-users-search" placeholder="اكتب للبحث..." value="${escapeHtml(ADMIN_USERS_STATE.q)}">
        </div>
        <div class="field" style="max-width:200px;">
          <label>الترتيب</label>
          <select id="admin-users-sort">
            <option value="newest" ${ADMIN_USERS_STATE.sort==='newest'?'selected':''}>الأحدث تسجيلًا</option>
            <option value="oldest" ${ADMIN_USERS_STATE.sort==='oldest'?'selected':''}>الأقدم تسجيلًا</option>
            <option value="last_activity" ${ADMIN_USERS_STATE.sort==='last_activity'?'selected':''}>آخر نشاط</option>
            <option value="approved_at" ${ADMIN_USERS_STATE.sort==='approved_at'?'selected':''}>تاريخ القبول</option>
            <option value="rejected_at" ${ADMIN_USERS_STATE.sort==='rejected_at'?'selected':''}>تاريخ الرفض</option>
            <option value="clarification_at" ${ADMIN_USERS_STATE.sort==='clarification_at'?'selected':''}>تاريخ طلب التوضيح</option>
            <option value="resubmitted_at" ${ADMIN_USERS_STATE.sort==='resubmitted_at'?'selected':''}>تاريخ إعادة الإرسال</option>
            <option value="name" ${ADMIN_USERS_STATE.sort==='name'?'selected':''}>الاسم</option>
          </select>
        </div>
        <div class="field" style="max-width:160px;">
          <label>عدد الحسابات</label>
          <select id="admin-users-pagesize">
            ${[5,10,20,50].map(n=>`<option value="${n}" ${pageSize===n?'selected':''}>${n}</option>`).join("")}
          </select>
        </div>
      </div>
      ${users.length===0 ? `<div class="empty"><div class="icon">🔍</div><h3>لا توجد نتائج مطابقة</h3></div>` : `
      <div class="table-wrap"><table id="admin-users-table">
        <thead><tr><th>الاسم الكامل</th><th>اسم المستخدم</th><th>البريد الإلكتروني</th><th>الهاتف</th><th>تاريخ إنشاء الحساب</th><th>حالة الحساب</th><th>حالة الملف</th><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;flex-wrap:wrap;gap:10px;">
        <span class="text-sm muted">عرض ${users.length} من ${total} — الصفحة ${page} من ${totalPages}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${pagerBtn("« الأولى", 1, page===1)}
          ${pagerBtn("‹ السابقة", page-1, page===1)}
          ${pageNumbers.map(p=>`<button type="button" class="btn btn-sm ${p===page?'btn-primary':'btn-outline'}" data-action="admin-users-page" data-page="${p}">${p}</button>`).join("")}
          ${pagerBtn("التالية ›", page+1, page===totalPages)}
          ${pagerBtn("الأخيرة »", totalPages, page===totalPages)}
        </div>
      </div>`}
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — AUDIT LOG (سجل التعديلات): every change to a referee's core
   data (name, email, phone, rank, season…), whoever made it — the
   referee, the admin, or an approved edit request — with old/new value,
   who, when, and why.
   ============================================================ */
const AUDIT_SOURCE_LABELS = {
  self_edit: "الحكم عدّل بنفسه",
  admin_edit: "تعديل مباشر من الإدارة",
  edit_request: "طلب تعديل معلومة (وافقت عليه الإدارة)",
  system_sync: "تصحيح تلقائي (توحيد مصدر البيانات)",
};
async function pageAdminChangeLog(){
  const { entries, total } = await api("/admin/audit-log");
  const rows = entries.map(e=>{
    const searchStr = [e.fieldLabel, e.changedByName, e.reason].filter(Boolean).join(" ").toLowerCase();
    return `<tr data-search="${escapeHtml(searchStr)}">
      <td>${fmtDate(e.at)}</td>
      <td>${escapeHtml(e.fieldLabel)}</td>
      <td class="text-sm muted" style="max-width:220px;word-break:break-word;">${escapeHtml(e.oldValue==null?'—':String(e.oldValue))}</td>
      <td style="max-width:220px;word-break:break-word;">${escapeHtml(e.newValue==null?'—':String(e.newValue))}</td>
      <td><span class="status-chip ${e.changedBy==='admin'?'approved':'pending'}">${AUDIT_SOURCE_LABELS[e.source]||e.source}</span></td>
      <td>${escapeHtml(e.changedByName||'—')}</td>
      <td class="text-sm muted" style="max-width:220px;word-break:break-word;">${escapeHtml(e.reason||'—')}</td>
    </tr>`;
  }).join("");
  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 18px;"><h3 style="font-size:22px;">📜 سجل التعديلات (${total})</h3></div>
    <div class="panel">
      <p class="muted text-sm" style="margin-top:0;">كل تعديل على بيانات أي حكم — الاسم، البريد، الهاتف، الرتبة، وغيرها — سواء عدّله الحكم نفسه، أو الإدارة مباشرة، أو عبر طلب تعديل معلومة تمت الموافقة عليه.</p>
      <div class="field" style="max-width:420px;">
        <label>🔍 البحث (بالحقل، أو اسم من قام بالتعديل، أو السبب)</label>
        <input type="text" id="admin-changelog-search" placeholder="اكتب للبحث...">
      </div>
      ${entries.length===0 ? `<div class="empty"><div class="icon">📜</div><h3>لا توجد أي تعديلات مسجَّلة بعد</h3></div>` : `
      <div class="table-wrap"><table id="admin-changelog-table">
        <thead><tr><th>التاريخ</th><th>الحقل</th><th>القيمة القديمة</th><th>القيمة الجديدة</th><th>نوع العملية</th><th>من قام بالتعديل</th><th>السبب</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div id="admin-changelog-empty" class="empty" style="display:none;"><div class="icon">🔍</div><h3>لا توجد نتائج مطابقة</h3></div>`}
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — REFEREE REQUESTS (absence / special)
   ============================================================ */
function adminRequestEditFormHtml(r){
  if(r.type === 'absence'){
    return `<form data-admin-request-edit-form="${r.id}" data-req-type="absence">
      <div class="row2">
        <div class="field"><label>من تاريخ</label><input type="date" name="dateFrom" value="${r.dateFrom||''}" required></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" name="dateTo" value="${r.dateTo||''}" required></div>
      </div>
      <div class="field"><label>سبب الغياب</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
      <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ</button><button type="button" class="btn btn-ghost btn-sm" data-action="admin-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
    </form>`;
  }
  if(r.type === 'special'){
    return `<form data-admin-request-edit-form="${r.id}" data-req-type="special">
      <div class="field"><label>عنوان الطلب</label><input type="text" name="title" value="${escapeHtml(r.title||'')}" required></div>
      <div class="field"><label>تفاصيل الطلب</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
      <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ</button><button type="button" class="btn btn-ghost btn-sm" data-action="admin-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
    </form>`;
  }
  if(r.type === 'edit'){
    const fm = findFieldMeta(r.fieldKey);
    return `<form data-admin-request-edit-form="${r.id}" data-req-type="edit">
      <div class="field"><label>القيمة الجديدة لـ «${fm?fm.label:r.fieldKey}»</label><input type="text" name="newValue" value="${escapeHtml(r.newValue||'')}" required></div>
      <div class="field"><label>السبب</label><textarea name="details" required>${escapeHtml(r.details||'')}</textarea></div>
      <div class="flex gap-12"><button type="submit" class="btn btn-primary btn-sm">حفظ</button><button type="button" class="btn btn-ghost btn-sm" data-action="admin-request-cancel-edit" data-reqid="${r.id}">إلغاء</button></div>
    </form>`;
  }
  return "";
}

async function pageAdminRequests(){
  const { requests } = await api("/admin/requests");
  CACHE.adminRequests = requests;
  const pending = requests.filter(r=>r.status==='pending' || r.status==='needs_clarification');
  const decided = requests.filter(r=>r.status==='approved' || r.status==='rejected');

  function rowHtml(r){
    let bodyHtml = "";
    if(r.type==='special'){
      bodyHtml = `<div class="mt-8"><b>${escapeHtml(r.title)}</b></div><p class="mt-8">${escapeHtml(r.details)}</p>`;
    } else if(r.type==='absence'){
      bodyHtml = `<div class="mt-8 text-sm"><b>من:</b> ${escapeHtml(r.dateFrom)} &nbsp; <b>إلى:</b> ${escapeHtml(r.dateTo)}</div><p class="mt-8">${escapeHtml(r.details)}</p>
        ${r.attachment ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger mt-8" data-zoom-url="${r.attachment.url}" data-zoom-mime="${r.attachment.mimetype||''}" data-zoom-title="تبرير الغياب">🔍 عرض تبرير الغياب</button>` : ''}`;
    } else if(r.type==='edit'){
      const fm = findFieldMeta(r.fieldKey);
      bodyHtml = `<div class="mt-8 text-sm"><b>${fm?fm.label:r.fieldKey}:</b> ${escapeHtml(r.oldValue||'—')} ← <span style="color:var(--green-deep);font-weight:800;">${escapeHtml(r.newValue||'')}</span></div><p class="mt-8">${escapeHtml(r.details)}</p>`;
    }
    const isFinal = r.status === 'approved' || r.status === 'rejected';
    return `<div class="panel" style="margin-top:14px;">
      <div class="panel-header">
        <h3>${requestTypeLabel(r)} — ${escapeHtml(r.refereeName)}</h3>
        <span class="status-chip ${requestStatusChipClass(r.status)}">${requestStatusLabel(r.status)}</span>
      </div>
      <div class="text-sm muted">اسم المستخدم: ${escapeHtml(r.refereeUsername)} — تاريخ الإرسال: ${fmtDate(r.createdAt)}</div>
      ${bodyHtml}
      ${isFinal ? `<div class="text-sm mt-8"><b>القرار النهائي:</b> ${requestStatusLabel(r.status)}${r.decidedAt ? ' بتاريخ '+fmtDate(r.decidedAt) : ''} — الطلب مغلق ولا يمكن للحكم تعديله.</div>` : ""}
      <div class="field"><label>ملاحظة (تظهر للحكم — مطلوبة عند «طلب توضيح» أو «رفض»)</label><textarea data-admin-request-note="${r.id}" placeholder="ملاحظة للحكم...">${escapeHtml(r.adminNote||"")}</textarea></div>
      <div class="flex gap-12 mt-8" style="flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" data-action="request-approve" data-reqid="${r.id}" ${isFinal?'disabled':''}>✓ قبول</button>
        <button class="btn btn-danger btn-sm" data-action="request-reject" data-reqid="${r.id}" ${isFinal?'disabled':''}>✕ رفض</button>
        <button class="btn btn-outline btn-sm" data-action="request-clarify" data-reqid="${r.id}" ${isFinal?'disabled':''}>🔵 طلب توضيح/تعديل</button>
        ${isFinal ? `<button class="btn btn-outline btn-sm" data-action="request-revoke" data-reqid="${r.id}">↩ إعادة لقيد المراجعة</button>` : ""}
        <button class="btn btn-outline btn-sm" data-action="admin-request-edit-toggle" data-reqid="${r.id}">✎ تعديل الطلب</button>
        <button class="btn btn-danger-outline btn-sm" data-action="admin-request-delete" data-reqid="${r.id}">🗑 حذف الطلب</button>
      </div>
      <div id="admin-request-edit-form-${r.id}" style="display:none;" class="mt-16"></div>
      ${requestTimelineHtml(r)}
    </div>`;
  }

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 0;"><h3 style="font-size:22px;">طلبات الحكام (غياب، خاصة، وتعديل معلومة)</h3></div>
    <div id="admin-request-error"></div>
    ${requests.length===0 ? `<div class="panel mt-16"><div class="empty"><div class="icon">📭</div><h3>لا توجد طلبات من الحكام بعد</h3></div></div>` : `
      <div class="section-title" style="margin-top:20px;">قيد المراجعة أو بانتظار توضيح (${pending.length})</div>
      ${pending.length===0 ? `<p class="text-sm muted">لا توجد طلبات معلَّقة حاليًا.</p>` : pending.map(rowHtml).join("")}
      ${decided.length ? `<div class="section-title" style="margin-top:28px;">تم البت فيها نهائيًا</div>${decided.map(rowHtml).join("")}` : ""}
    `}
  </div>`;
}

/* ============================================================
   ADMIN — REVIEW SINGLE APPLICATION
   ============================================================ */
// ---- Shared "قرار المراجعة" decision panel — used verbatim by both the
// classic pageAdminReview() and the new split-screen pageAdminAudit(), so
// there is exactly one approve/reject mechanism in the codebase, not two.
// Both pages wire the SAME data-action="admin-approve"/"admin-reject"
// handlers (see attachGlobalHandlers), driven by the SAME REVIEW_DRAFT —
// the audit screen is a different way of reaching this same decision, not
// a parallel one. `opts.heading` lets the audit screen frame it as
// "إنهاء التدقيق" without changing anything functional.
function reviewDecisionPanelHtml(app, opts){
  opts = opts || {};
  const hasFlags = Object.keys(REVIEW_DRAFT.flags).length>0 || Object.keys(REVIEW_DRAFT.docFlags).length>0;
  const canDecide = app.status === "pending_review";
  return `
    <div class="panel no-print" id="review-decision-panel">
      <div class="panel-header"><h3>${opts.heading || 'قرار المراجعة'}</h3></div>
      <div id="review-error"></div>
      ${app.status === "approved" ? `
        <div class="info-msg">تمت الموافقة على هذا الملف وصدرت وثيقة انخراطه بتاريخ ${fmtDate(app.approvedAt)}.</div>
      ` : !canDecide ? `<div class="info-msg">هذا الملف لم يعد في وضع "قيد المراجعة"، ولا يمكن اتخاذ قرار جديد بشأنه.</div>` :
        hasFlags ? `<div class="info-msg">تم وضع ${Object.keys(REVIEW_DRAFT.flags).length + Object.keys(REVIEW_DRAFT.docFlags).length} ملاحظة/ملاحظات. لا يمكن قبول الملف طالما توجد ملاحظات — يمكنك رفضه مع إرسال الملاحظات للحكم.</div>`
                 : `<div class="info-msg">لا توجد ملاحظات مسجّلة. يمكنك قبول الملف مباشرة.</div>`}
      ${app.status !== "approved" ? `
      <div class="field">
        <label>ملاحظة عامة (اختياري، تظهر للحكم عند الرفض)</label>
        <textarea id="rejection-summary" placeholder="مثال: يرجى تصحيح المعلومات المشار إليها أدناه وإعادة رفع الوثائق الناقصة." ${canDecide?'':'disabled'}>${escapeHtml(app.rejectionSummary||"")}</textarea>
      </div>
      <div class="flex gap-12 mt-16">
        <button class="btn btn-primary" data-action="admin-approve" ${(!canDecide || hasFlags)?'disabled':''}>✓ إنهاء التدقيق وقبول الملف</button>
        <button class="btn btn-danger" data-action="admin-reject" ${(!canDecide || !hasFlags)?'disabled':''}>✕ إنهاء التدقيق ورفض الملف مع الملاحظات</button>
      </div>` : `
      <div class="flex gap-12 mt-16">
        <button class="btn btn-danger-outline" data-action="admin-revoke" data-appid="${app.id}">↩ التراجع عن الموافقة وإعادة الملف للمراجعة</button>
      </div>`}
      ${app.reviewedByUsername ? `<p class="text-sm muted mt-8">آخر تدقيق بواسطة: ${escapeHtml(app.reviewedByUsername)} — ${fmtDate(app.reviewedAt)}</p>` : ""}
    </div>`;
}

async function pageAdminReview(appId){
  const { application: app, refereeSignature } = await api("/admin/applications/" + appId);
  const docReqs = await ensureDocRequirements();
  if(!REVIEW_DRAFT || REVIEW_DRAFT.id !== appId){
    REVIEW_DRAFT = { id: appId, flags: {...(app.flags||{})}, docFlags: {...(app.docFlags||{})} };
    ADMIN_EDIT_MODE = false;
  }
  const fieldsHtml = FIELD_GROUPS.map(g=>`
    <div class="section-title">${g.title}</div>
    ${g.fields.map(f=>{
      if(ADMIN_EDIT_MODE){
        return `<div class="review-field">
          <div style="flex:1;">
            <div class="rf-label">${f.label}</div>
            <input type="text" name="${f.key}" data-admin-edit-field value="${escapeHtml(app.data[f.key]||'')}" style="margin-top:4px;">
          </div>
        </div>`;
      }
      const flagged = REVIEW_DRAFT.flags[f.key]!==undefined;
      return `<div class="review-field">
        <div style="flex:1;">
          <div class="rf-label">${f.label}</div>
          <div class="rf-value">${escapeHtml(app.data[f.key]||"—")}</div>
          ${flagged ? `<div class="flag-note"><textarea data-flag-note="${f.key}" placeholder="سبب الرفض...">${escapeHtml(REVIEW_DRAFT.flags[f.key]||"")}</textarea></div>` : ""}
        </div>
        <button type="button" class="flag-toggle ${flagged?'on':''}" data-action="toggle-flag" data-field="${f.key}">${flagged?'✕ ملاحظة مسجّلة':'وضع ملاحظة'}</button>
      </div>`;
    }).join("")}
  `).join("");

  const docsHtml = docReqs.map(d=>{
    const val = app.documents[d.id];
    const flagged = REVIEW_DRAFT.docFlags[d.id]!==undefined;
    return `<div class="review-field">
      <div style="flex:1;">
        <div class="rf-label">${escapeHtml(d.title)}${d.isRequired?'':' (اختياري)'}</div>
        ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img src="${val.url}" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--line);margin-top:6px;">` : `<div class="rf-value">📎 <a href="${val.url}" target="_blank">${escapeHtml(val.originalName||'ملف مرفق')}</a></div>`) : `<div class="rf-value" style="color:${d.isRequired?'var(--red-accent)':'inherit'};">${d.isRequired ? '⚠ لم يتم الرفع' : '—'}</div>`}
        ${val ? `<div class="mt-8"><button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d.title)}">🔍 عرض للمراجعة والتدقيق</button></div>` : ""}
        ${flagged ? `<div class="flag-note"><textarea data-flag-doc-note="${d.id}" placeholder="سبب الرفض...">${escapeHtml(REVIEW_DRAFT.docFlags[d.id]||"")}</textarea></div>` : ""}
      </div>
      <button type="button" class="flag-toggle ${flagged?'on':''}" data-action="toggle-doc-flag" data-doc="${d.id}">${flagged?'✕ ملاحظة مسجّلة':'وضع ملاحظة'}</button>
    </div>`;
  }).join("");

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm no-print">→ عودة إلى القائمة</a>
    <div class="panel mt-16 no-print">
      <div class="panel-header">
        <h3>ملف: ${escapeHtml(app.data.fullNameAr)}</h3>
        <div class="flex gap-8">
          <span class="status-chip ${app.status}">${statusLabel(app.status)}</span>
          <a href="#/admin-audit/${app.id}" class="btn btn-outline btn-sm">🖥 شاشة المراجعة والتدقيق الجانبية</a>
          <button type="button" class="btn btn-outline btn-sm" data-action="admin-edit-toggle">${ADMIN_EDIT_MODE ? '✕ إلغاء التعديل' : '✎ تعديل معلومات الحكم'}</button>
        </div>
      </div>
      <div class="row2 text-sm muted"><div>تاريخ الإرسال: ${fmtDate(app.submittedAt)}</div><div>الموسم: ${app.season}</div></div>
      <div id="admin-edit-error"></div>
      <form id="admin-edit-fields-form">
        ${fieldsHtml}
        ${ADMIN_EDIT_MODE ? `<button type="submit" class="btn btn-primary mt-16">💾 حفظ التعديلات</button>` : ""}
      </form>
      <div class="section-title">الوثائق</div>
      ${docsHtml}
    </div>
    ${reviewDecisionPanelHtml(app)}
    ${app.status === "approved" ? `
    <div class="panel">
      <div class="panel-header no-print"><h3>وثيقة الانخراط الصادرة</h3></div>
      ${certificateHtml(app, refereeSignature ? { signature: refereeSignature } : null)}
      <div class="cert-actions no-print">
        <button class="btn btn-primary" onclick="window.print()">🖨 طباعة / تنزيل PDF</button>
      </div>
    </div>` : ""}
  </div>`;
}


/* ============================================================
   ADMIN — Document requirements management (dynamic document list)
   ============================================================ */
let ADMIN_DOC_REQ_EDIT_ID = null; // id of the requirement currently shown in inline-edit mode, if any

// Icons here are plain emoji (consistent with the rest of the app's visual
// language — 🪪📄🆔🎓💳 already used across the platform) rather than an
// icon-font/component library like Lucide or Font Awesome, since this
// project ships as plain HTML/CSS/JS with no build step or bundler that
// icon-font packages would need. The admin can also type/paste any other
// single emoji into the "رمز مخصص" field below if none of the presets fit.
const DOC_ICON_PRESETS = [
  { value:"🪪", label:"🪪 بطاقة / صورة شخصية" },
  { value:"🆔", label:"🆔 بطاقة التعريف" },
  { value:"📜", label:"📜 شهادة (ميلاد / مؤهل)" },
  { value:"🎓", label:"🎓 مؤهل علمي" },
  { value:"🩺", label:"🩺 ملف طبي" },
  { value:"💳", label:"💳 بطاقة بريدية / بنكية" },
  { value:"✍️", label:"✍️ تعهد / إمضاء" },
  { value:"📋", label:"📋 استمارة" },
  { value:"📸", label:"📸 صورة شمسية" },
  { value:"📄", label:"📄 وثيقة عامة" },
  { value:"📎", label:"📎 افتراضي" },
];
function docIconPickerHtml(idSuffix, currentIcon){
  const cur = currentIcon || "📎";
  const isPreset = DOC_ICON_PRESETS.some(p=>p.value===cur);
  return `
    <div class="field">
      <label>أيقونة الوثيقة</label>
      <div class="flex gap-8" style="align-items:center;">
        <span class="icon-preview" id="doc-req-icon-preview-${idSuffix}" style="font-size:26px;width:42px;height:42px;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--line-strong);border-radius:10px;background:#fff;flex-shrink:0;">${cur}</span>
        <select name="icon" id="doc-req-icon-select-${idSuffix}" style="flex:1;">
          ${DOC_ICON_PRESETS.map(p=>`<option value="${p.value}" ${isPreset && cur===p.value ? 'selected':''}>${p.label}</option>`).join("")}
        </select>
      </div>
      <input type="text" name="iconCustom" id="doc-req-icon-custom-${idSuffix}" placeholder="أو أدخل رمزًا (إيموجي) مخصصًا هنا — اختياري" maxlength="8" style="margin-top:8px;" value="${!isPreset ? escapeHtml(cur) : ''}">
      <p class="hint">اختر أيقونة جاهزة من القائمة، أو اكتب رمزًا مخصصًا فيُستخدم بدلاً منها. تظهر هذه الأيقونة للحكم أعلى مربع رفع هذه الوثيقة.</p>
    </div>`;
}

function docRequirementRowHtml(d, editing){
  if(editing){
    return `<div class="panel mt-16" id="doc-req-row-${d.id}">
      <form data-doc-req-edit-form="${d.id}">
        <div id="doc-req-edit-error-${d.id}"></div>
        <div class="field"><label>عنوان الوثيقة *</label><input type="text" name="title" value="${escapeHtml(d.title)}" required></div>
        <div class="field"><label>الوصف المختصر (اختياري)</label><textarea name="description">${escapeHtml(d.description||"")}</textarea></div>
        ${docIconPickerHtml(d.id, d.icon)}
        <div class="field">
          <label class="radio-opt" style="display:inline-flex;"><input type="checkbox" name="isRequired" ${d.isRequired?'checked':''}> وثيقة إجبارية (لا يمكن إرسال الملف بدونها)</label>
        </div>
        <div class="field">
          <label class="radio-opt" style="display:inline-flex;"><input type="checkbox" name="hasTemplate" id="doc-req-hastemplate-${d.id}" ${d.hasTemplate?'checked':''}> إضافة نموذج PDF جاهز للتحميل</label>
        </div>
        <div class="field" id="doc-req-template-field-${d.id}" style="${d.hasTemplate?'':'display:none;'}">
          <label>ملف النموذج (PDF)</label>
          ${d.hasTemplate && d.templateUrl ? `<p class="text-sm muted">الملف الحالي: <a href="${d.templateUrl}" target="_blank" rel="noopener">${escapeHtml(d.templateOriginalName||'عرض الملف')}</a></p>` : ""}
          <input type="file" name="template" accept="application/pdf">
          <p class="hint">${d.hasTemplate && d.templateUrl ? 'اترك هذا الحقل فارغًا للإبقاء على الملف الحالي، أو اختر ملفًا جديدًا لاستبداله.' : 'يلزم إرفاق ملف PDF عند تفعيل هذا الخيار.'}</p>
        </div>
        <div class="flex gap-12 mt-16">
          <button type="submit" class="btn btn-primary btn-sm">💾 حفظ</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="doc-req-cancel-edit">إلغاء</button>
        </div>
      </form>
    </div>`;
  }
  return `<div class="review-field" id="doc-req-row-${d.id}">
    <div style="flex:1;">
      <div class="rf-label"><span style="font-size:18px;margin-inline-end:6px;">${d.icon||'📎'}</span>${escapeHtml(d.title)} ${d.isRequired ? '<span class="status-chip rejected" style="font-size:11px;">إجبارية</span>' : '<span class="status-chip pending" style="font-size:11px;">اختيارية</span>'}</div>
      ${d.description ? `<div class="rf-value text-sm muted">${escapeHtml(d.description)}</div>` : ""}
      ${d.hasTemplate && d.templateUrl ? `<div class="rf-value text-sm"><a href="${d.templateUrl}" target="_blank" rel="noopener">📄 نموذج PDF مرفق: ${escapeHtml(d.templateOriginalName||'عرض')}</a></div>` : `<div class="rf-value text-sm muted">بدون نموذج — رفع مباشر من الحكم</div>`}
    </div>
    <div class="flex gap-8">
      <button type="button" class="btn btn-outline btn-sm" data-action="doc-req-edit" data-id="${d.id}">✎ تعديل</button>
      <button type="button" class="btn btn-danger-outline btn-sm" data-action="doc-req-delete" data-id="${d.id}" data-title="${escapeHtml(d.title)}">🗑 حذف</button>
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — Side-by-side review & audit screen (شاشة المراجعة والتدقيق)
   Referee info (right, since the whole app is dir="rtl" — the first DOM
   child of a row lands on the right for free) stays fixed while the admin
   flips through documents (left) one at a time in a persistent preview
   pane, without leaving the page. Decision-making (approve/reject) is the
   exact same reviewDecisionPanelHtml()/REVIEW_DRAFT mechanism the classic
   pageAdminReview() uses — this screen is a different way of reaching it,
   not a second one.
   ============================================================ */
let AUDIT_APP_ID = null;       // which application's audit state AUDIT_ACTIVE_DOC/AUDIT_MOBILE_TAB below belong to
let AUDIT_ACTIVE_DOC = null;   // document requirement id currently shown in the preview pane
let AUDIT_MOBILE_TAB = "docs"; // "info" | "docs" — which tab is visible on phone/tablet
let AUDIT_IMG_ZOOM = 1;
let AUDIT_IMG_PAN = { x: 0, y: 0 };

function auditDocStatusOf(app, d){
  // A rejected mark always tracks the live REVIEW_DRAFT (the actual
  // decision-blocking state), not just whatever was last saved to the
  // server — so toggling it here and toggling it from the classic review
  // screen never disagree.
  if(REVIEW_DRAFT && REVIEW_DRAFT.docFlags[d.id] !== undefined) return "rejected";
  const m = (app.docReviewMarks || {})[d.id];
  return m ? m.status : "unreviewed";
}
const AUDIT_STATUS_META = {
  unreviewed:   { label:"لم تُراجع بعد", cls:"" },
  ok:           { label:"✅ مطابقة",     cls:"audit-doc-ok" },
  needs_review: { label:"⚠️ تحتاج مراجعة", cls:"audit-doc-warn" },
  rejected:     { label:"❌ مرفوضة",     cls:"audit-doc-bad" },
};

function auditPreviewInnerHtml(app, doc){
  if(!doc){
    return `<div class="audit-preview-empty text-sm muted">لا توجد وثائق معرّفة بعد.</div>`;
  }
  const val = app.documents[doc.id];
  if(!val){
    return `<div class="audit-preview-empty">
      <div style="font-size:38px;">📭</div>
      <p class="text-sm muted">لم يرفع الحكم هذه الوثيقة (${escapeHtml(doc.title)}).</p>
    </div>`;
  }
  if(val.mimetype && val.mimetype.startsWith("image")){
    return `
      <div class="audit-img-wrap" id="audit-img-wrap">
        <img src="${val.url}" id="audit-img" class="audit-img" draggable="false" alt="${escapeHtml(doc.title)}">
      </div>
      <div class="audit-zoom-controls no-print">
        <button type="button" class="btn btn-outline btn-sm" data-action="audit-zoom-out" title="تصغير">➖</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="audit-zoom-reset" title="الحجم الأصلي">1:1</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="audit-zoom-in" title="تكبير">➕</button>
        <span class="text-sm muted" style="align-self:center;">اسحب الصورة للتحريك بعد التكبير</span>
      </div>`;
  }
  // PDFs and any other non-image file: an <iframe> uses the browser's own
  // PDF viewer, which already gives zoom, panning, and page-by-page
  // navigation for multi-page documents at no extra implementation cost.
  return `<iframe src="${val.url}#toolbar=1" class="audit-pdf-frame" title="${escapeHtml(doc.title)}"></iframe>`;
}

async function pageAdminAudit(appId){
  const { application: app } = await api("/admin/applications/" + appId);
  const docReqs = await ensureDocRequirements();
  if(!REVIEW_DRAFT || REVIEW_DRAFT.id !== appId){
    REVIEW_DRAFT = { id: appId, flags: {...(app.flags||{})}, docFlags: {...(app.docFlags||{})} };
  }
  if(AUDIT_APP_ID !== appId){
    AUDIT_APP_ID = appId;
    const firstWithFile = docReqs.find(d=>app.documents[d.id]);
    AUDIT_ACTIVE_DOC = firstWithFile ? firstWithFile.id : (docReqs[0] ? docReqs[0].id : null);
    AUDIT_MOBILE_TAB = "docs";
    AUDIT_IMG_ZOOM = 1;
    AUDIT_IMG_PAN = { x:0, y:0 };
  }

  const marks = app.docReviewMarks || {};
  const reviewedCount = docReqs.filter(d=>app.documents[d.id] && auditDocStatusOf(app,d)!=="unreviewed").length;
  const uploadedCount = docReqs.filter(d=>app.documents[d.id]).length;

  const doclistHtml = docReqs.map(d=>{
    const has = !!app.documents[d.id];
    const st = auditDocStatusOf(app, d);
    const meta = AUDIT_STATUS_META[st];
    const active = d.id === AUDIT_ACTIVE_DOC;
    return `<button type="button" class="audit-doc-item ${active?'active':''} ${meta.cls}" data-action="audit-select-doc" data-doc="${d.id}" ${has?'':'disabled'}>
      <span class="audit-doc-icon">${d.icon||'📎'}</span>
      <span class="audit-doc-title">${escapeHtml(d.title)}${d.isRequired?'':' <span class="text-sm muted">(اختياري)</span>'}</span>
      <span class="audit-doc-badge">${has ? meta.label : '⚠ لم يُرفع'}</span>
    </button>`;
  }).join("");

  const activeDoc = docReqs.find(d=>d.id===AUDIT_ACTIVE_DOC) || null;
  const activeHasFile = activeDoc && !!app.documents[activeDoc.id];
  const activeStatus = activeDoc ? auditDocStatusOf(app, activeDoc) : null;
  const activeNote = activeDoc ? (REVIEW_DRAFT.docFlags[activeDoc.id] ?? (marks[activeDoc.id] && marks[activeDoc.id].note) ?? "") : "";

  const statusBarHtml = activeHasFile ? `
    <div class="audit-status-bar no-print">
      <div class="flex gap-8" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-sm ${activeStatus==='ok'?'btn-primary':'btn-outline'}" data-action="audit-mark" data-status="ok">✅ تمت المطابقة والتدقيق</button>
        <button type="button" class="btn btn-sm ${activeStatus==='needs_review'?'btn-primary':'btn-outline'}" data-action="audit-mark" data-status="needs_review">⚠️ تحتاج إلى مراجعة</button>
        <button type="button" class="btn btn-sm ${activeStatus==='rejected'?'btn-danger':'btn-danger-outline'}" data-action="audit-mark" data-status="rejected">❌ غير مطابقة / مرفوضة</button>
      </div>
      ${activeStatus==='rejected' ? `<textarea id="audit-reject-note" class="mt-8" placeholder="سبب الرفض... (تظهر هذه الملاحظة للحكم)">${escapeHtml(activeNote)}</textarea>` : ""}
    </div>` : "";

  const infoFieldsHtml = FIELD_GROUPS.map(g=>`
    <div class="section-title">${g.title}</div>
    ${g.fields.map(f=>`<div class="review-field"><div style="flex:1;"><div class="rf-label">${f.label}</div><div class="rf-value">${escapeHtml(app.data[f.key]||"—")}</div></div></div>`).join("")}
  `).join("");

  return `
  <div class="page audit-page">
    <a href="#/admin-review/${app.id}" class="btn btn-ghost btn-sm no-print">→ العودة إلى شاشة المراجعة التفصيلية</a>
    <div class="audit-topbar no-print">
      <h3>🔍 شاشة المراجعة والتدقيق — ${escapeHtml(app.data.fullNameAr)}</h3>
      <div class="flex gap-8" style="align-items:center;">
        <span class="text-sm muted">تدقيق الوثائق: ${reviewedCount}/${uploadedCount}</span>
        <span class="status-chip ${app.status}">${statusLabel(app.status)}</span>
      </div>
    </div>
    <div class="audit-mobile-tabs no-print">
      <button type="button" class="audit-tab-btn ${AUDIT_MOBILE_TAB==='info'?'active':''}" data-action="audit-tab" data-tab="info">📋 معلومات الحكم</button>
      <button type="button" class="audit-tab-btn ${AUDIT_MOBILE_TAB==='docs'?'active':''}" data-action="audit-tab" data-tab="docs">📎 الوثائق</button>
    </div>
    <div class="audit-split">
      <div class="audit-info-pane ${AUDIT_MOBILE_TAB==='info'?'audit-mobile-visible':''}">
        <div class="panel">
          <div class="panel-header"><h3>معلومات الحكم</h3></div>
          <div class="row2 text-sm muted"><div>تاريخ الإرسال: ${fmtDate(app.submittedAt)}</div><div>الموسم: ${app.season}</div></div>
          ${infoFieldsHtml}
        </div>
      </div>
      <div class="audit-docs-pane ${AUDIT_MOBILE_TAB==='docs'?'audit-mobile-visible':''}">
        <div class="panel audit-doclist-panel">
          <div class="panel-header"><h3>الوثائق (${uploadedCount}/${docReqs.length} مرفوعة)</h3></div>
          <div class="audit-doclist">${doclistHtml || '<p class="text-sm muted">لا توجد وثائق معرّفة.</p>'}</div>
        </div>
        <div class="panel audit-preview-panel">
          <div class="panel-header"><h3>${activeDoc ? escapeHtml(activeDoc.title) : 'معاينة الوثيقة'}</h3></div>
          <div class="audit-preview" id="audit-preview">${auditPreviewInnerHtml(app, activeDoc)}</div>
          ${statusBarHtml}
        </div>
      </div>
    </div>
    ${reviewDecisionPanelHtml(app, { heading:'إنهاء التدقيق' })}
  </div>`;
}

async function pageAdminDocRequirements(){
  let list;
  try{ const res = await api("/admin/document-requirements"); list = res.documentRequirements; }
  catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }
  CACHE.docRequirements = list; // keep the referee-facing cache in sync with what the admin sees

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 0;"><h3 style="font-size:22px;">إدارة وثائق الانخراط المطلوبة</h3></div>
    <p class="text-sm muted" style="margin:4px 0 16px;">حدِّد هنا قائمة الوثائق التي يجب على الحكام رفعها عند الانخراط. يمكنك إضافة/تعديل/حذف وثيقة، وجعلها إجبارية أو اختيارية، وإرفاق نموذج PDF جاهز للتحميل عند الحاجة (مثل استمارة الفحص الطبي أو تعهد شرفي).</p>

    <div class="panel">
      <div class="panel-header"><h3>➕ إضافة وثيقة جديدة</h3></div>
      <div id="doc-req-add-error"></div>
      <form id="doc-req-add-form">
        <div class="field"><label>عنوان الوثيقة *</label><input type="text" name="title" placeholder="مثال: الملف الطبي" required></div>
        <div class="field"><label>الوصف المختصر (اختياري)</label><textarea name="description" placeholder="توضيح مختصر يظهر للحكم"></textarea></div>
        ${docIconPickerHtml('new', '📎')}
        <div class="field">
          <label class="radio-opt" style="display:inline-flex;"><input type="checkbox" name="isRequired" checked> وثيقة إجبارية (لا يمكن إرسال الملف بدونها)</label>
        </div>
        <div class="field">
          <label class="radio-opt" style="display:inline-flex;"><input type="checkbox" name="hasTemplate" id="doc-req-add-hastemplate"> إضافة نموذج PDF جاهز للتحميل</label>
        </div>
        <div class="field" id="doc-req-add-template-field" style="display:none;">
          <label>ملف النموذج (PDF) *</label>
          <input type="file" name="template" accept="application/pdf">
          <p class="hint">مثال: استمارة الفحص الطبي، تعهد شرفي. سيظهر للحكم زر "تحميل النموذج" ليطبعه ويعبئه ثم يعيد رفعه.</p>
        </div>
        <button type="submit" class="btn btn-primary mt-16">➕ إضافة الوثيقة</button>
      </form>
    </div>

    <div class="section-title" style="margin-top:24px;">الوثائق الحالية (${list.length})</div>
    ${list.length===0 ? `<div class="panel"><div class="empty"><div class="icon">📭</div><h3>لا توجد أي وثيقة مضافة بعد</h3></div></div>`
      : `<div class="panel">${list.map(d => docRequirementRowHtml(d, ADMIN_DOC_REQ_EDIT_ID===d.id)).join("")}</div>`}
  </div>`;
}

/* ============================================================
   ADMIN — Registration control panel
   ============================================================ */
async function pageAdminSettings(){
  let settings, siteStatus;
  try{
    settings = await api("/admin/settings/registration");
    siteStatus = await api("/admin/settings/site-status");
  }
  catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }

  const isTimer = settings.registration_mode === "timer";
  const deadlineLocal = settings.registration_deadline ? isoToDatetimeLocal(settings.registration_deadline) : "";

  return `
  <div class="page page-narrow">
    <div class="panel-header"><h3>⚙ إعدادات الموقع</h3></div>
    <div class="panel">
      <div id="site-status-error"></div>
      <div id="site-status-info"></div>
      <div class="field">
        <label>حالة الموقع</label>
        <div class="switch-row">
          <label class="switch">
            <input type="checkbox" id="site-enabled-switch" ${siteStatus.site_enabled ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
          <span class="switch-label" id="site-enabled-switch-label">${siteStatus.site_enabled ? "🟢 الموقع مفعل" : "🔴 الموقع معطل"}</span>
        </div>
        <p class="hint">عند التعطيل، يُمنع جميع الحكام من تسجيل الدخول أو إنشاء حساب جديد أو الوصول إلى أي صفحة داخلية — حساب الإدارة وحده يبقى قادرًا على الدخول وإعادة تفعيل الموقع.</p>
      </div>
    </div>

    <div class="panel-header"><h3>⚙ إعدادات التسجيل</h3></div>
    <div class="panel">
      <div id="admin-settings-error"></div>
      <div id="admin-settings-info"></div>
      <form id="admin-settings-form">
        <div class="field">
          <label>حالة التسجيل</label>
          <div class="switch-row">
            <label class="switch">
              <input type="checkbox" id="reg-open-switch" ${settings.is_registration_open ? "checked" : ""}>
              <span class="switch-slider"></span>
            </label>
            <span class="switch-label" id="reg-open-switch-label">${settings.is_registration_open ? "التسجيل مفتوح" : "التسجيل مغلق يدويًا"}</span>
          </div>
          <p class="hint">إيقاف هذا المفتاح يغلق التسجيل فورًا بغض النظر عن النمط أو الموعد أدناه.</p>
        </div>
        <div class="field">
          <label>نمط التسجيل</label>
          <div class="radio-row">
            <label class="radio-opt"><input type="radio" name="registration_mode" value="always_open" ${!isTimer ? "checked" : ""}> مفتوح دائمًا</label>
            <label class="radio-opt"><input type="radio" name="registration_mode" value="timer" ${isTimer ? "checked" : ""}> مؤقت (بعداد تنازلي)</label>
          </div>
        </div>
        <div class="field" id="reg-deadline-field" style="${isTimer ? "" : "display:none;"}">
          <label>تاريخ ووقت انتهاء التسجيل</label>
          <input type="datetime-local" name="registration_deadline" value="${deadlineLocal}">
        </div>
        <button type="submit" class="btn btn-primary">💾 حفظ الإعدادات</button>
      </form>
    </div>
  </div>`;
}
// Converts a UTC ISO timestamp (from the server) to the local "YYYY-MM-DDTHH:mm"
// string an <input type="datetime-local"> needs, in the admin's own timezone.
function isoToDatetimeLocal(iso){
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function wireRegistrationCountdown(){
  if(REG_COUNTDOWN_TIMER){ clearInterval(REG_COUNTDOWN_TIMER); REG_COUNTDOWN_TIMER = null; }
  const el = document.getElementById("reg-countdown");
  if(!el) return;
  const deadline = new Date(el.getAttribute("data-deadline")).getTime();
  if(isNaN(deadline)) return;

  function setUnit(unit, value){
    const n = el.querySelector(`[data-unit="${unit}"]`);
    if(n) n.textContent = String(value).padStart(2, "0");
  }
  function tick(){
    const remain = deadline - Date.now();
    if(remain <= 0){
      clearInterval(REG_COUNTDOWN_TIMER); REG_COUNTDOWN_TIMER = null;
      setUnit("days", 0); setUnit("hours", 0); setUnit("minutes", 0); setUnit("seconds", 0);
      el.classList.add("reg-countdown-expired");
      lockRegistrationClosedUI();
      return;
    }
    setUnit("days", Math.floor(remain / 86400000));
    setUnit("hours", Math.floor((remain % 86400000) / 3600000));
    setUnit("minutes", Math.floor((remain % 3600000) / 60000));
    setUnit("seconds", Math.floor((remain % 60000) / 1000));
  }
  tick();
  REG_COUNTDOWN_TIMER = setInterval(tick, 1000);
}

// Called the instant the client-side countdown hits zero — locks the signup
// entry point immediately without waiting for a full re-render/re-fetch
// (the server enforces the same cutoff independently on POST /auth/signup).
function lockRegistrationClosedUI(){
  if(REG_STATUS) REG_STATUS.isOpenNow = false;
  const signupBtn = document.querySelector('[data-action="show-auth"][data-tab="signup"]');
  if(signupBtn){ signupBtn.setAttribute("disabled", "disabled"); signupBtn.textContent = "⛔ التسجيل مغلق حالياً"; }
  const signupForm = document.getElementById("signup-form");
  if(signupForm){
    signupForm.querySelectorAll("input").forEach(inp => inp.disabled = true);
    const submitBtn = signupForm.querySelector('button[type="submit"]');
    if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = "التسجيل مغلق حالياً"; }
  }
}

/* ============================================================
   ADMIN — قوائم الحكام (referee roster lists, print-ready)
   ============================================================ */
// Mirrors refereeListsCore.js's COLUMN_DEFS on the server — kept as a
// separate client-side copy (same pattern as REF_RANKS/REF_ROLES/
// FIELD_GROUPS above) since the whole live-preview UI runs without a
// server round-trip on every checkbox click.
const REFLIST_COLUMN_DEFS = [
  { key:"refRole", label:"صفة التحكيم" },
  { key:"refLevel", label:"الرتبة الحالية" },
  { key:"clothingSize", label:"مقاس اللباس" },
  { key:"shoeSize", label:"مقاس الحذاء" },
  { key:"phone1", label:"رقم الهاتف" },
  { key:"email", label:"البريد الإلكتروني" },
  { key:"refStartDate", label:"موسم الدخول إلى التحكيم" },
  { key:"job", label:"الوظيفة" },
  { key:"address", label:"العنوان الشخصي" },
  { key:"ccp", label:"الحساب البريدي (CCP)" },
];
// Editor state for the page currently open — reset every time
// pageAdminRefereeListEditor() runs. { listId, config, eligible }
let REFLIST_EDITOR = null;

async function pageAdminRefereeLists(){
  let lists = [];
  try{ const res = await api("/admin/referee-lists"); lists = res.lists; }
  catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }

  const rows = lists.map(l=>`
    <tr>
      <td>${escapeHtml(l.title)}</td>
      <td>${l.refereeCount}</td>
      <td>${l.orientation==='landscape' ? 'أفقي' : 'عمودي'}</td>
      <td class="text-sm muted">${fmtDate(l.updatedAt)}</td>
      <td>
        <div class="flex gap-8" style="flex-wrap:wrap;">
          <a href="#/admin-referee-list-editor/${l.id}" class="btn btn-outline btn-sm">📂 فتح</a>
          <button type="button" class="btn btn-outline btn-sm" data-action="reflist-duplicate" data-id="${l.id}">⧉ استنساخ</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="reflist-delete" data-id="${l.id}">🗑 حذف</button>
        </div>
      </td>
    </tr>`).join("");

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 0;"><h3 style="font-size:22px;">قوائم الحكام</h3></div>
    <p class="text-sm muted" style="margin:4px 0 16px;">أنشئ قوائم حكام جاهزة للطباعة — لأيام تكوينية أو دورات أو مباريات — مع اختيار الحكام والمعلومات الظاهرة وخانة الإمضاء.</p>
    <div class="panel"><a href="#/admin-referee-list-editor/new" class="btn btn-primary">+ إنشاء قائمة جديدة</a></div>
    <div class="panel">
      ${lists.length===0 ? `<div class="empty"><div class="icon">🗒</div><h3>لا توجد قوائم محفوظة بعد</h3></div>` : `
      <div class="table-wrap"><table>
        <thead><tr><th>عنوان القائمة</th><th>عدد الحكام</th><th>اتجاه الصفحة</th><th>آخر تعديل</th><th>إجراءات</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`}
    </div>
  </div>`;
}

async function pageAdminRefereeListEditor(id){
  let eligible = [];
  try{ const res = await api("/admin/referee-lists/eligible-referees"); eligible = res.referees; }
  catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }

  let config = { title:"", selectionMode:"all", filterRefRole:[], filterRefLevel:[], manualIds:[], columns:["refRole","refLevel"], showSignatureColumn:true, includeSignatures:false, orientation:"portrait" };
  let listId = null;
  if(id && id !== "new"){
    try{
      const { list } = await api(`/admin/referee-lists/${id}`);
      listId = list.id;
      config = {
        title: list.title, selectionMode: list.selectionMode,
        filterRefRole: list.filterRefRole||[], filterRefLevel: list.filterRefLevel||[],
        manualIds: list.manualIds||[], columns: list.columns||[],
        showSignatureColumn: !!list.showSignatureColumn, includeSignatures: !!list.includeSignatures, orientation: list.orientation||"portrait",
      };
    }catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }
  }
  REFLIST_EDITOR = { listId, config, eligible };
  return reflistEditorPageHtml();
}

function reflistEditorPageHtml(){
  const { listId, config, eligible } = REFLIST_EDITOR;
  const mode = config.selectionMode;
  return `
  <div class="page">
    <a href="#/admin-referee-lists" class="btn btn-ghost btn-sm no-print">→ عودة إلى قوائم الحكام</a>
    <div class="panel no-print">
      <div class="panel-header"><h3>${listId ? 'تعديل قائمة الحكام' : 'إنشاء قائمة حكام جديدة'}</h3></div>
      <div id="reflist-save-result"></div>
      <div class="field"><label>عنوان القائمة</label><input type="text" id="reflist-title" value="${escapeHtml(config.title)}" placeholder="مثال: يوم تكويني 22/12/2026"></div>

      <div class="section-title">اختيار الحكام</div>
      <div class="reflist-radio-group">
        <label><input type="radio" name="reflist-selection-mode" value="all" ${mode==='all'?'checked':''}> جميع الحكام</label>
        <label><input type="radio" name="reflist-selection-mode" value="filter" ${mode==='filter'?'checked':''}> حسب الفئة/الصفة</label>
        <label><input type="radio" name="reflist-selection-mode" value="manual" ${mode==='manual'?'checked':''}> اختيار يدوي</label>
      </div>

      <div id="reflist-filter-panel" class="mt-16" style="${mode==='filter'?'':'display:none;'}">
        <div class="text-sm muted">صفة التحكيم</div>
        <div class="reflist-checks">${REF_ROLES.map(r=>`<label><input type="checkbox" class="reflist-filter-role" value="${escapeHtml(r)}" ${config.filterRefRole.includes(r)?'checked':''}> ${r}</label>`).join('')}</div>
        <div class="text-sm muted mt-16">الرتبة الحالية</div>
        <div class="reflist-checks">${REF_RANKS.map(r=>`<label><input type="checkbox" class="reflist-filter-level" value="${escapeHtml(r)}" ${config.filterRefLevel.includes(r)?'checked':''}> ${r}</label>`).join('')}</div>
      </div>

      <div id="reflist-manual-panel" class="mt-16" style="${mode==='manual'?'':'display:none;'}">
        <input type="text" id="reflist-manual-search" placeholder="بحث بالاسم...">
        <div class="reflist-manual-list mt-8">
          ${eligible.length ? eligible.map(r=>`
            <label class="reflist-manual-item" data-search="${escapeHtml(r.fullNameAr).toLowerCase()}">
              <input type="checkbox" class="reflist-manual-check" value="${r.userId}" ${config.manualIds.includes(r.userId)?'checked':''}>
              <span>${escapeHtml(r.fullNameAr)} <span class="text-sm muted">— ${escapeHtml(r.refRole||'—')}</span></span>
            </label>`).join('') : `<div class="text-sm muted">لا يوجد أي حكم معتمد بعد.</div>`}
        </div>
      </div>

      <div class="section-title mt-16">المعلومات التي ستظهر</div>
      <div class="reflist-checks">
        ${REFLIST_COLUMN_DEFS.map(c=>`<label><input type="checkbox" class="reflist-column-check" value="${c.key}" ${config.columns.includes(c.key)?'checked':''}> ${c.label}</label>`).join('')}
      </div>

      <div class="section-title mt-16">الإمضاء واتجاه الصفحة</div>
      <label><input type="checkbox" id="reflist-signature-col" ${config.showSignatureColumn?'checked':''}> إضافة خانة الإمضاء</label>
      <div id="reflist-include-sig-wrap" class="mt-8" style="${config.showSignatureColumn?'':'display:none;'}">
        <label><input type="checkbox" id="reflist-include-sig" ${config.includeSignatures?'checked':''}> جلب توقيعات الحكام المسجلة</label>
        <p class="hint">اختياري: عند التفعيل، يتم جلب التوقيع الإلكتروني المحفوظ لكل حكم ووضعه في خانة الإمضاء تلقائيًا. الحكام الذين لا يملكون توقيعًا محفوظًا تبقى خانتهم فارغة للتوقيع اليدوي. عند عدم التفعيل، تبقى الخانة فارغة كالمعتاد.</p>
      </div>
      <div class="reflist-radio-group mt-8">
        <label><input type="radio" name="reflist-orientation" value="portrait" ${config.orientation==='portrait'?'checked':''}> عمودي</label>
        <label><input type="radio" name="reflist-orientation" value="landscape" ${config.orientation==='landscape'?'checked':''}> أفقي</label>
      </div>

      <div class="flex gap-12 mt-16">
        <button type="button" class="btn btn-primary" id="reflist-save-btn">💾 حفظ القائمة</button>
        <button type="button" class="btn btn-outline" id="reflist-print-btn">🖨 طباعة</button>
        ${listId ? `<button type="button" class="btn btn-outline" id="reflist-duplicate-btn">⧉ استنساخ كقائمة جديدة</button>` : ''}
      </div>
    </div>

    <div class="panel-header no-print" style="border:none;margin:16px 0 8px;"><h3 style="font-size:18px;">معاينة القائمة</h3></div>
    <div id="reflist-preview"></div>
  </div>`;
}

function reflistComputeRows(){
  const cfg = REFLIST_EDITOR.config;
  const pool = REFLIST_EDITOR.eligible;
  if(cfg.selectionMode === 'manual'){
    const idSet = new Set(cfg.manualIds);
    return pool.filter(r=>idSet.has(r.userId));
  }
  if(cfg.selectionMode === 'filter'){
    return pool.filter(r=>{
      const roleOk = cfg.filterRefRole.length===0 || cfg.filterRefRole.includes(r.refRole);
      const levelOk = cfg.filterRefLevel.length===0 || cfg.filterRefLevel.includes(r.refLevel);
      return roleOk && levelOk;
    });
  }
  return pool.slice();
}

// Toggling page orientation for print can't be done reliably with CSS
// classes alone (the printed @page size has to come from an actual @page
// rule active at print time) — so this injects/updates a small <style> tag
// with the right @page size whenever the editor is open, and removes it
// again once the editor unmounts so it never affects the وثيقة الانخراط
// print (@page{size:A4;margin:9mm;} in styles.css) or any other page.
function reflistSyncPageSizeStyle(){
  const active = document.getElementById("reflist-preview");
  let styleEl = document.getElementById("reflist-page-size-style");
  if(!active){
    if(styleEl) styleEl.remove();
    return;
  }
  if(!styleEl){
    styleEl = document.createElement("style");
    styleEl.id = "reflist-page-size-style";
    document.head.appendChild(styleEl);
  }
  const orientation = (REFLIST_EDITOR && REFLIST_EDITOR.config.orientation) || "portrait";
  styleEl.textContent = `@media print{ @page{ size:A4 ${orientation==='landscape'?'landscape':'portrait'}; margin:9mm; } }`;
}

function reflistRenderPreview(){
  if(!REFLIST_EDITOR) return;
  const cfg = REFLIST_EDITOR.config;
  const rows = reflistComputeRows();
  const cols = REFLIST_COLUMN_DEFS.filter(c=>cfg.columns.includes(c.key));
  const wrap = document.getElementById("reflist-preview");
  if(!wrap) return;
  reflistSyncPageSizeStyle();
  const colCount = 2 + cols.length + (cfg.showSignatureColumn?1:0);
  const headCells = `<th>الرقم</th><th>الاسم واللقب</th>${cols.map(c=>`<th>${c.label}</th>`).join('')}${cfg.showSignatureColumn?`<th class="reflist-sig-col">الإمضاء</th>`:''}`;
  const signatureCell = (r) => {
    if(!cfg.showSignatureColumn) return '';
    if(cfg.includeSignatures && r.signatureUrl){
      return `<td class="reflist-sig-col"><img class="reflist-sig-img" src="${r.signatureUrl}" alt="إمضاء ${escapeHtml(r.fullNameAr)}"></td>`;
    }
    return `<td class="reflist-sig-col"></td>`; // no saved signature, or feature off — left blank for hand-signing, as before
  };
  const bodyRows = rows.length ? rows.map((r,i)=>`
    <tr>
      <td>${i+1}</td>
      <td>${escapeHtml(r.fullNameAr)}</td>
      ${cols.map(c=>`<td>${escapeHtml(r[c.key]||'—')}</td>`).join('')}
      ${signatureCell(r)}
    </tr>`).join('') : `<tr><td colspan="${colCount}" class="muted text-sm center-txt">لا يوجد أي حكم يطابق الاختيار الحالي.</td></tr>`;

  wrap.innerHTML = `
    <div class="reflist-print ${cfg.orientation==='landscape'?'reflist-landscape':''}">
      <div class="reflist-print-head">
        <img src="/assets/logo.png" alt="شعار الرابطة الولائية لكرة القدم الوادي">
        <div class="reflist-print-headtext">
          <h2>الرابطة الولائية لكرة القدم الوادي</h2>
        </div>
      </div>
      <h1 class="reflist-title" id="reflist-title-el">${escapeHtml(cfg.title || 'قائمة الحكام')}</h1>
      <table class="reflist-table">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <div class="text-sm muted mt-16 no-print">عدد الحكام في القائمة: ${rows.length}</div>
    </div>`;
  fitReflistTitle();
}

// ---- Keeps the list title (item 3 of the print spec) on exactly one line
// no matter how long it is, by shrinking its font-size to fit the printed
// page width — CSS clamp() alone only reacts to viewport width, not to the
// title's own text length, so a long title at a large clamp size could
// still wrap. This measures the actual rendered width and steps the
// font-size down until it fits (or hits the minimum), then leaves
// white-space:nowrap (see CSS) to guarantee it never wraps even if a step
// was missed. Re-run on every preview render, on window resize, and right
// before printing (browsers can reflow slightly for print media). ----
function fitReflistTitle(){
  const el = document.getElementById("reflist-title-el");
  if(!el) return;
  const maxPx = 26, minPx = 11;
  el.style.fontSize = maxPx + "px";
  let size = maxPx;
  // A couple of layout frames are sometimes needed for scrollWidth to
  // settle after the font-size change, hence the small step loop rather
  // than a single measurement.
  while(size > minPx && el.scrollWidth > el.clientWidth){
    size -= 1;
    el.style.fontSize = size + "px";
  }
}
window.addEventListener("resize", ()=>{ if(document.getElementById("reflist-title-el")) fitReflistTitle(); });
window.addEventListener("beforeprint", fitReflistTitle);

function reflistWireEvents(){
  if(!document.getElementById("reflist-preview") || !REFLIST_EDITOR) return;
  reflistRenderPreview();

  const titleInput = document.getElementById("reflist-title");
  if(titleInput) titleInput.addEventListener("input", ()=>{ REFLIST_EDITOR.config.title = titleInput.value; reflistRenderPreview(); });

  document.querySelectorAll('input[name="reflist-selection-mode"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{
      REFLIST_EDITOR.config.selectionMode = radio.value;
      const filterPanel = document.getElementById("reflist-filter-panel");
      const manualPanel = document.getElementById("reflist-manual-panel");
      if(filterPanel) filterPanel.style.display = radio.value==='filter' ? '' : 'none';
      if(manualPanel) manualPanel.style.display = radio.value==='manual' ? '' : 'none';
      reflistRenderPreview();
    });
  });

  document.querySelectorAll('.reflist-filter-role').forEach(cb=>{
    cb.addEventListener("change", ()=>{
      REFLIST_EDITOR.config.filterRefRole = Array.from(document.querySelectorAll('.reflist-filter-role:checked')).map(x=>x.value);
      reflistRenderPreview();
    });
  });
  document.querySelectorAll('.reflist-filter-level').forEach(cb=>{
    cb.addEventListener("change", ()=>{
      REFLIST_EDITOR.config.filterRefLevel = Array.from(document.querySelectorAll('.reflist-filter-level:checked')).map(x=>x.value);
      reflistRenderPreview();
    });
  });
  document.querySelectorAll('.reflist-manual-check').forEach(cb=>{
    cb.addEventListener("change", ()=>{
      REFLIST_EDITOR.config.manualIds = Array.from(document.querySelectorAll('.reflist-manual-check:checked')).map(x=>x.value);
      reflistRenderPreview();
    });
  });
  const manualSearch = document.getElementById("reflist-manual-search");
  if(manualSearch) manualSearch.addEventListener("input", ()=>{
    const q = manualSearch.value.trim().toLowerCase();
    document.querySelectorAll('.reflist-manual-item').forEach(el=>{
      el.style.display = !q || (el.getAttribute("data-search")||"").includes(q) ? "" : "none";
    });
  });
  document.querySelectorAll('.reflist-column-check').forEach(cb=>{
    cb.addEventListener("change", ()=>{
      REFLIST_EDITOR.config.columns = Array.from(document.querySelectorAll('.reflist-column-check:checked')).map(x=>x.value);
      reflistRenderPreview();
    });
  });
  const sigCb = document.getElementById("reflist-signature-col");
  const includeSigWrap = document.getElementById("reflist-include-sig-wrap");
  const includeSigCb = document.getElementById("reflist-include-sig");
  if(sigCb) sigCb.addEventListener("change", ()=>{
    REFLIST_EDITOR.config.showSignatureColumn = sigCb.checked;
    if(includeSigWrap) includeSigWrap.style.display = sigCb.checked ? '' : 'none';
    if(!sigCb.checked){
      // Turning the signature column off entirely also turns off fetching
      // signatures, so the two stay consistent (mirrors the sanitizeConfig
      // rule in refereeListsCore.js server-side).
      REFLIST_EDITOR.config.includeSignatures = false;
      if(includeSigCb) includeSigCb.checked = false;
    }
    reflistRenderPreview();
  });
  if(includeSigCb) includeSigCb.addEventListener("change", ()=>{ REFLIST_EDITOR.config.includeSignatures = includeSigCb.checked; reflistRenderPreview(); });

  document.querySelectorAll('input[name="reflist-orientation"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{ REFLIST_EDITOR.config.orientation = radio.value; reflistRenderPreview(); });
  });

  const saveBtn = document.getElementById("reflist-save-btn");
  if(saveBtn) saveBtn.addEventListener("click", async ()=>{
    const resultEl = document.getElementById("reflist-save-result");
    if(resultEl) resultEl.innerHTML = "";
    saveBtn.disabled = true;
    const prevText = saveBtn.textContent;
    saveBtn.textContent = "جارِ الحفظ...";
    try{
      const cfg = REFLIST_EDITOR.config;
      const currentListId = REFLIST_EDITOR.listId;
      const { list } = currentListId
        ? await api(`/admin/referee-lists/${currentListId}`, { method:"PUT", body: cfg })
        : await api(`/admin/referee-lists`, { method:"POST", body: cfg });
      REFLIST_EDITOR.listId = list.id;
      if(resultEl) resultEl.innerHTML = `<div class="info-msg">✔ تم حفظ القائمة بنجاح.</div>`;
      const newHash = `#/admin-referee-list-editor/${list.id}`;
      if(location.hash !== newHash) history.replaceState(null, "", newHash);
      if(!document.getElementById("reflist-duplicate-btn")){
        const actionsRow = saveBtn.parentElement;
        if(actionsRow){
          const dup = document.createElement("button");
          dup.type = "button"; dup.className = "btn btn-outline"; dup.id = "reflist-duplicate-btn";
          dup.textContent = "⧉ استنساخ كقائمة جديدة";
          actionsRow.appendChild(dup);
          dup.addEventListener("click", async ()=>{
            try{ const res = await api(`/admin/referee-lists/${REFLIST_EDITOR.listId}/duplicate`, { method:"POST" }); go(`admin-referee-list-editor/${res.list.id}`); }
            catch(err){ alert(err.message); }
          });
        }
      }
    }catch(err){
      if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
    }
    saveBtn.disabled = false;
    saveBtn.textContent = prevText;
  });

  const printBtn = document.getElementById("reflist-print-btn");
  if(printBtn) printBtn.addEventListener("click", ()=> window.print());

  const dupBtn = document.getElementById("reflist-duplicate-btn");
  if(dupBtn) dupBtn.addEventListener("click", async ()=>{
    if(!REFLIST_EDITOR.listId) return;
    try{
      const { list } = await api(`/admin/referee-lists/${REFLIST_EDITOR.listId}/duplicate`, { method:"POST" });
      go(`admin-referee-list-editor/${list.id}`);
    }catch(err){ alert(err.message); }
  });
}

/* ============================================================
   Global event delegation
   ============================================================ */
function attachGlobalHandlers(){
  attachAuthHandlers();
  wireRegistrationCountdown();
  reflistSyncPageSizeStyle();
  reflistWireEvents();

  document.querySelectorAll('[data-action="reflist-duplicate"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-id");
      btn.disabled = true;
      try{ await api(`/admin/referee-lists/${id}/duplicate`, { method:"POST" }); render(); }
      catch(err){ alert(err.message); btn.disabled = false; }
    });
  });
  document.querySelectorAll('[data-action="reflist-delete"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-id");
      if(!confirm("هل تريد حذف هذه القائمة نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.")) return;
      btn.disabled = true;
      try{ await api(`/admin/referee-lists/${id}`, { method:"DELETE" }); render(); }
      catch(err){ alert(err.message); btn.disabled = false; }
    });
  });

  document.querySelectorAll('[data-action="show-auth"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const tab = btn.getAttribute("data-tab");
      const zone = document.getElementById("auth-zone");
      if(zone){ zone.innerHTML = authForm(tab); attachAuthHandlers(); zone.scrollIntoView({behavior:"smooth", block:"center"}); }
    });
  });
  document.querySelectorAll('[data-action="logout"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(window.LWFChat) window.LWFChat.disconnect();
      clearSession(); CACHE={myApp:null,adminList:null,adminReview:null}; go("home");
    });
  });

  /* ---- Mobile nav toggle ---- */
  const burger = document.getElementById("nav-burger");
  if(burger){
    burger.addEventListener("click", (e)=>{
      e.stopPropagation();
      document.getElementById("nav-actions")?.classList.toggle("open");
    });
  }
  /* ---- Desktop admin/referee nav bar: shrink-to-fit onto one fixed line
     (no scroll, no wrap — see fitNavActions()). Re-run on every render
     since the topbar (and #nav-actions) is rebuilt from scratch each time. ---- */
  fitNavActions();
  // Wired once on `document` rather than per-render: root.innerHTML rebuilds
  // the topbar (and a fresh #nav-burger/#nav-actions pair) on every single
  // route change, so a listener attached here instead would pile up one
  // extra copy per navigation for the lifetime of the session. Re-reading
  // both elements by id on each click keeps this one listener correct
  // against whichever topbar instance is currently in the DOM.
  if(!window._navMenuOutsideClickWired){
    document.addEventListener("click", (e)=>{
      const nav = document.getElementById("nav-actions");
      if(!nav || !nav.classList.contains("open")) return;
      const burgerNow = document.getElementById("nav-burger");
      if(burgerNow && (e.target === burgerNow || burgerNow.contains(e.target))) return;
      nav.classList.remove("open");
    });
    window._navMenuOutsideClickWired = true;
  }
  // Same one-time-delegation reasoning as the nav menu above: every field
  // rendered with a `script` constraint (fullNameAr/fullNameLatin, wherever
  // they show up — signup form, wizard step, anywhere else later) carries
  // `data-script`, so one listener on `document` covers all of them forever
  // instead of needing to be re-wired after each re-render.
  if(!window._scriptInputFilterWired){
    document.addEventListener("input", (e)=>{
      const script = e.target && e.target.dataset && e.target.dataset.script;
      if(!script) return;
      const filtered = filterToScript(script, e.target.value);
      if(filtered !== e.target.value){
        const pos = e.target.selectionStart - (e.target.value.length - filtered.length);
        e.target.value = filtered;
        try{ e.target.setSelectionRange(pos, pos); }catch(err){}
      }
    });
    window._scriptInputFilterWired = true;
  }
  // Same delegation approach for the two `data-format` fields that need
  // more than plain character filtering: CCP (fixed prefix the person can
  // never edit away, then digits up to the total length) and clothing size
  // (uppercased live, so "xl"/"Xl"/"xL" all become "XL" as the person types).
  if(!window._formatInputFilterWired){
    document.addEventListener("input", (e)=>{
      const format = e.target && e.target.dataset && e.target.dataset.format;
      if(!format) return;
      let filtered = null;
      if(format === "ccp") filtered = sanitizeCcpValue(e.target.value);
      else if(format === "clothingSize") filtered = sanitizeClothingSizeValue(e.target.value);
      else if(format === "season") filtered = sanitizeSeasonValue(e.target.value);
      if(filtered !== null && filtered !== e.target.value){
        const pos = e.target.selectionStart - (e.target.value.length - filtered.length);
        e.target.value = filtered;
        try{ e.target.setSelectionRange(Math.max(pos,0), Math.max(pos,0)); }catch(err){}
      }
    });
    window._formatInputFilterWired = true;
  }
  // Theme toggle: delegated once (topbar — and its #theme-toggle-btn — is
  // rebuilt on every route change, same as the nav menu above). Toggles the
  // class the inline <head> script and every dark-mode CSS rule key off of,
  // persists the explicit choice so it's respected (not just the OS
  // preference) next visit, and updates the icon in place since a theme
  // toggle doesn't go through a full route re-render.
  if(!window._themeToggleWired){
    document.addEventListener("click", (e)=>{
      const btn = e.target.closest && e.target.closest("#theme-toggle-btn");
      if(!btn) return;
      const root = document.documentElement;
      const nowDark = root.classList.toggle("dark-mode");
      try{ localStorage.setItem("lwf_theme", nowDark ? "dark" : "light"); }catch(err){}
      btn.innerHTML = nowDark ? ICON_SUN : ICON_MOON;
      btn.title = nowDark ? "التبديل إلى الوضع النهاري" : "التبديل إلى الوضع الليلي";
    });
    window._themeToggleWired = true;
  }

  /* ---- Admin: open a private chat with a referee from anywhere in the admin UI ---- */
  document.querySelectorAll('[data-action="chat-with-referee"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const userId = btn.getAttribute("data-userid");
      go(`chat/private-${userId}`);
    });
  });

  /* ---- Large document preview popup (referee & admin review) ---- */
  document.querySelectorAll('.doc-zoom-trigger').forEach(el=>{
    el.addEventListener("click", (e)=>{
      e.preventDefault();
      openDocLightbox(el.getAttribute("data-zoom-url"), el.getAttribute("data-zoom-mime"), el.getAttribute("data-zoom-title"));
    });
  });

  /* ---- Admin: server-side pagination/search/status-filter on the
         applications list (section 8) ---- */
  const adminAppsSearch = document.getElementById("admin-apps-search");
  if(adminAppsSearch){
    let debounceTimer;
    adminAppsSearch.addEventListener("input", ()=>{
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(()=>{
        ADMIN_APPS_STATE.q = adminAppsSearch.value.trim();
        ADMIN_APPS_STATE.page = 1;
        render();
      }, 350);
    });
  }
  document.querySelectorAll('[data-action="admin-apps-status"]').forEach(card=>{
    card.addEventListener("click", ()=>{
      ADMIN_APPS_STATE.status = card.getAttribute("data-status");
      ADMIN_APPS_STATE.page = 1;
      render();
    });
  });
  const adminAppsPageSize = document.getElementById("admin-apps-pagesize");
  if(adminAppsPageSize){
    adminAppsPageSize.addEventListener("change", ()=>{
      ADMIN_APPS_STATE.pageSize = parseInt(adminAppsPageSize.value, 10);
      ADMIN_APPS_STATE.page = 1;
      render();
    });
  }
  document.querySelectorAll('[data-action="admin-apps-page"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(btn.disabled) return;
      ADMIN_APPS_STATE.page = parseInt(btn.getAttribute("data-page"), 10);
      render();
    });
  });

  /* ---- Admin: server-side pagination/search/filter/sort on the registered
         accounts list (section 8) ---- */
  const adminUsersSearch = document.getElementById("admin-users-search");
  if(adminUsersSearch){
    let debounceTimer;
    adminUsersSearch.addEventListener("input", ()=>{
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(()=>{
        ADMIN_USERS_STATE.q = adminUsersSearch.value.trim();
        ADMIN_USERS_STATE.page = 1;
        render();
      }, 350);
    });
  }
  const adminUsersSort = document.getElementById("admin-users-sort");
  if(adminUsersSort){
    adminUsersSort.addEventListener("change", ()=>{
      ADMIN_USERS_STATE.sort = adminUsersSort.value;
      render();
    });
  }
  const adminUsersPageSize = document.getElementById("admin-users-pagesize");
  if(adminUsersPageSize){
    adminUsersPageSize.addEventListener("change", ()=>{
      ADMIN_USERS_STATE.pageSize = parseInt(adminUsersPageSize.value, 10);
      ADMIN_USERS_STATE.page = 1;
      render();
    });
  }
  document.querySelectorAll('[data-action="admin-users-status"]').forEach(card=>{
    card.addEventListener("click", ()=>{
      ADMIN_USERS_STATE.status = card.getAttribute("data-status");
      ADMIN_USERS_STATE.page = 1;
      render();
    });
  });
  document.querySelectorAll('[data-action="admin-users-page"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(btn.disabled) return;
      ADMIN_USERS_STATE.page = parseInt(btn.getAttribute("data-page"), 10);
      render();
    });
  });

  /* ---- Admin: inline edit (name / username / password) for a referee
         account (section 7) ---- */
  document.querySelectorAll('[data-action="edit-referee-start"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const row = btn.closest("tr");
      row.querySelectorAll(".admin-user-view").forEach(el=>el.style.display="none");
      row.querySelectorAll(".admin-user-edit").forEach(el=>el.style.display="block");
      row.querySelector(".admin-user-view-actions").style.display="none";
      row.querySelector(".admin-user-edit-actions").style.display="block";
    });
  });
  document.querySelectorAll('[data-action="edit-referee-cancel"]').forEach(btn=>{
    btn.addEventListener("click", ()=> render());
  });
  document.querySelectorAll('[data-action="edit-referee-save"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const row = btn.closest("tr");
      const userId = btn.getAttribute("data-userid");
      const body = {};
      row.querySelectorAll(".admin-user-edit").forEach(el=>{
        const field = el.getAttribute("data-field");
        if(field === "password"){ if(el.value.trim()) body.password = el.value.trim(); }
        else body[field] = el.value.trim();
      });
      try{
        await api(`/admin/users/${userId}`, { method:"PUT", body });
        render();
      }catch(err){
        alert(err.message);
      }
    });
  });

  /* ---- Admin: administrative disable/enable (section 6 & 7) — independent
         of the قيد المراجعة/مفعّل review workflow above ---- */
  document.querySelectorAll('[data-action="disable-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`تعطيل حساب الحكم "${fullName}"؟ لن يتمكن من تسجيل الدخول حتى تتم إعادة تفعيل حسابه.`)) return;
      try{
        await api(`/admin/users/${userId}/disable`, { method:"POST" });
        render();
      }catch(err){
        alert(err.message);
      }
    });
  });
  document.querySelectorAll('[data-action="enable-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      try{
        await api(`/admin/users/${userId}/enable`, { method:"POST" });
        render();
      }catch(err){
        alert(err.message);
      }
    });
  });

  /* ---- Admin: search on the audit log (سجل التعديلات) ---- */
  const adminChangeLogSearch = document.getElementById("admin-changelog-search");
  if(adminChangeLogSearch){
    adminChangeLogSearch.addEventListener("input", applyAdminChangeLogFilter);
  }

  /* ---- Admin: reset a referee's password ---- */
  document.querySelectorAll('[data-action="reset-password"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const username = btn.getAttribute("data-username");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`هل تريد إنشاء كلمة سر جديدة للحكم "${fullName}"؟ كلمة سره الحالية ستتوقف عن العمل فورًا.`)) return;
      const resultEl = document.getElementById("reset-password-result");
      try{
        const res = await api(`/admin/users/${userId}/reset-password`, { method:"POST" });
        if(resultEl){
          resultEl.innerHTML = `
            <div class="info-msg" style="font-size:14.5px;">
              ✅ تم إنشاء كلمة سر جديدة لـ <b>${escapeHtml(res.fullNameAr)}</b> (اسم المستخدم: <b>${escapeHtml(res.username)}</b>).<br>
              كلمة السر الجديدة: <span style="font-family:monospace;font-size:16px;font-weight:800;background:#fff;padding:3px 10px;border-radius:6px;border:1.5px solid var(--green-deep);display:inline-block;margin-top:6px;">${escapeHtml(res.newPassword)}</span><br>
              <span class="text-sm muted">انسخها وسلّمها للحكم الآن — لن تظهر مرة أخرى، ولن يتمكن من الدخول بكلمة سره القديمة.</span>
            </div>`;
          resultEl.scrollIntoView({behavior:"smooth", block:"center"});
        }
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });

  /* ---- Admin: activate / deactivate a referee's account ---- */
  document.querySelectorAll('[data-action="activate-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`تفعيل حساب الحكم "${fullName}"؟ سيتمكن فورًا من الدخول للوحته، رفع ملفه، والانضمام إلى الدردشة العامة للحكام.`)) return;
      const resultEl = document.getElementById("reset-password-result");
      try{
        await api(`/admin/users/${userId}/activate`, { method:"POST" });
        render();
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });
  document.querySelectorAll('[data-action="deactivate-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`إيقاف حساب الحكم "${fullName}" مؤقتًا؟ لن يتمكن من الدخول إلا للدردشة المباشرة معك حتى تُعيد تفعيل حسابه.`)) return;
      const resultEl = document.getElementById("reset-password-result");
      try{
        await api(`/admin/users/${userId}/deactivate`, { method:"POST" });
        render();
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });

  /* ---- Admin: account activation review — 🟢 قبول / 🔵 طلب تعديل / 🔴 رفض / إعادة فتح ---- */
  document.querySelectorAll('[data-action="accept-registration"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`قبول تسجيل الحكم "${fullName}" وتفعيل حسابه؟ سيتمكن فورًا من متابعة الخطوات التالية في المنصة.`)) return;
      try{
        await api(`/admin/users/${userId}/accept`, { method:"POST" });
        render();
      }catch(err){
        alert(err.message);
      }
    });
  });
  document.querySelectorAll('[data-action="reopen-registration"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      if(!confirm("إعادة فتح مراجعة هذا الحساب بعد الرفض؟ ستعود حالته إلى \"قيد المراجعة\".")) return;
      try{
        await api(`/admin/users/${userId}/reopen`, { method:"POST" });
        render();
      }catch(err){
        alert(err.message);
      }
    });
  });
  const regRequestEditForm = document.getElementById("registration-request-edit-form");
  if(regRequestEditForm){
    regRequestEditForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const userId = regRequestEditForm.getAttribute("data-userid");
      const errEl = document.getElementById("registration-request-edit-error");
      if(errEl) errEl.innerHTML = "";
      const fields = Array.from(regRequestEditForm.querySelectorAll('input[name="reg-review-field"]:checked')).map(i=>i.value);
      const note = regRequestEditForm.querySelector('textarea[name="note"]').value.trim();
      if(fields.length===0){ if(errEl) errEl.innerHTML = `<div class="error-msg">حدد معلومة واحدة على الأقل تحتاج إلى تعديل.</div>`; return; }
      if(!note){ if(errEl) errEl.innerHTML = `<div class="error-msg">يجب كتابة ملاحظة توضح للحكم المطلوب تعديله.</div>`; return; }
      try{
        await api(`/admin/users/${userId}/request-edit`, { method:"POST", body:{ fields, note } });
        render();
      }catch(err){
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }
  const regRejectForm = document.getElementById("registration-reject-form");
  if(regRejectForm){
    regRejectForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const userId = regRejectForm.getAttribute("data-userid");
      const errEl = document.getElementById("registration-reject-error");
      if(errEl) errEl.innerHTML = "";
      const reason = regRejectForm.querySelector('textarea[name="reason"]').value.trim();
      if(!reason){ if(errEl) errEl.innerHTML = `<div class="error-msg">يجب كتابة سبب الرفض.</div>`; return; }
      if(!confirm("رفض هذا الحساب؟ لن يتمكن الحكم من متابعة التسجيل إلا إذا أعدت فتح المراجعة لاحقًا.")) return;
      try{
        await api(`/admin/users/${userId}/reject`, { method:"POST", body:{ reason } });
        render();
      }catch(err){
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  /* ---- Referee: correct flagged registration fields + resubmit ---- */
  const regEditForm = document.getElementById("registration-edit-form");
  if(regEditForm){
    const resubmitBtn = document.getElementById("registration-resubmit-btn");
    regEditForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const errEl = document.getElementById("registration-edit-error");
      if(errEl) errEl.innerHTML = "";
      document.querySelectorAll('[id^="reg-field-error-"]').forEach(el=>{ el.textContent = ""; });
      const fields = {};
      REGISTRATION_FIELD_META.forEach(f=>{
        const input = document.getElementById(`reg-field-${f.key}`);
        if(input) fields[f.key] = input.value.trim();
      });
      try{
        await api("/auth/registration", { method:"PUT", body:{ fields } });
        if(resubmitBtn){ resubmitBtn.disabled = false; resubmitBtn.title = ""; }
        if(errEl) errEl.innerHTML = `<div class="info-msg">✅ تم حفظ التعديلات. اضغط "إعادة إرسال التسجيل" عند الانتهاء.</div>`;
      }catch(err){
        if(err.data && err.data.fields){
          Object.entries(err.data.fields).forEach(([k,msg])=>{
            const el = document.getElementById(`reg-field-error-${k}`);
            if(el) el.textContent = msg;
          });
        }
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
    if(resubmitBtn){
      resubmitBtn.addEventListener("click", async ()=>{
        if(!confirm("إعادة إرسال التسجيل للمراجعة الآن؟")) return;
        try{
          await api("/auth/registration/resubmit", { method:"POST" });
          const s = getSession();
          if(s){ setSession({ ...s, user: { ...s.user, accountStatus: "pending" } }); }
          render();
        }catch(err){
          alert(err.message);
        }
      });
    }
  }

  /* ---- Admin: exceptional unlock of a referee's finalized e-signature —
     lets them draw a new one; the referee still has to actively redraw and
     save it themselves afterwards. ---- */
  document.querySelectorAll('[data-action="unlock-signature"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`السماح للحكم "${fullName}" برسم إمضاء جديد بشكل استثنائي؟ سيبقى التوقيع الحالي ظاهرًا إلى أن يرسم إمضاءً جديدًا ويحفظه.`)) return;
      const resultEl = document.getElementById("reset-password-result");
      try{
        await api(`/admin/users/${userId}/unlock-signature`, { method:"POST" });
        render();
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });

  /* ---- Admin: delete a referee account entirely ---- */
  document.querySelectorAll('[data-action="delete-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`هل تريد حذف حساب الحكم "${fullName}" نهائيًا؟ سيُحذف حسابه وملفه ووثائقه وكل طلباته، وستُحذف رسائله ويختفي تمامًا من الدردشة وكل القوائم، ولا يمكن التراجع عن هذا الإجراء.`)) return;
      const resultEl = document.getElementById("reset-password-result");
      try{
        await api(`/admin/users/${userId}`, { method:"DELETE" });
        render();
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });

  /* ---- Account: self-service change password (referee or admin) ---- */
  const changePasswordForm = document.getElementById("change-password-form");
  if(changePasswordForm){
    changePasswordForm.addEventListener("submit", async e=>{
      e.preventDefault();
      const resultEl = document.getElementById("change-password-result");
      if(changePasswordForm._validate && !changePasswordForm._validate()) return;
      const fd = new FormData(changePasswordForm);
      const currentPassword = fd.get("currentPassword");
      const newPassword = fd.get("newPassword");
      try{
        await api("/auth/change-password", { method:"POST", body:{ currentPassword, newPassword }});
        if(resultEl) resultEl.innerHTML = `<div class="info-msg">✅ تم تحديث كلمة السر بنجاح. استخدمها في المرة القادمة التي تسجّل فيها الدخول.</div>`;
        changePasswordForm.reset();
        changePasswordForm.querySelectorAll(".field-valid,.field-invalid").forEach(f=>f.classList.remove("field-valid","field-invalid"));
        changePasswordForm.querySelectorAll(".field-status-icon").forEach(i=>{ i.classList.remove("ok","bad"); i.textContent=""; });
        changePasswordForm.querySelectorAll("[data-vtouched]").forEach(el=> delete el.dataset.vtouched);
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  /* ---- Account: referee e-signature pad (mouse + touch/pen via Pointer
     Events, works the same on Android/iOS/desktop). Re-wired fresh on
     every render() since the canvas node itself is recreated each time. ---- */
  wireSignaturePad();

  /* ---- Referee: submit absence / special / edit requests ---- */
  const absenceForm = document.getElementById("absence-request-form");
  if(absenceForm){
    absenceForm.addEventListener("submit", async e=>{
      e.preventDefault();
      const errEl = document.getElementById("absence-request-error");
      const fd = new FormData(absenceForm);
      fd.set("type", "absence");
      try{
        await api("/requests/mine", { method:"POST", body:fd, isForm:true });
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  }
  const specialForm = document.getElementById("special-request-form");
  if(specialForm){
    specialForm.addEventListener("submit", async e=>{
      e.preventDefault();
      const errEl = document.getElementById("special-request-error");
      const fd = new FormData(specialForm);
      try{
        await api("/requests/mine", { method:"POST", body:{
          type:"special", title: fd.get("title"), details: fd.get("details")
        }});
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  }
  const editReqForm = document.getElementById("edit-request-form");
  if(editReqForm){
    editReqForm.addEventListener("submit", async e=>{
      e.preventDefault();
      const errEl = document.getElementById("edit-request-error");
      const fd = new FormData(editReqForm);
      try{
        await api("/requests/mine", { method:"POST", body:{
          type:"edit", fieldKey: fd.get("fieldKey"), newValue: fd.get("newValue"), details: fd.get("details")
        }});
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  }

  /* ---- Referee: edit/cancel-edit/delete their own pending or rejected requests ---- */
  document.querySelectorAll('[data-action="my-request-edit-toggle"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-reqid");
      const holder = document.getElementById(`my-request-edit-form-${id}`);
      if(!holder) return;
      const isOpen = holder.style.display !== "none";
      if(isOpen){ holder.style.display = "none"; holder.innerHTML = ""; return; }
      const r = (CACHE.myRequests||[]).find(x=>x.id===id);
      if(!r) return;
      holder.innerHTML = myRequestEditFormHtml(r);
      holder.style.display = "";
      const form = holder.querySelector(`[data-my-request-edit-form="${id}"]`);
      if(form){
        form.addEventListener("submit", async ev=>{
          ev.preventDefault();
          const fd = new FormData(form);
          const type = form.getAttribute("data-req-type");
          try{
            if(type === "absence"){
              await api(`/requests/mine/${id}`, { method:"PUT", body:fd, isForm:true });
            } else {
              const body = {};
              for(const [k,v] of fd.entries()) body[k] = v;
              await api(`/requests/mine/${id}`, { method:"PUT", body });
            }
            render();
          }catch(err){ alert(err.message); }
        });
      }
    });
  });
  document.querySelectorAll('[data-action="my-request-cancel-edit"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-reqid");
      const holder = document.getElementById(`my-request-edit-form-${id}`);
      if(holder){ holder.style.display = "none"; holder.innerHTML = ""; }
    });
  });
  document.querySelectorAll('[data-action="my-request-delete"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      if(!confirm("هل تريد حذف هذا الطلب نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.")) return;
      btn.disabled = true;
      try{
        await api(`/requests/mine/${id}`, { method:"DELETE" });
        render();
      }catch(err){
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  /* ---- Admin: approve/reject referee requests ---- */
  document.querySelectorAll('[data-action="request-approve"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      const noteEl = document.querySelector(`[data-admin-request-note="${id}"]`);
      const errEl = document.getElementById("admin-request-error");
      try{
        await api(`/admin/requests/${id}/approve`, { method:"POST", body:{ adminNote: noteEl ? noteEl.value : "" }});
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });
  document.querySelectorAll('[data-action="request-reject"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      const noteEl = document.querySelector(`[data-admin-request-note="${id}"]`);
      const errEl = document.getElementById("admin-request-error");
      try{
        await api(`/admin/requests/${id}/reject`, { method:"POST", body:{ adminNote: noteEl ? noteEl.value : "" }});
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });
  document.querySelectorAll('[data-action="request-revoke"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      const errEl = document.getElementById("admin-request-error");
      try{
        await api(`/admin/requests/${id}/revoke`, { method:"POST" });
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });
  document.querySelectorAll('[data-action="request-clarify"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      const noteEl = document.querySelector(`[data-admin-request-note="${id}"]`);
      const errEl = document.getElementById("admin-request-error");
      const note = noteEl ? noteEl.value.trim() : "";
      if(!note){ if(errEl) errEl.innerHTML = `<div class="error-msg">يرجى كتابة ملاحظة توضح للحكم ما المطلوب منه قبل طلب التوضيح.</div>`; return; }
      try{
        await api(`/admin/requests/${id}/request-clarification`, { method:"POST", body:{ adminNote: note }});
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });
  document.querySelectorAll('[data-action="admin-request-delete"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-reqid");
      if(!confirm("هل تريد حذف هذا الطلب نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.")) return;
      const errEl = document.getElementById("admin-request-error");
      try{
        await api(`/admin/requests/${id}`, { method:"DELETE" });
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });

  /* ---- Admin: edit a request's content directly ---- */
  document.querySelectorAll('[data-action="admin-request-edit-toggle"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-reqid");
      const holder = document.getElementById(`admin-request-edit-form-${id}`);
      if(!holder) return;
      const isOpen = holder.style.display !== "none";
      if(isOpen){ holder.style.display = "none"; holder.innerHTML = ""; return; }
      const r = (CACHE.adminRequests||[]).find(x=>x.id===id);
      if(!r) return;
      holder.innerHTML = adminRequestEditFormHtml(r);
      holder.style.display = "";
      const form = holder.querySelector(`[data-admin-request-edit-form="${id}"]`);
      if(form){
        form.addEventListener("submit", async ev=>{
          ev.preventDefault();
          const fd = new FormData(form);
          const body = {};
          for(const [k,v] of fd.entries()) body[k] = v;
          try{
            await api(`/admin/requests/${id}`, { method:"PUT", body });
            render();
          }catch(err){ alert(err.message); }
        });
      }
    });
  });
  document.querySelectorAll('[data-action="admin-request-cancel-edit"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-reqid");
      const holder = document.getElementById(`admin-request-edit-form-${id}`);
      if(holder){ holder.style.display = "none"; holder.innerHTML = ""; }
    });
  });

  /* ---- Wizard ---- */
  const wizardForm = document.getElementById("wizard-form");
  if(wizardForm){
    const app = CACHE.myApp;

    if(WIZ_STEP < FIELD_GROUPS.length){
      const metaByName = {};
      FIELD_GROUPS[WIZ_STEP].fields.forEach(f=>{ metaByName[f.key] = f; });
      wizardForm._validateFields = wireFormValidation(wizardForm, metaByName);
    } else {
      wizardForm._validateFields = null;
    }
    const declarationChk = document.getElementById("declaration-check");
    if(declarationChk){
      declarationChk.addEventListener("change", ()=>{
        if(declarationChk.checked){
          const msgEl = document.getElementById("declaration-error");
          if(msgEl) msgEl.textContent = "";
          declarationChk.closest(".field")?.classList.remove("field-invalid");
        }
      });
    }

    wizardForm.querySelectorAll('[data-doc-input]').forEach(input=>{
      input.addEventListener("change", async ()=>{
        const key = input.getAttribute("data-doc-input");
        const file = input.files[0];
        if(!file) return;
        const statusEl = document.querySelector(`[data-doc-status="${key}"]`);
        if(statusEl) statusEl.textContent = "جارِ الرفع...";
        try{
          const fd = new FormData();
          fd.append("file", file);
          const { application } = await api(`/applications/mine/documents/${key}`, { method:"POST", body:fd, isForm:true });
          CACHE.myApp = application;
          render();
        }catch(err){
          alert(err.message);
          render();
        }
      });
    });

    document.querySelectorAll('[data-action="wiz-goto"]').forEach(el=>{
      el.addEventListener("click", async ()=>{
        const payload = collectStepFields(app);
        if(payload) { try{ const { application } = await api("/applications/mine", { method:"PUT", body:payload }); CACHE.myApp = application; }catch(e){} }
        WIZ_STEP = parseInt(el.getAttribute("data-idx"));
        render();
      });
    });

    const prevBtn = wizardForm.querySelector('[data-action="wiz-prev"]');
    if(prevBtn) prevBtn.addEventListener("click", async ()=>{
      const payload = collectStepFields(app);
      if(payload) { try{ const { application } = await api("/applications/mine", { method:"PUT", body:payload }); CACHE.myApp = application; }catch(e){} }
      WIZ_STEP = Math.max(0, WIZ_STEP-1);
      render();
    });

    wizardForm.addEventListener("submit", async e=>{
      e.preventDefault();
      if(!validateStepClientSide()) return;
      const payload = collectStepFields(app);
      const totalSteps = FIELD_GROUPS.length + 2;
      const errEl = document.getElementById("form-error");
      try{
        if(payload){ const { application } = await api("/applications/mine", { method:"PUT", body:payload }); CACHE.myApp = application; }
        if(WIZ_STEP < totalSteps-1){
          WIZ_STEP += 1; render();
        } else if(app.status === "pending_review"){
          WIZ_STEP = 0;
          go("dashboard");
        } else {
          const { application } = await api("/applications/mine/submit", { method:"POST" });
          CACHE.myApp = application;
          WIZ_STEP = 0;
          go("dashboard");
        }
      }catch(err){
        if(errEl){
          let msg = err.message;
          if(err.data && (err.data.missingFields||[]).length){ msg += " — الحقول الناقصة: " + err.data.missingFields.join("، "); }
          if(err.data && (err.data.missingDocs||[]).length){ msg += " — الوثائق الناقصة: " + err.data.missingDocs.join("، "); }
          errEl.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
        }
      }
    });
  }

  /* ---- Admin review ---- */
  document.querySelectorAll('[data-action="toggle-flag"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-field");
      if(REVIEW_DRAFT.flags[key]!==undefined) delete REVIEW_DRAFT.flags[key]; else REVIEW_DRAFT.flags[key] = "";
      render();
    });
  });
  document.querySelectorAll('[data-action="toggle-doc-flag"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.getAttribute("data-doc");
      if(REVIEW_DRAFT.docFlags[key]!==undefined) delete REVIEW_DRAFT.docFlags[key]; else REVIEW_DRAFT.docFlags[key] = "";
      render();
    });
  });
  document.querySelectorAll('[data-flag-note]').forEach(ta=>{
    ta.addEventListener("input", ()=>{ REVIEW_DRAFT.flags[ta.getAttribute("data-flag-note")] = ta.value; });
  });
  document.querySelectorAll('[data-flag-doc-note]').forEach(ta=>{
    ta.addEventListener("input", ()=>{ REVIEW_DRAFT.docFlags[ta.getAttribute("data-flag-doc-note")] = ta.value; });
  });

  const approveBtn = document.querySelector('[data-action="admin-approve"]');
  if(approveBtn) approveBtn.addEventListener("click", async ()=>{
    if(!confirm("هل انتهيت من مراجعة جميع معلومات الحكم ووثائقه؟ سيتم قبول الملف وإصدار وثيقة الانخراط فورًا.")) return;
    const errEl = document.getElementById("review-error");
    try{
      await api(`/admin/applications/${REVIEW_DRAFT.id}/approve`, { method:"POST" });
      REVIEW_DRAFT = null;
      go("admin");
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });
  const rejectBtn = document.querySelector('[data-action="admin-reject"]');
  if(rejectBtn) rejectBtn.addEventListener("click", async ()=>{
    if(!confirm("هل انتهيت من مراجعة جميع معلومات الحكم ووثائقه؟ سيتم رفض الملف وإرسال الملاحظات المسجَّلة إلى الحكم لتصحيحها.")) return;
    const errEl = document.getElementById("review-error");
    const summaryEl = document.getElementById("rejection-summary");
    try{
      await api(`/admin/applications/${REVIEW_DRAFT.id}/reject`, { method:"POST", body:{
        flags: REVIEW_DRAFT.flags, docFlags: REVIEW_DRAFT.docFlags, rejectionSummary: summaryEl ? summaryEl.value : ""
      }});
      REVIEW_DRAFT = null;
      go("admin");
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });

  const revokeBtn = document.querySelector('[data-action="admin-revoke"]');
  if(revokeBtn) revokeBtn.addEventListener("click", async ()=>{
    const appId = revokeBtn.getAttribute("data-appid");
    if(!confirm("هل تريد التراجع عن الموافقة على هذا الملف؟ ستُلغى وثيقة الانخراط الصادرة ويعود الملف إلى قائمة \"قيد المراجعة\".")) return;
    const errEl = document.getElementById("review-error");
    try{
      await api(`/admin/applications/${appId}/revoke`, { method:"POST" });
      REVIEW_DRAFT = null;
      render();
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });

  /* ---- Admin: side-by-side review & audit screen (pageAdminAudit) ---- */
  document.querySelectorAll('[data-action="audit-select-doc"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(btn.disabled) return;
      AUDIT_ACTIVE_DOC = btn.getAttribute("data-doc");
      AUDIT_IMG_ZOOM = 1;
      AUDIT_IMG_PAN = { x:0, y:0 };
      render();
    });
  });
  document.querySelectorAll('[data-action="audit-tab"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      AUDIT_MOBILE_TAB = btn.getAttribute("data-tab");
      render();
    });
  });
  document.querySelectorAll('[data-action="audit-mark"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      if(!AUDIT_ACTIVE_DOC || !REVIEW_DRAFT) return;
      const status = btn.getAttribute("data-status");
      const existingNoteEl = document.getElementById("audit-reject-note");
      const note = status === "rejected" ? (existingNoteEl ? existingNoteEl.value : "") : "";
      const errEl = document.getElementById("review-error");
      try{
        await api(`/admin/applications/${REVIEW_DRAFT.id}/doc-review`, { method:"PUT", body:{ docId: AUDIT_ACTIVE_DOC, status, note } });
        // Keep REVIEW_DRAFT (which the approve/reject buttons' enabled
        // state and the actual /reject payload both read) in sync with
        // this doc-review mark, without waiting for a full reload.
        if(status === "rejected") REVIEW_DRAFT.docFlags[AUDIT_ACTIVE_DOC] = note;
        else delete REVIEW_DRAFT.docFlags[AUDIT_ACTIVE_DOC];
        render();
      }catch(err){
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  });
  const auditRejectNote = document.getElementById("audit-reject-note");
  if(auditRejectNote){
    auditRejectNote.addEventListener("blur", async ()=>{
      if(!AUDIT_ACTIVE_DOC || !REVIEW_DRAFT) return;
      REVIEW_DRAFT.docFlags[AUDIT_ACTIVE_DOC] = auditRejectNote.value;
      try{
        await api(`/admin/applications/${REVIEW_DRAFT.id}/doc-review`, { method:"PUT", body:{ docId: AUDIT_ACTIVE_DOC, status:"rejected", note: auditRejectNote.value } });
      }catch(err){ /* best-effort save; the note stays in REVIEW_DRAFT either way and is sent again with the final reject action */ }
    });
  }
  /* Simple zoom/pan for image documents in the audit preview pane — PDFs
     use the browser's native viewer (see auditPreviewInnerHtml) which
     already has its own zoom/pan/page navigation, so none of this applies
     to them. */
  (function wireAuditImageZoom(){
    const wrap = document.getElementById("audit-img-wrap");
    const img = document.getElementById("audit-img");
    if(!wrap || !img) return;
    const applyTransform = ()=>{ img.style.transform = `translate(${AUDIT_IMG_PAN.x}px, ${AUDIT_IMG_PAN.y}px) scale(${AUDIT_IMG_ZOOM})`; };
    applyTransform();
    const zoomIn = document.querySelector('[data-action="audit-zoom-in"]');
    const zoomOut = document.querySelector('[data-action="audit-zoom-out"]');
    const zoomReset = document.querySelector('[data-action="audit-zoom-reset"]');
    if(zoomIn) zoomIn.addEventListener("click", ()=>{ AUDIT_IMG_ZOOM = Math.min(4, AUDIT_IMG_ZOOM + 0.25); applyTransform(); });
    if(zoomOut) zoomOut.addEventListener("click", ()=>{ AUDIT_IMG_ZOOM = Math.max(0.5, AUDIT_IMG_ZOOM - 0.25); if(AUDIT_IMG_ZOOM===1) AUDIT_IMG_PAN={x:0,y:0}; applyTransform(); });
    if(zoomReset) zoomReset.addEventListener("click", ()=>{ AUDIT_IMG_ZOOM = 1; AUDIT_IMG_PAN = {x:0,y:0}; applyTransform(); });
    // Drag-to-pan (mouse + touch, via Pointer Events) — only meaningful once zoomed in.
    let dragging = false, startX = 0, startY = 0, panStart = {x:0,y:0};
    wrap.addEventListener("pointerdown", (e)=>{
      if(AUDIT_IMG_ZOOM <= 1) return;
      dragging = true; startX = e.clientX; startY = e.clientY; panStart = {...AUDIT_IMG_PAN};
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener("pointermove", (e)=>{
      if(!dragging) return;
      AUDIT_IMG_PAN = { x: panStart.x + (e.clientX - startX), y: panStart.y + (e.clientY - startY) };
      applyTransform();
    });
    const endDrag = ()=>{ dragging = false; };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
    wrap.addEventListener("pointerleave", endDrag);
  })();

  /* ---- Admin: directly edit a referee's application data ---- */
  const adminEditToggle = document.querySelector('[data-action="admin-edit-toggle"]');
  if(adminEditToggle) adminEditToggle.addEventListener("click", ()=>{
    ADMIN_EDIT_MODE = !ADMIN_EDIT_MODE;
    render();
  });
  const adminEditForm = document.getElementById("admin-edit-fields-form");
  if(adminEditForm && ADMIN_EDIT_MODE){
    adminEditForm.addEventListener("submit", async e=>{
      e.preventDefault();
      const errEl = document.getElementById("admin-edit-error");
      const fields = {};
      adminEditForm.querySelectorAll('[data-admin-edit-field]').forEach(inp=>{
        fields[inp.name] = inp.value;
      });
      try{
        await api(`/admin/applications/${REVIEW_DRAFT.id}`, { method:"PUT", body:{ fields }});
        ADMIN_EDIT_MODE = false;
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  }

  /* ---- Admin: registration control panel ---- */
  const regOpenSwitch = document.getElementById("reg-open-switch");
  if(regOpenSwitch){
    regOpenSwitch.addEventListener("change", ()=>{
      const label = document.getElementById("reg-open-switch-label");
      if(label) label.textContent = regOpenSwitch.checked ? "التسجيل مفتوح" : "التسجيل مغلق يدويًا";
    });
  }
  document.querySelectorAll('input[name="registration_mode"]').forEach(radio=>{
    radio.addEventListener("change", ()=>{
      const field = document.getElementById("reg-deadline-field");
      if(field) field.style.display = radio.value === "timer" && radio.checked ? "" : (radio.checked ? "none" : field.style.display);
    });
  });
  const adminSettingsForm = document.getElementById("admin-settings-form");
  if(adminSettingsForm) adminSettingsForm.addEventListener("submit", async e=>{
    e.preventDefault();
    const errEl = document.getElementById("admin-settings-error");
    const infoEl = document.getElementById("admin-settings-info");
    if(errEl) errEl.innerHTML = "";
    if(infoEl) infoEl.innerHTML = "";
    const fd = new FormData(adminSettingsForm);
    const mode = fd.get("registration_mode");
    const deadlineLocal = fd.get("registration_deadline");
    const body = {
      is_registration_open: !!(regOpenSwitch && regOpenSwitch.checked),
      registration_mode: mode,
    };
    if(mode === "timer"){
      if(!deadlineLocal){ if(errEl) errEl.innerHTML = `<div class="error-msg">يرجى تحديد تاريخ ووقت انتهاء التسجيل.</div>`; return; }
      body.registration_deadline = new Date(deadlineLocal).toISOString();
    }else{
      body.registration_deadline = null;
    }
    try{
      await api("/admin/settings/registration", { method:"PUT", body });
      if(infoEl) infoEl.innerHTML = `<div class="info-msg">✔ تم حفظ إعدادات التسجيل بنجاح.</div>`;
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });

  /* ---- Admin: whole-platform kill switch ("حالة الموقع") ----
     Confirms before disabling (the switch reverts if the admin cancels),
     since this locks every referee out of the platform immediately. No
     confirmation is needed to re-enable. */
  const siteEnabledSwitch = document.getElementById("site-enabled-switch");
  if(siteEnabledSwitch){
    let previousChecked = siteEnabledSwitch.checked;
    siteEnabledSwitch.addEventListener("change", async ()=>{
      const label = document.getElementById("site-enabled-switch-label");
      const errEl = document.getElementById("site-status-error");
      const infoEl = document.getElementById("site-status-info");
      if(errEl) errEl.innerHTML = "";
      if(infoEl) infoEl.innerHTML = "";
      const turningOff = !siteEnabledSwitch.checked;
      if(turningOff && !confirm("هل أنت متأكد من تعطيل الموقع؟ عند التعطيل لن يتمكن الحكام من تسجيل الدخول أو إنشاء حسابات جديدة.")){
        siteEnabledSwitch.checked = previousChecked;
        return;
      }
      try{
        const result = await api("/admin/settings/site-status", { method:"PUT", body:{ site_enabled: siteEnabledSwitch.checked }});
        previousChecked = result.site_enabled;
        if(label) label.textContent = result.site_enabled ? "🟢 الموقع مفعل" : "🔴 الموقع معطل";
        if(infoEl) infoEl.innerHTML = result.site_enabled
          ? `<div class="info-msg">✔ تم تفعيل الموقع بنجاح.</div>`
          : `<div class="info-msg">✔ تم تعطيل الموقع. لن يتمكن الحكام من تسجيل الدخول أو إنشاء حسابات جديدة إلى أن تُعيد تفعيله.</div>`;
      }catch(err){
        siteEnabledSwitch.checked = previousChecked;
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  /* ---- Admin: document requirements management ---- */
  function wireDocReqTemplateToggle(checkboxEl, fieldEl){
    if(!checkboxEl || !fieldEl) return;
    checkboxEl.addEventListener("change", ()=>{ fieldEl.style.display = checkboxEl.checked ? "" : "none"; });
  }
  wireDocReqTemplateToggle(document.getElementById("doc-req-add-hastemplate"), document.getElementById("doc-req-add-template-field"));
  document.querySelectorAll('[id^="doc-req-hastemplate-"]').forEach(cb=>{
    const id = cb.id.replace("doc-req-hastemplate-", "");
    wireDocReqTemplateToggle(cb, document.getElementById(`doc-req-template-field-${id}`));
  });

  // Icon picker: preset <select> and free-text custom emoji field stay in
  // sync, and both drive the little live preview badge next to them.
  function wireDocIconPicker(idSuffix){
    const preview = document.getElementById(`doc-req-icon-preview-${idSuffix}`);
    const select = document.getElementById(`doc-req-icon-select-${idSuffix}`);
    const custom = document.getElementById(`doc-req-icon-custom-${idSuffix}`);
    if(!preview || !select || !custom) return;
    const refresh = ()=>{ preview.textContent = (custom.value||"").trim() || select.value || "📎"; };
    select.addEventListener("change", refresh);
    custom.addEventListener("input", refresh);
  }
  function finalDocIcon(idSuffix){
    const select = document.getElementById(`doc-req-icon-select-${idSuffix}`);
    const custom = document.getElementById(`doc-req-icon-custom-${idSuffix}`);
    const customVal = custom ? custom.value.trim() : "";
    return customVal || (select ? select.value : "📎") || "📎";
  }
  wireDocIconPicker("new");
  document.querySelectorAll('[id^="doc-req-icon-select-"]').forEach(sel=>{
    const id = sel.id.replace("doc-req-icon-select-", "");
    if(id !== "new") wireDocIconPicker(id);
  });

  const docReqAddForm = document.getElementById("doc-req-add-form");
  if(docReqAddForm) docReqAddForm.addEventListener("submit", async e=>{
    e.preventDefault();
    const errEl = document.getElementById("doc-req-add-error");
    if(errEl) errEl.innerHTML = "";
    const hasTemplate = document.getElementById("doc-req-add-hastemplate").checked;
    const fd = new FormData(docReqAddForm);
    fd.set("isRequired", docReqAddForm.elements["isRequired"].checked ? "true" : "false");
    fd.set("hasTemplate", hasTemplate ? "true" : "false");
    fd.set("icon", finalDocIcon("new"));
    fd.delete("iconCustom");
    if(!hasTemplate) fd.delete("template");
    try{
      await api("/admin/document-requirements", { method:"POST", body:fd, isForm:true });
      CACHE.docRequirements = null;
      render();
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });

  document.querySelectorAll('[data-action="doc-req-edit"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      ADMIN_DOC_REQ_EDIT_ID = btn.getAttribute("data-id");
      render();
    });
  });
  document.querySelectorAll('[data-action="doc-req-cancel-edit"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{ ADMIN_DOC_REQ_EDIT_ID = null; render(); });
  });
  document.querySelectorAll('[data-doc-req-edit-form]').forEach(form=>{
    const id = form.getAttribute("data-doc-req-edit-form");
    form.addEventListener("submit", async e=>{
      e.preventDefault();
      const errEl = document.getElementById(`doc-req-edit-error-${id}`);
      if(errEl) errEl.innerHTML = "";
      const hasTemplate = form.elements["hasTemplate"].checked;
      const fd = new FormData(form);
      fd.set("isRequired", form.elements["isRequired"].checked ? "true" : "false");
      fd.set("hasTemplate", hasTemplate ? "true" : "false");
      fd.set("icon", finalDocIcon(id));
      fd.delete("iconCustom");
      if(!hasTemplate){ fd.delete("template"); fd.set("removeTemplate", "true"); }
      try{
        await api(`/admin/document-requirements/${id}`, { method:"PUT", body:fd, isForm:true });
        CACHE.docRequirements = null;
        ADMIN_DOC_REQ_EDIT_ID = null;
        render();
      }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
    });
  });
  document.querySelectorAll('[data-action="doc-req-delete"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-id");
      const title = btn.getAttribute("data-title");
      if(!confirm(`هل تريد حذف وثيقة "${title}" من قائمة المتطلبات؟ لن يتم حذف الملفات التي سبق للحكام رفعها لهذه الوثيقة.`)) return;
      try{
        await api(`/admin/document-requirements/${id}`, { method:"DELETE" });
        CACHE.docRequirements = null;
        render();
      }catch(err){ alert(err.message); }
    });
  });
}
