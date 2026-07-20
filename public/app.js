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
const DOC_TYPES = [
  { key:"photo", label:"الصورة الشمسية", icon:"🪪" },
  { key:"birthCert", label:"شهادة الميلاد", icon:"📄" },
  { key:"idCard", label:"نسخة من بطاقة التعريف", icon:"🆔" },
  { key:"qualification", label:"نسخة من المؤهل العلمي", icon:"🎓" },
  { key:"ccpDoc", label:"نسخة من صك بريدي (CCP)", icon:"💳" },
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
  bar.innerHTML = `<span style="color:#fff;font-family:'Cairo',sans-serif;font-weight:800;font-size:15px;">${escapeHtml(title||"")}</span>`;
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
function go(hash){ location.hash = hash; }
function currentRoute(){ return (location.hash.replace(/^#\/?/, "")) || "home"; }

let CACHE = { myApp:null, adminList:null, adminReview:null };
let REVIEW_DRAFT = null;
let WIZ_STEP = 0;
let ADMIN_APPS_STATUS_FILTER = "all";
let ADMIN_EDIT_MODE = false;

async function render(){
  const root = document.getElementById("app");
  const session = getSession();
  const route = currentRoute();
  const seg = route.split("/")[0];

  if(seg.startsWith("admin") && seg !== "admin-login"){
    if(!session || session.user.role !== "admin"){ go("admin-login"); return; }
  }
  if(["dashboard","form","certificate","profile","requests"].includes(seg)){
    if(!session || session.user.role !== "referee"){ go("home"); return; }
  }
  if(seg === "account"){
    if(!session){ go("home"); return; }
  }

  root.innerHTML = topbar(session) + `<div id="page-slot"><div class="page center-txt muted">جارِ التحميل...</div></div>` + footer();
  const slot = document.getElementById("page-slot");

  try{
    switch(seg){
      case "home": slot.innerHTML = pageHome(session); break;
      case "admin-login": slot.innerHTML = pageAdminLogin(); break;
      case "dashboard": slot.innerHTML = await pageDashboard(session); break;
      case "form": slot.innerHTML = await pageForm(session); break;
      case "certificate": slot.innerHTML = await pageCertificate(session); break;
      case "profile": slot.innerHTML = await pageProfile(session); break;
      case "requests": slot.innerHTML = await pageRequests(session); break;
      case "admin": slot.innerHTML = await pageAdminList(); break;
      case "admin-users": slot.innerHTML = await pageAdminUsers(); break;
      case "admin-review": slot.innerHTML = await pageAdminReview(route.split("/")[1]); break;
      case "admin-requests": slot.innerHTML = await pageAdminRequests(); break;
      case "account": slot.innerHTML = pageAccount(session); break;
      default: slot.innerHTML = pageHome(session);
    }
  }catch(e){
    if(e.status === 401){ clearSession(); go("home"); return; }
    slot.innerHTML = `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
  }
  attachGlobalHandlers();
  window.scrollTo({top:0, behavior:"instant"});
}

/* ---------- Chrome ---------- */
function topbar(session){
  let actions = "";
  if(session && session.user.role === "referee"){
    actions = `
      <span class="pill status-ok">مرحبًا، ${escapeHtml(session.user.fullName)}</span>
      <a href="#/dashboard" class="btn btn-outline btn-sm">لوحتي</a>
      <a href="#/account" class="btn btn-ghost btn-sm" title="تغيير كلمة السر">⚙ حسابي</a>
      <button class="btn btn-ghost btn-sm" data-action="logout">تسجيل الخروج</button>`;
  } else if(session && session.user.role === "admin"){
    actions = `
      <span class="pill status-ok">لوحة الإدارة</span>
      <a href="#/admin" class="btn btn-outline btn-sm">طلبات الانخراط</a>
      <a href="#/admin-requests" class="btn btn-outline btn-sm">طلبات الحكام</a>
      <a href="#/account" class="btn btn-ghost btn-sm" title="تغيير كلمة السر">⚙ حسابي</a>
      <button class="btn btn-ghost btn-sm" data-action="logout">تسجيل الخروج</button>`;
  } else {
    actions = `
      <a href="#/home" class="btn btn-outline btn-sm">حساب حكم</a>
      <a href="#/admin-login" class="btn btn-ghost btn-sm">دخول الإدارة</a>`;
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
      <div class="nav-actions">${actions}</div>
    </div>
  </header>`;
}
function footer(){
  return `<footer class="site-footer">الرابطة الولائية لكرة القدم الوادي · شارع صلاح الدين الأيوبي - الوادي · lwf39eloued@gmail.com · 032.14.63.16</footer>`;
}

/* ============================================================
   HOME / AUTH
   ============================================================ */
function pageHome(session){
  if(session && session.user.role==="referee"){ go("dashboard"); return ""; }
  return `
  <div class="page">
    <section class="hero">
      <span class="hero-eyebrow">استمارة انخراط الحكام · موسم ${SEASON}</span>
      <h2>سجّل انخراطك كحكم رسمي لدى<br>الرابطة الولائية لكرة القدم الوادي</h2>
      <p>أنشئ حسابك، أدخل معلوماتك الشخصية والتحكيمية، ارفع الوثائق المطلوبة، وأرسل ملفك. تراجع الإدارة ملفك وتصدر لك وثيقة الانخراط الرسمية فور الموافقة.</p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="show-auth" data-tab="signup">إنشاء حساب حكم جديد</button>
        <button class="btn btn-outline" data-action="show-auth" data-tab="login">لدي حساب بالفعل</button>
      </div>
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

function authForm(tab){
  const isLogin = tab !== "signup";
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
        <div class="field"><label>كلمة المرور</label><input type="password" name="password" required></div>
        <button type="submit" class="btn btn-primary btn-block">دخول</button>
      </form>` : `
      <form id="signup-form">
        <div class="field"><label>اللقب والاسم الكامل</label><input type="text" name="fullName" required></div>
        <div class="field"><label>اسم المستخدم</label><input type="text" name="username" required></div>
        <div class="field"><label>البريد الإلكتروني</label><input type="email" name="email" required></div>
        <div class="field"><label>كلمة المرور</label><input type="password" name="password" minlength="4" required></div>
        <button type="submit" class="btn btn-primary btn-block">إنشاء الحساب والمتابعة</button>
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
        <div class="field"><label>كلمة السر الحالية</label><input type="password" name="currentPassword" required></div>
        <div class="field"><label>كلمة السر الجديدة</label><input type="password" name="newPassword" minlength="4" required></div>
        <div class="field"><label>تأكيد كلمة السر الجديدة</label><input type="password" name="confirmPassword" minlength="4" required></div>
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
        <div class="field"><label>كلمة المرور</label><input type="password" name="password" required></div>
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
  const { application: app } = await api("/applications/mine");
  CACHE.myApp = app;

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
          ${flaggedDocs.map(([k,note])=>{ const d=DOC_TYPES.find(d=>d.key===k); return `<li><b>${d?d.label:k} (وثيقة):</b> ${escapeHtml(note||"يرجى إعادة الرفع")}</li>`; }).join("")}
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
  const app = CACHE.myApp;
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
  else if(WIZ_STEP === FIELD_GROUPS.length) stepHtml = renderDocsStep(app);
  else stepHtml = renderReviewStep(app);

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
function renderDocsStep(app){
  const flags = app.docFlags || {};
  return `
    <div class="panel-header"><span class="badge-num">${FIELD_GROUPS.length+1}</span><h3>الوثائق المطلوبة</h3></div>
    <p class="text-sm muted">الرجاء رفع صور أو مستندات واضحة (JPG, PNG أو PDF، بحد أقصى 8MB لكل ملف). اضغط على 🔍 لمراجعة الوثيقة بحجم كبير قبل الإرسال.</p>
    <div class="uploads-grid mt-16">
      ${DOC_TYPES.map(d=>{
        const val = app.documents[d.key];
        const flagged = flags[d.key]!==undefined;
        const cls = flagged ? "rejected" : (val ? "filled" : "");
        return `<div>
          <div class="upload-box ${cls}" data-doc="${d.key}">
            <input type="file" accept="image/*,application/pdf" data-doc-input="${d.key}">
            ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img class="upload-preview" src="${val.url}">` : `<div class="icon">📎</div>`) : `<div class="icon">${d.icon}</div>`}
            <div class="label">${d.label}</div>
            <div class="sub" data-doc-status="${d.key}">${val ? (val.originalName || 'تم الرفع') : 'اضغط للرفع'}</div>
          </div>
          ${val ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" style="width:100%;margin-top:8px;" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d.label)}">🔍 عرض</button>` : ""}
          ${flagged ? `<div class="hint" style="color:var(--red-accent);font-weight:700;">⚠ ${escapeHtml(flags[d.key]||"يرجى إعادة الرفع")}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}
function renderReviewStep(app){
  return `
    <div class="panel-header"><span class="badge-num">${FIELD_GROUPS.length+2}</span><h3>المراجعة والإقرار</h3></div>
    ${FIELD_GROUPS.map(g=>`
      <div class="section-title">${g.title}</div>
      ${g.fields.map(f=>`<div class="review-field"><div><div class="rf-label">${f.label}</div><div class="rf-value">${escapeHtml(app.data[f.key]||"—")}</div></div></div>`).join("")}
    `).join("")}
    <div class="section-title">الوثائق</div>
    ${DOC_TYPES.map(d=>`<div class="review-field"><div><div class="rf-label">${d.label}</div><div class="rf-value">${app.documents[d.key] ? '✓ تم الرفع — '+escapeHtml(app.documents[d.key].originalName||'') : '⚠ لم يتم الرفع'}</div></div></div>`).join("")}
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
    const missing = DOC_TYPES.filter(d=>!CACHE.myApp.documents[d.key]);
    if(missing.length){ alert("يرجى رفع جميع الوثائق المطلوبة: " + missing.map(d=>d.label).join("، ")); return false; }
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
  const d = app.data;

  const fieldsHtml = FIELD_GROUPS.map(g=>`
    <div class="section-title">${g.title}</div>
    <div class="row2">
      ${g.fields.map(f=>`<div class="field"><label>${f.label}</label><input type="text" value="${escapeHtml(d[f.key]||"—")}" disabled></div>`).join("")}
    </div>
  `).join("");

  const docsHtml = DOC_TYPES.map(d2=>{
    const val = app.documents[d2.key];
    return `<div class="review-field">
      <div style="flex:1;">
        <div class="rf-label">${d2.label}</div>
        ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img src="${val.url}" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid var(--line);margin-top:6px;">` : `<div class="rf-value">📎 <a href="${val.url}" target="_blank">${escapeHtml(val.originalName||'ملف مرفق')}</a></div>`) : `<div class="rf-value muted">—</div>`}
      </div>
      ${val ? `<button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d2.label)}">🔍 عرض</button>` : ""}
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
    return `<tr data-search="${escapeHtml(searchStr)}">
      <td>${escapeHtml(u.fullName)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td><span class="status-chip ${u.applicationStatus}">${statusLabel(u.applicationStatus)}</span></td>
      <td>${u.applicationId ? `<a href="#/admin-review/${u.applicationId}" class="btn btn-outline btn-sm">عرض الملف</a>` : `<span class="text-sm muted">لم يبدأ الاستمارة بعد</span>`}</td>
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
        <thead><tr><th>الاسم الكامل</th><th>اسم المستخدم</th><th>البريد الإلكتروني</th><th>تاريخ إنشاء الحساب</th><th>حالة الملف</th><th></th><th></th><th></th></tr></thead>
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

  const docsHtml = DOC_TYPES.map(d=>{
    const val = app.documents[d.key];
    const flagged = REVIEW_DRAFT.docFlags[d.key]!==undefined;
    return `<div class="review-field">
      <div style="flex:1;">
        <div class="rf-label">${d.label}</div>
        ${val ? (val.mimetype && val.mimetype.startsWith('image') ? `<img src="${val.url}" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--line);margin-top:6px;">` : `<div class="rf-value">📎 <a href="${val.url}" target="_blank">${escapeHtml(val.originalName||'ملف مرفق')}</a></div>`) : `<div class="rf-value" style="color:var(--red-accent);">⚠ لم يتم الرفع</div>`}
        ${val ? `<div class="mt-8"><button type="button" class="btn btn-outline btn-sm doc-zoom-trigger" data-zoom-url="${val.url}" data-zoom-mime="${val.mimetype||''}" data-zoom-title="${escapeHtml(d.label)}">🔍 عرض للمراجعة والتدقيق</button></div>` : ""}
        ${flagged ? `<div class="flag-note"><textarea data-flag-doc-note="${d.key}" placeholder="سبب الرفض...">${escapeHtml(REVIEW_DRAFT.docFlags[d.key]||"")}</textarea></div>` : ""}
      </div>
      <button type="button" class="flag-toggle ${flagged?'on':''}" data-action="toggle-doc-flag" data-doc="${d.key}">${flagged?'✕ ملاحظة مسجّلة':'وضع ملاحظة'}</button>
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
   Global event delegation
   ============================================================ */
function attachGlobalHandlers(){
  attachAuthHandlers();

  document.querySelectorAll('[data-action="show-auth"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const tab = btn.getAttribute("data-tab");
      const zone = document.getElementById("auth-zone");
      if(zone){ zone.innerHTML = authForm(tab); attachAuthHandlers(); zone.scrollIntoView({behavior:"smooth", block:"center"}); }
    });
  });
  document.querySelectorAll('[data-action="logout"]').forEach(btn=>{
    btn.addEventListener("click", ()=>{ clearSession(); CACHE={myApp:null,adminList:null,adminReview:null}; go("home"); });
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
}
