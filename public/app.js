/* =========================================================
   LWF EL OUED — Referee Registration Platform (client)
   Talks to the Node/Express API — no data stored in the browser
   except the login token, so the same account works from any device.
   ========================================================= */

const SEASON = "2026/2027";
const SESSION_KEY = "lwf_session"; // { token, user }

const FIELD_GROUPS = [
  {
    key: "personal", title: "المعلومات الشخصية",
    fields: [
      { key: "fullName", label: "اللقب والاسم", type: "text", required: true },
      { key: "birthDate", label: "تاريخ الازدياد", type: "date", required: true },
      { key: "birthPlace", label: "مكان الازدياد", type: "text", required: true },
      { key: "maritalStatus", label: "الحالة العائلية", type: "select", required: true, options: ["أعزب","متزوج(ة)","مطلق(ة)","أرمل(ة)"] },
      { key: "educationLevel", label: "المستوى التعليمي", type: "text", required: true },
      { key: "address", label: "العنوان الشخصي", type: "textarea", required: true, full: true },
    ]
  },
  {
    key: "contact", title: "معلومات الاتصال",
    fields: [
      { key: "phone1", label: "رقم الهاتف", type: "tel", required: true },
      { key: "phone2", label: "الرقم الثاني (اختياري)", type: "tel", required: false },
      { key: "email", label: "البريد الإلكتروني", type: "email", required: true },
      { key: "job", label: "الوظيفة", type: "text", required: true },
      { key: "emergencyName", label: "اسم الشخص المتصل به في حالة الطوارئ", type: "text", required: true },
      { key: "emergencyPhone", label: "رقم هاتف شخص الطوارئ", type: "tel", required: true },
      { key: "ccp", label: "رقم الحساب الجاري البريدي (CCP)", type: "text", required: true, full: true },
    ]
  },
  {
    key: "refereeing", title: "معلومات التحكيم",
    fields: [
      { key: "clubMember", label: "هل تنتمي إلى نادٍ؟", type: "radio", required: true, options: ["نعم","لا"] },
      { key: "clubName", label: "اسم النادي (إن وجد)", type: "text", required: false },
      { key: "avoidClubs", label: "النوادي التي قد تتجنبها", type: "text", required: false, full: true },
      { key: "refStartDate", label: "تاريخ الدخول في التحكيم", type: "date", required: true },
      { key: "refLevel", label: "الترقية (المستوى الحالي)", type: "text", required: true },
      { key: "availableWeekly", label: "هل أنت متاح خلال الأسبوع؟", type: "radio", required: true, options: ["نعم","لا"] },
      { key: "shoeSize", label: "مقاس الحذاء", type: "text", required: true },
      { key: "clothingSize", label: "مقاس اللباس", type: "text", required: true },
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
function applyAdminAppsFilter(){
  const table = document.getElementById("admin-apps-table");
  if(!table) return;
  const query = (document.getElementById("admin-apps-search")?.value || "").trim().toLowerCase();
  const rows = table.querySelectorAll("tbody tr");
  let visibleCount = 0;
  rows.forEach(row=>{
    const matchesStatus = ADMIN_APPS_STATUS_FILTER === "all" || row.getAttribute("data-status") === ADMIN_APPS_STATUS_FILTER;
    const matchesQuery = !query || (row.getAttribute("data-search")||"").includes(query);
    const visible = matchesStatus && matchesQuery;
    row.style.display = visible ? "" : "none";
    if(visible) visibleCount++;
  });
  const emptyEl = document.getElementById("admin-apps-empty");
  if(emptyEl) emptyEl.style.display = visibleCount === 0 ? "" : "none";
  table.style.display = visibleCount === 0 ? "none" : "";
}
function applyAdminUsersFilter(){
  const table = document.getElementById("admin-users-table");
  if(!table) return;
  const query = (document.getElementById("admin-users-search")?.value || "").trim().toLowerCase();
  const rows = table.querySelectorAll("tbody tr");
  let visibleCount = 0;
  rows.forEach(row=>{
    const visible = !query || (row.getAttribute("data-search")||"").includes(query);
    row.style.display = visible ? "" : "none";
    if(visible) visibleCount++;
  });
  const emptyEl = document.getElementById("admin-users-empty");
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
let ADMIN_APPS_STATUS_FILTER = "all";
let ADMIN_EDIT_MODE = false;
let REG_STATUS = null; // cached response of GET /settings/registration, refreshed whenever pageHome/pageAdminSettings loads
let REG_COUNTDOWN_TIMER = null;

async function render(){
  const root = document.getElementById("app");
  let session = getSession();
  const route = currentRoute();
  const seg = route.split("/")[0];

  if(REG_COUNTDOWN_TIMER){ clearInterval(REG_COUNTDOWN_TIMER); REG_COUNTDOWN_TIMER = null; }

  if(window.LWFChat) window.LWFChat.beforeRouteChange();

  // accountStatus can change server-side (admin activates the account)
  // without the referee logging out — refresh it here so the guards below
  // always see the current value instead of whatever was cached at login.
  if(session && session.user.role === "referee"){
    try{
      const { user } = await api("/auth/me");
      if(user.accountStatus !== session.user.accountStatus){
        session = { ...session, user: { ...session.user, accountStatus: user.accountStatus } };
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
  if(["dashboard","form","certificate","profile","requests","announcements","announcement"].includes(seg)){
    if(!session || session.user.role !== "referee"){ go("home"); return; }
  }
  // A referee whose account isn't activated yet only ever sees the dashboard
  // (which renders the "pending" notice, see pageDashboard) and the chat.
  const PENDING_LOCKED_SEGS = ["form","certificate","profile","requests","announcements","announcement"];
  if(session && session.user.role === "referee" && session.user.accountStatus === "pending" && PENDING_LOCKED_SEGS.includes(seg)){
    go("dashboard"); return;
  }
  if(seg === "account" || seg === "chat"){
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
      case "admin": slot.innerHTML = await pageAdminList(); break;
      case "admin-users": slot.innerHTML = await pageAdminUsers(); break;
      case "admin-review": slot.innerHTML = await pageAdminReview(route.split("/")[1]); break;
      case "admin-requests": slot.innerHTML = await pageAdminRequests(); break;
      case "admin-announcements": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.adminListPage() : ""; break;
      case "admin-announcement-edit": slot.innerHTML = window.LWFAnnouncements ? await window.LWFAnnouncements.adminEditPage(route.split("/")[1]) : ""; break;
      case "admin-settings": slot.innerHTML = await pageAdminSettings(); break;
      case "admin-doc-requirements": slot.innerHTML = await pageAdminDocRequirements(); break;
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
  window.scrollTo({top:0, behavior:"instant"});
}

/* ---------- Chrome ---------- */
function chatNavLink(){
  return `<a href="#/chat" class="btn btn-outline btn-sm chat-nav-link">💬 الدردشة<span id="chat-unread-badge" class="chat-nav-badge" style="display:none;"></span></a>`;
}

function topbar(session){
  let actions = "";
  if(session && session.user.role === "referee"){
    actions = `
      <span class="pill status-ok">مرحبًا، ${escapeHtml(session.user.fullName)}</span>
      <a href="#/dashboard" class="btn btn-outline btn-sm">لوحتي</a>
      <a href="#/announcements" id="announcements-nav-link" class="btn btn-outline btn-sm" style="display:none;">📢 الإعلانات<span id="announcements-unread-badge" class="chat-nav-badge" style="display:none;"></span></a>
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
      ${chatNavLink()}
      <a href="#/account" class="btn btn-ghost btn-sm" title="تغيير كلمة السر">⚙ حسابي</a>
      <button class="btn btn-ghost btn-sm" data-action="logout">تسجيل الخروج</button>`;
  } else {
    // No "Admin Login" entry point here on purpose — the admin panel is
    // reachable only by navigating directly to #/admin-login.
    actions = `
      <a href="#/home" class="btn btn-outline btn-sm">حساب حكم</a>`;
  }
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
        <div class="field"><label>اللقب والاسم الكامل</label><input type="text" name="fullName" required ${regClosed?'disabled':''}></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" name="username" required ${regClosed?'disabled':''}></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="email" name="email" required ${regClosed?'disabled':''}></div>
        ${passwordFieldHtml('كلمة المرور', 'password', {minlength:4, disabled:regClosed})}
        <button type="submit" class="btn btn-primary btn-block" ${regClosed?'disabled':''}>${regClosed ? 'التسجيل مغلق حالياً' : 'إنشاء الحساب والمتابعة'}</button>
      </form>`}
  </div>`;
}
function showAuthError(msg){ const el=document.getElementById("auth-error"); if(el) el.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }

function attachAuthHandlers(){
  const loginForm = document.getElementById("login-form");
  if(loginForm) loginForm.addEventListener("submit", async e=>{
    e.preventDefault();
    const fd = new FormData(loginForm);
    try{
      const { token, user } = await api("/auth/login", { method:"POST", body:{ username: fd.get("username").trim(), password: fd.get("password") }});
      setSession({ token, user });
      go(user.role==="admin" ? "admin" : "dashboard");
    }catch(err){ showAuthError(err.message); }
  });
  const signupForm = document.getElementById("signup-form");
  if(signupForm) signupForm.addEventListener("submit", async e=>{
    e.preventDefault();
    if(REG_STATUS && REG_STATUS.isOpenNow === false){ showAuthError("التسجيل مغلق حالياً"); return; }
    const fd = new FormData(signupForm);
    try{
      const { token, user } = await api("/auth/signup", { method:"POST", body:{
        fullName: fd.get("fullName").trim(), username: fd.get("username").trim(),
        email: fd.get("email").trim(), password: fd.get("password")
      }});
      setSession({ token, user });
      go("dashboard");
    }catch(err){ showAuthError(err.message); }
  });
  const adminLoginForm = document.getElementById("admin-login-form");
  if(adminLoginForm) adminLoginForm.addEventListener("submit", async e=>{
    e.preventDefault();
    const fd = new FormData(adminLoginForm);
    try{
      const { token, user } = await api("/auth/login", { method:"POST", body:{ username: fd.get("username").trim(), password: fd.get("password") }});
      if(user.role !== "admin"){ showAuthError("هذا الحساب ليس حساب إدارة."); return; }
      setSession({ token, user });
      go("admin");
    }catch(err){ showAuthError(err.message); }
  });
}

/* ============================================================
   ACCOUNT — change password (shared by referee and admin)
   ============================================================ */
function pageAccount(session){
  const backLink = session.user.role === "admin" ? `<a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى لوحة الإدارة</a>` : `<a href="#/dashboard" class="btn btn-ghost btn-sm">→ عودة إلى لوحتي</a>`;
  return `
  <div class="page page-narrow">
    ${backLink}
    <div class="panel mt-16">
      <div class="panel-header"><h3>بيانات الحساب</h3></div>
      <div class="row2">
        <div class="field"><label>الاسم الكامل</label><input type="text" value="${escapeHtml(session.user.fullName)}" disabled></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" value="${escapeHtml(session.user.username)}" disabled></div>
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
        <div class="field"><label>الاسم الكامل</label><input type="text" value="${escapeHtml(session.user.fullName)}" disabled></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="text" value="${escapeHtml(session.user.email)}" disabled></div>
      </div>
    </div>
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
  if(!form.reportValidity()) return false;
  if(WIZ_STEP === FIELD_GROUPS.length){
    const docReqs = CACHE.docRequirements || [];
    const missing = docReqs.filter(d=>d.isRequired && !CACHE.myApp.documents[d.id]);
    if(missing.length){ alert("يرجى رفع جميع الوثائق المطلوبة: " + missing.map(d=>d.title).join("، ")); return false; }
  }
  if(WIZ_STEP === FIELD_GROUPS.length + 1){
    const chk = document.getElementById("declaration-check");
    if(!chk || !chk.checked){ alert("يجب الموافقة على الإقرار للمتابعة."); return false; }
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
          <div class="k">اللقب والاسم</div>
          <div class="cert-name-value">${escapeHtml(d.fullName)}</div>
          <div class="k mt-8">تاريخ ومكان الميلاد</div>
          <div class="cert-birth-value">${fmtBirthDate(d.birthDate)} - ${escapeHtml(d.birthPlace)}</div>
        </div>
        ${app.documents.photo ? `<img class="cert-photo" src="${app.documents.photo.url}">` : ""}
      </div>

      <div class="cert-grid">
        <div class="cert-cell"><div class="k">الحالة العائلية</div><div class="v">${escapeHtml(d.maritalStatus)}</div></div>
        <div class="cert-cell"><div class="k">المستوى التعليمي</div><div class="v">${escapeHtml(d.educationLevel)}</div></div>
        <div class="cert-cell"><div class="k">العنوان الشخصي</div><div class="v">${escapeHtml(d.address)}</div></div>
        <div class="cert-cell"><div class="k">الهاتف</div><div class="v">${escapeHtml(d.phone1)}</div></div>
        <div class="cert-cell"><div class="k">البريد الإلكتروني</div><div class="v">${escapeHtml(d.email)}</div></div>
        <div class="cert-cell"><div class="k">الوظيفة</div><div class="v">${escapeHtml(d.job)}</div></div>
        <div class="cert-cell"><div class="k">رقم الحساب الجاري البريدي</div><div class="v">${escapeHtml(d.ccp)}</div></div>
        <div class="cert-cell"><div class="k">تاريخ الدخول في التحكيم</div><div class="v">${escapeHtml(d.refStartDate)}</div></div>
        <div class="cert-cell"><div class="k">الترقية</div><div class="v">${escapeHtml(d.refLevel)}</div></div>
        <div class="cert-cell"><div class="k">متاح خلال الأسبوع</div><div class="v">${escapeHtml(d.availableWeekly)}</div></div>
        <div class="cert-cell"><div class="k">مقاس الحذاء</div><div class="v">${escapeHtml(d.shoeSize)}</div></div>
        <div class="cert-cell"><div class="k">مقاس اللباس</div><div class="v">${escapeHtml(d.clothingSize)}</div></div>
      </div>

      <div class="section-title cert-declaration-title">التعهد</div>
      <p class="cert-declaration-text">${DECLARATION_TEXT}</p>

      <div class="cert-footer">
        <div>
          <div class="k text-sm muted">حرر بالوادي في</div>
          <div class="v" style="font-weight:800;margin-bottom:16px;">${fmtDate(app.approvedAt)}</div>
          <div class="k text-sm muted">إمضاء المعني</div>
          <div class="signature-line"></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   REFEREE — FULL PROFILE (available once approved)
   ============================================================ */
async function pageProfile(session){
  const { application: app } = await api("/applications/mine");
  if(!app || app.status !== "approved"){ go("dashboard"); return ""; }
  const docReqs = await ensureDocRequirements();
  const d = app.data;

  const fieldsHtml = FIELD_GROUPS.map(g=>`
    <div class="section-title">${g.title}</div>
    <div class="row2">
      ${g.fields.map(f=>`<div class="field"><label>${f.label}</label><input type="text" value="${escapeHtml(d[f.key]||"—")}" disabled></div>`).join("")}
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
function requestStatusLabel(s){ return {pending:"قيد الانتظار", approved:"مقبول", rejected:"مرفوض"}[s] || s; }

function requestTypeLabel(r){
  if(r.type==='absence') return '🗓 طلب غياب';
  if(r.type==='edit') return '✎ طلب تعديل معلومة';
  return '✉️ طلب خاص';
}

function myRequestCardHtml(r){
  const canEdit = ['pending','rejected'].includes(r.status);
  const canDelete = r.status === 'pending';
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
  return `<div class="panel" style="margin-top:14px;" id="my-request-${r.id}">
    <div class="panel-header">
      <h3>${requestTypeLabel(r)}</h3>
      <span class="status-chip ${r.status==='pending'?'pending_review':(r.status==='approved'?'approved':'rejected')}">${requestStatusLabel(r.status)}</span>
    </div>
    <div class="text-sm muted">تاريخ الإرسال: ${fmtDate(r.createdAt)}</div>
    ${bodyHtml}
    ${r.adminNote ? `<div class="text-sm mt-8" style="color:${r.status==='rejected'?'var(--red-accent)':'var(--green-deep)'};"><b>ملاحظة الإدارة:</b> ${escapeHtml(r.adminNote)}</div>` : ''}
    ${(canEdit || canDelete) ? `<div class="flex gap-12 mt-16">
      ${canEdit ? `<button type="button" class="btn btn-outline btn-sm" data-action="my-request-edit-toggle" data-reqid="${r.id}">✎ تعديل</button>` : ''}
      ${canDelete ? `<button type="button" class="btn btn-danger-outline btn-sm" data-action="my-request-delete" data-reqid="${r.id}">🗑 حذف</button>` : ''}
    </div>` : ''}
    <div id="my-request-edit-form-${r.id}" style="display:none;" class="mt-16"></div>
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
async function pageAdminList(){
  ADMIN_APPS_STATUS_FILTER = "all";
  const { applications: apps } = await api("/admin/applications");
  const { total: totalAccounts } = await api("/admin/users");
  CACHE.adminList = apps;
  const rows = apps.map(a=>{
    const searchStr = [a.data.fullName, a.data.phone1, a.data.email].filter(Boolean).join(" ").toLowerCase();
    return `<tr data-status="${a.status}" data-search="${escapeHtml(searchStr)}">
      <td>${escapeHtml(a.data.fullName || "—")}</td>
      <td>${escapeHtml(a.data.phone1||"—")}</td>
      <td>${escapeHtml(a.data.email||"—")}</td>
      <td>${fmtDate(a.submittedAt || a.updatedAt)}</td>
      <td><span class="status-chip ${a.status}">${statusLabel(a.status)}</span></td>
      <td><a href="#/admin-review/${a.id}" class="btn btn-outline btn-sm">مراجعة الملف</a></td>
    </tr>`;
  }).join("");
  const counts = {
    pending_review: apps.filter(a=>a.status==='pending_review').length,
    approved: apps.filter(a=>a.status==='approved').length,
    rejected: apps.filter(a=>a.status==='rejected').length,
  };
  return `
  <div class="page">
    <div class="panel-header" style="border:none;margin-bottom:18px;">
      <h3 style="font-size:22px;">طلبات انخراط الحكام</h3>
      <a href="#/admin-users" class="btn btn-outline btn-sm">👥 كل الحسابات المسجَّلة (${totalAccounts})</a>
    </div>
    <div class="steps-strip" style="margin-top:0;margin-bottom:20px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
      <div class="step-mini" data-action="filter-status" data-status="all" style="cursor:pointer;"><div class="num" style="background:var(--ink-soft);">${totalAccounts}</div><h4>إجمالي الحسابات</h4></div>
      <div class="step-mini" data-action="filter-status" data-status="pending_review" style="cursor:pointer;"><div class="num" style="background:#1d5b93;">${counts.pending_review}</div><h4>قيد المراجعة</h4></div>
      <div class="step-mini" data-action="filter-status" data-status="approved" style="cursor:pointer;"><div class="num" style="background:var(--green-deep);">${counts.approved}</div><h4>مقبولة</h4></div>
      <div class="step-mini" data-action="filter-status" data-status="rejected" style="cursor:pointer;"><div class="num" style="background:var(--red-accent);">${counts.rejected}</div><h4>مرفوضة</h4></div>
    </div>
    <div class="panel">
      <div class="field" style="max-width:420px;">
        <label>🔍 البحث عن حكم (بالاسم، الهاتف، أو البريد الإلكتروني)</label>
        <input type="text" id="admin-apps-search" placeholder="اكتب للبحث...">
      </div>
      ${apps.length===0 ? `<div class="empty"><div class="icon">📭</div><h3>لا توجد طلبات مرسلة بعد</h3></div>` : `
      <div class="table-wrap"><table id="admin-apps-table">
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>البريد الإلكتروني</th><th>تاريخ الإرسال</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div id="admin-apps-empty" class="empty" style="display:none;"><div class="icon">🔍</div><h3>لا توجد نتائج مطابقة</h3></div>`}
    </div>
  </div>`;
}

/* ============================================================
   ADMIN — ALL REGISTERED ACCOUNTS
   ============================================================ */
async function pageAdminUsers(){
  const { users, total } = await api("/admin/users");
  const rows = users.map(u=>{
    const searchStr = [u.fullName, u.username, u.email].filter(Boolean).join(" ").toLowerCase();
    const pending = u.accountStatus === "pending";
    return `<tr data-search="${escapeHtml(searchStr)}">
      <td>${escapeHtml(u.fullName)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td><span class="status-chip ${pending ? 'pending' : 'approved'}">${pending ? '⏳ قيد التفعيل' : '✅ مفعَّل'}</span></td>
      <td><span class="status-chip ${u.applicationStatus}">${statusLabel(u.applicationStatus)}</span></td>
      <td>${u.applicationId ? `<a href="#/admin-review/${u.applicationId}" class="btn btn-outline btn-sm">عرض الملف</a>` : `<span class="text-sm muted">لم يبدأ الاستمارة بعد</span>`}</td>
      <td>${pending
          ? `<button type="button" class="btn btn-primary btn-sm" data-action="activate-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullName)}">✅ تفعيل الحساب</button>`
          : `<button type="button" class="btn btn-outline btn-sm" data-action="deactivate-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullName)}">⏸ إيقاف الحساب</button>`}</td>
      <td><button type="button" class="btn btn-outline btn-sm" data-action="chat-with-referee" data-userid="${u.id}">💬 محادثة</button></td>
      <td><button type="button" class="btn btn-outline btn-sm" data-action="reset-password" data-userid="${u.id}" data-username="${escapeHtml(u.username)}" data-fullname="${escapeHtml(u.fullName)}">🔑 إعادة تعيين كلمة السر</button></td>
      <td><button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-referee" data-userid="${u.id}" data-fullname="${escapeHtml(u.fullName)}">🗑 حذف الحكم</button></td>
    </tr>`;
  }).join("");
  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 18px;"><h3 style="font-size:22px;">جميع الحسابات المسجَّلة (${total})</h3></div>
    <div id="reset-password-result"></div>
    <div class="panel">
      <div class="field" style="max-width:420px;">
        <label>🔍 البحث عن حكم (بالاسم، اسم المستخدم، أو البريد الإلكتروني)</label>
        <input type="text" id="admin-users-search" placeholder="اكتب للبحث...">
      </div>
      ${users.length===0 ? `<div class="empty"><div class="icon">👤</div><h3>لا يوجد أي حساب حكم مسجَّل بعد</h3></div>` : `
      <div class="table-wrap"><table id="admin-users-table">
        <thead><tr><th>الاسم الكامل</th><th>اسم المستخدم</th><th>البريد الإلكتروني</th><th>تاريخ إنشاء الحساب</th><th>حالة الحساب</th><th>حالة الملف</th><th></th><th></th><th></th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div id="admin-users-empty" class="empty" style="display:none;"><div class="icon">🔍</div><h3>لا توجد نتائج مطابقة</h3></div>`}
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
  const pending = requests.filter(r=>r.status==='pending');
  const decided = requests.filter(r=>r.status!=='pending');

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
    return `<div class="panel" style="margin-top:14px;">
      <div class="panel-header">
        <h3>${requestTypeLabel(r)} — ${escapeHtml(r.refereeName)}</h3>
        <span class="status-chip ${r.status==='pending'?'pending_review':(r.status==='approved'?'approved':'rejected')}">${requestStatusLabel(r.status)}</span>
      </div>
      <div class="text-sm muted">اسم المستخدم: ${escapeHtml(r.refereeUsername)} — تاريخ الإرسال: ${fmtDate(r.createdAt)}</div>
      ${bodyHtml}
      ${r.status!=='pending' ? `<div class="text-sm mt-8"><b>القرار الحالي:</b> ${requestStatusLabel(r.status)}${r.decidedAt ? ' بتاريخ '+fmtDate(r.decidedAt) : ''}</div>` : ""}
      <div class="field"><label>ملاحظة (اختياري، تظهر للحكم)</label><textarea data-admin-request-note="${r.id}" placeholder="ملاحظة للحكم...">${escapeHtml(r.adminNote||"")}</textarea></div>
      <div class="flex gap-12 mt-8">
        <button class="btn btn-primary btn-sm" data-action="request-approve" data-reqid="${r.id}" ${r.status==='approved'?'disabled':''}>✓ ${r.status==='pending' ? 'قبول' : 'تغيير القرار إلى قبول'}</button>
        <button class="btn btn-danger btn-sm" data-action="request-reject" data-reqid="${r.id}" ${r.status==='rejected'?'disabled':''}>✕ ${r.status==='pending' ? 'رفض' : 'تغيير القرار إلى رفض'}</button>
        ${r.status!=='pending' ? `<button class="btn btn-outline btn-sm" data-action="request-revoke" data-reqid="${r.id}">↩ إعادة لقيد الانتظار</button>` : ""}
        <button class="btn btn-outline btn-sm" data-action="admin-request-edit-toggle" data-reqid="${r.id}">✎ تعديل الطلب</button>
      </div>
      <div id="admin-request-edit-form-${r.id}" style="display:none;" class="mt-16"></div>
    </div>`;
  }

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm">→ عودة إلى طلبات الانخراط</a>
    <div class="panel-header" style="border:none;margin:16px 0 0;"><h3 style="font-size:22px;">طلبات الحكام (غياب، خاصة، وتعديل معلومة)</h3></div>
    <div id="admin-request-error"></div>
    ${requests.length===0 ? `<div class="panel mt-16"><div class="empty"><div class="icon">📭</div><h3>لا توجد طلبات من الحكام بعد</h3></div></div>` : `
      <div class="section-title" style="margin-top:20px;">قيد الانتظار (${pending.length})</div>
      ${pending.length===0 ? `<p class="text-sm muted">لا توجد طلبات معلَّقة حاليًا.</p>` : pending.map(rowHtml).join("")}
      ${decided.length ? `<div class="section-title" style="margin-top:28px;">تم البت فيها</div>${decided.map(rowHtml).join("")}` : ""}
    `}
  </div>`;
}

/* ============================================================
   ADMIN — REVIEW SINGLE APPLICATION
   ============================================================ */
async function pageAdminReview(appId){
  const { application: app } = await api("/admin/applications/" + appId);
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

  const hasFlags = Object.keys(REVIEW_DRAFT.flags).length>0 || Object.keys(REVIEW_DRAFT.docFlags).length>0;
  const canDecide = app.status === "pending_review";

  return `
  <div class="page">
    <a href="#/admin" class="btn btn-ghost btn-sm no-print">→ عودة إلى القائمة</a>
    <div class="panel mt-16 no-print">
      <div class="panel-header">
        <h3>ملف: ${escapeHtml(app.data.fullName)}</h3>
        <div class="flex gap-8">
          <span class="status-chip ${app.status}">${statusLabel(app.status)}</span>
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
    <div class="panel no-print">
      <div class="panel-header"><h3>قرار المراجعة</h3></div>
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
        <button class="btn btn-primary" data-action="admin-approve" ${(!canDecide || hasFlags)?'disabled':''}>✓ قبول الملف وإصدار وثيقة الانخراط</button>
        <button class="btn btn-danger" data-action="admin-reject" ${(!canDecide || !hasFlags)?'disabled':''}>✕ رفض الملف وإرسال الملاحظات</button>
      </div>` : `
      <div class="flex gap-12 mt-16">
        <button class="btn btn-danger-outline" data-action="admin-revoke" data-appid="${app.id}">↩ التراجع عن الموافقة وإعادة الملف للمراجعة</button>
      </div>`}
    </div>
    ${app.status === "approved" ? `
    <div class="panel">
      <div class="panel-header no-print"><h3>وثيقة الانخراط الصادرة</h3></div>
      ${certificateHtml(app)}
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
  let settings;
  try{ settings = await api("/admin/settings/registration"); }
  catch(e){ return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`; }

  const isTimer = settings.registration_mode === "timer";
  const deadlineLocal = settings.registration_deadline ? isoToDatetimeLocal(settings.registration_deadline) : "";

  return `
  <div class="page page-narrow">
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
   Global event delegation
   ============================================================ */
function attachGlobalHandlers(){
  attachAuthHandlers();
  wireRegistrationCountdown();

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

  /* ---- Admin: search & status-filter on the applications list ---- */
  const adminAppsSearch = document.getElementById("admin-apps-search");
  if(adminAppsSearch){
    adminAppsSearch.addEventListener("input", applyAdminAppsFilter);
  }
  document.querySelectorAll('[data-action="filter-status"]').forEach(card=>{
    card.addEventListener("click", ()=>{
      ADMIN_APPS_STATUS_FILTER = card.getAttribute("data-status");
      document.querySelectorAll('[data-action="filter-status"]').forEach(c=>{
        c.style.boxShadow = "";
        c.style.borderColor = "var(--line)";
      });
      card.style.boxShadow = "0 0 0 2px var(--green-deep)";
      card.style.borderColor = "var(--green-deep)";
      applyAdminAppsFilter();
    });
  });
  if(document.getElementById("admin-apps-table")) applyAdminAppsFilter();

  /* ---- Admin: search on the registered accounts list ---- */
  const adminUsersSearch = document.getElementById("admin-users-search");
  if(adminUsersSearch){
    adminUsersSearch.addEventListener("input", applyAdminUsersFilter);
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
              ✅ تم إنشاء كلمة سر جديدة لـ <b>${escapeHtml(res.fullName)}</b> (اسم المستخدم: <b>${escapeHtml(res.username)}</b>).<br>
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

  /* ---- Admin: delete a referee account entirely ---- */
  document.querySelectorAll('[data-action="delete-referee"]').forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const userId = btn.getAttribute("data-userid");
      const fullName = btn.getAttribute("data-fullname");
      if(!confirm(`هل تريد حذف حساب الحكم "${fullName}" نهائيًا؟ سيُحذف حسابه وملفه ووثائقه وكل طلباته، ولا يمكن التراجع عن هذا الإجراء.`)) return;
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
      const fd = new FormData(changePasswordForm);
      const currentPassword = fd.get("currentPassword");
      const newPassword = fd.get("newPassword");
      const confirmPassword = fd.get("confirmPassword");
      if(newPassword !== confirmPassword){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">كلمة السر الجديدة وتأكيدها غير متطابقتين.</div>`;
        return;
      }
      try{
        await api("/auth/change-password", { method:"POST", body:{ currentPassword, newPassword }});
        if(resultEl) resultEl.innerHTML = `<div class="info-msg">✅ تم تحديث كلمة السر بنجاح. استخدمها في المرة القادمة التي تسجّل فيها الدخول.</div>`;
        changePasswordForm.reset();
      }catch(err){
        if(resultEl) resultEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }

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
      if(!confirm("هل تريد حذف هذا الطلب نهائيًا؟")) return;
      try{
        await api(`/requests/mine/${id}`, { method:"DELETE" });
        render();
      }catch(err){ alert(err.message); }
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
    const errEl = document.getElementById("review-error");
    try{
      await api(`/admin/applications/${REVIEW_DRAFT.id}/approve`, { method:"POST" });
      REVIEW_DRAFT = null;
      go("admin");
    }catch(err){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`; }
  });
  const rejectBtn = document.querySelector('[data-action="admin-reject"]');
  if(rejectBtn) rejectBtn.addEventListener("click", async ()=>{
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
