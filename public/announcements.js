/* =========================================================
   LWF EL OUED — Announcements module (الإعلانات)
   Self-contained: exposes window.LWFAnnouncements, consumed by app.js's
   router. Relies on api(), escapeHtml(), fmtDate(), go(), getSession()
   already defined globally by app.js (loaded first).
   ========================================================= */
(function(){

  const ST = {
    adminList: null,
    adminStatusFilter: "all",
    refList: null,
    // create/edit form transient state (files not yet uploaded)
    pendingImageFile: null,
    pendingImagePreviewUrl: null,
    removeExistingImage: false,
    pendingAttachmentFiles: [],
  };

  function resetEditorState(){
    ST.pendingImageFile = null;
    ST.pendingImagePreviewUrl = null;
    ST.removeExistingImage = false;
    ST.pendingAttachmentFiles = [];
  }

  /* ---------- shared formatting ---------- */
  function statusLabel(s){ return { draft:"مسودة", published:"منشور", archived:"مؤرشف" }[s] || s; }
  function statusChipClass(s){ return { draft:"draft", published:"approved", archived:"pending_review" }[s] || "draft"; }
  function fileIcon(mimetype){
    if(!mimetype) return "📎";
    if(mimetype.startsWith("image/")) return "🖼️";
    if(mimetype === "application/pdf") return "📄";
    return "📎";
  }
  function fmtSize(bytes){
    if(!bytes && bytes !== 0) return "";
    if(bytes < 1024) return bytes + " B";
    if(bytes < 1024*1024) return Math.round(bytes/1024) + " KB";
    return (bytes/(1024*1024)).toFixed(1) + " MB";
  }
  function stripHtml(html){
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return (div.textContent || div.innerText || "").trim();
  }

  /* ============================================================
     REFEREE-FACING: list + detail
     ============================================================ */

  async function listPage(){
    let announcements;
    try{
      const res = await api("/announcements/mine");
      announcements = res.announcements;
      ST.refList = announcements;
    }catch(e){
      return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }

    if(!announcements.length){
      return `<div class="page">
        <div class="panel-header"><h3>📢 الإعلانات</h3></div>
        <div class="empty"><div class="icon">📭</div><h3>لا توجد إعلانات منشورة حاليًا</h3>
        <p class="muted">ستظهر هنا أي إعلانات تنشرها الإدارة.</p></div>
      </div>`;
    }

    return `<div class="page">
      <div class="panel-header"><h3>📢 الإعلانات</h3></div>
      <div class="announce-grid">
        ${announcements.map(announceCardHtml).join("")}
      </div>
    </div>`;
  }

  function announceCardHtml(a){
    return `
    <div class="announce-card" data-action="open-announcement" data-id="${a.id}">
      <div class="announce-card-media">
        ${a.image ? `<img src="${a.image.url}" alt="">` : `<div class="announce-card-media-placeholder">📢</div>`}
        <div class="announce-card-badges">
          ${a.isPinned ? `<span class="announce-badge pinned">📌 مثبت</span>` : ""}
          ${!a.isRead ? `<span class="announce-badge new">جديد</span>` : ""}
        </div>
      </div>
      <div class="announce-card-body">
        <h4>${escapeHtml(a.title)}</h4>
        <p class="announce-card-summary">${escapeHtml(a.summary)}</p>
        <div class="announce-card-foot">
          <span class="announce-card-date">${fmtDate(a.publishedAt)}</span>
          <button type="button" class="btn btn-outline btn-sm" data-action="open-announcement" data-id="${a.id}">قراءة المزيد</button>
        </div>
      </div>
    </div>`;
  }

  async function detailPage(id){
    let a;
    try{
      const res = await api(`/announcements/mine/${id}`);
      a = res.announcement;
    }catch(e){
      return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div>
        <a href="#/announcements" class="btn btn-outline mt-16">↩ العودة إلى الإعلانات</a></div>`;
    }
    return `<div class="page announce-detail-page">
      <a href="#/announcements" class="btn btn-ghost btn-sm">↩ العودة إلى الإعلانات</a>
      <div class="panel mt-16">
        <div class="announce-detail-badges">
          ${a.isPinned ? `<span class="announce-badge pinned">📌 مثبت</span>` : ""}
        </div>
        <h2 class="announce-detail-title">${escapeHtml(a.title)}</h2>
        <div class="announce-detail-date">📅 نُشر بتاريخ ${fmtDate(a.publishedAt)}</div>
        ${a.image ? `<img class="announce-detail-image" src="${a.image.url}" alt="">` : ""}
        <div class="rte-content">${a.content || ""}</div>
        ${a.attachments && a.attachments.length ? `
          <div class="section-title">المرفقات</div>
          <div class="announce-attachments-list">
            ${a.attachments.map(att => `
              <a class="announce-attachment-row" href="${att.url}" target="_blank" rel="noopener" download="${escapeHtml(att.originalName||'')}">
                <span class="icon">${fileIcon(att.mimetype)}</span>
                <span class="name">${escapeHtml(att.originalName || "مرفق")}</span>
                <span class="size">${fmtSize(att.size)}</span>
                <span class="dl">⬇ تحميل</span>
              </a>`).join("")}
          </div>` : ""}
      </div>
    </div>`;
  }

  /* ============================================================
     NAV: eligibility + unread badge (referee only)
     ============================================================ */

  async function refreshNav(session){
    if(!session || session.user.role !== "referee") return;
    const link = document.getElementById("announcements-nav-link");
    if(!link) return;
    try{
      const { eligible, unreadCount } = await api("/announcements/eligibility");
      link.style.display = eligible ? "" : "none";
      const badge = document.getElementById("announcements-unread-badge");
      if(badge){
        if(eligible && unreadCount > 0){ badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount); badge.style.display = ""; }
        else{ badge.style.display = "none"; }
      }
    }catch(e){ link.style.display = "none"; }
  }

  /* ============================================================
     ADMIN: list page
     ============================================================ */

  async function adminListPage(){
    let announcements;
    try{
      const res = await api("/admin/announcements");
      announcements = res.announcements;
      ST.adminList = announcements;
    }catch(e){
      return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }

    const counts = {
      all: announcements.length,
      draft: announcements.filter(a=>a.status==="draft").length,
      published: announcements.filter(a=>a.status==="published").length,
      archived: announcements.filter(a=>a.status==="archived").length,
    };

    const rows = announcements.map(a => `
      <tr data-status="${a.status}" data-search="${escapeHtml((a.title+" "+a.summary).toLowerCase())}">
        <td><b>${escapeHtml(a.title)}</b>${a.isPinned ? ' <span class="status-chip" style="background:var(--amber-pale);color:var(--amber);">📌 مثبت</span>' : ''}</td>
        <td><span class="status-chip ${statusChipClass(a.status)}">${statusLabel(a.status)}</span></td>
        <td>${a.publishedAt ? fmtDate(a.publishedAt) : "—"}</td>
        <td>${fmtDate(a.updatedAt)}</td>
        <td class="announce-admin-actions">
          <a href="#/admin-announcement-edit/${a.id}" class="btn btn-outline btn-sm">✎ تعديل</a>
          ${a.status !== "published" ? `<button type="button" class="btn btn-success btn-sm" data-action="ann-publish" data-id="${a.id}">نشر</button>` : `<button type="button" class="btn btn-warning btn-sm" data-action="ann-hide" data-id="${a.id}">إخفاء</button>`}
          ${a.status !== "archived" ? `<button type="button" class="btn btn-ghost btn-sm" data-action="ann-archive" data-id="${a.id}">أرشفة</button>` : ""}
          <button type="button" class="btn btn-ghost btn-sm" data-action="ann-pin" data-id="${a.id}">${a.isPinned ? "إلغاء التثبيت" : "📌 تثبيت"}</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="ann-delete" data-id="${a.id}" data-title="${escapeHtml(a.title)}">حذف</button>
        </td>
      </tr>`).join("");

    return `<div class="page">
      <div class="panel-header">
        <h3>إدارة الإعلانات</h3>
        <a href="#/admin-announcement-edit/new" class="btn btn-primary btn-sm">+ إعلان جديد</a>
      </div>

      <div class="filter-strip" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
        ${[["all","الكل"],["draft","مسودة"],["published","منشور"],["archived","مؤرشف"]].map(([k,label])=>`
          <div class="pill ${ST.adminStatusFilter===k?'status-ok':''}" style="cursor:pointer;" data-action="ann-filter-status" data-status="${k}">${label} (${counts[k]})</div>
        `).join("")}
      </div>

      <div class="field" style="max-width:320px;">
        <input type="text" id="ann-admin-search" placeholder="🔍 ابحث بعنوان الإعلان...">
      </div>

      ${announcements.length===0 ? `<div class="empty"><div class="icon">📢</div><h3>لا توجد إعلانات بعد</h3><p class="muted">أنشئ أول إعلان للحكام من الزر أعلاه.</p></div>` : `
      <div class="table-wrap mt-16">
        <table id="ann-admin-table">
          <thead><tr><th>عنوان الإعلان</th><th>الحالة</th><th>تاريخ النشر</th><th>آخر تعديل</th><th>إجراءات</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="empty" id="ann-admin-empty" style="display:none;"><div class="icon">🔍</div><h3>لا توجد نتائج مطابقة</h3></div>`}
    </div>`;
  }

  function applyAdminFilter(){
    const table = document.getElementById("ann-admin-table");
    if(!table) return;
    const query = (document.getElementById("ann-admin-search")?.value || "").trim().toLowerCase();
    const rows = table.querySelectorAll("tbody tr");
    let visible = 0;
    rows.forEach(row=>{
      const matchesStatus = ST.adminStatusFilter === "all" || row.getAttribute("data-status") === ST.adminStatusFilter;
      const matchesQuery = !query || (row.getAttribute("data-search")||"").includes(query);
      const show = matchesStatus && matchesQuery;
      row.style.display = show ? "" : "none";
      if(show) visible++;
    });
    const emptyEl = document.getElementById("ann-admin-empty");
    if(emptyEl) emptyEl.style.display = visible === 0 ? "" : "none";
    table.style.display = visible === 0 ? "none" : "";
  }

  /* ============================================================
     ADMIN: create / edit page
     ============================================================ */

  async function adminEditPage(id){
    resetEditorState();
    const isNew = !id || id === "new";
    let a = null;
    if(!isNew){
      try{
        const res = await api(`/admin/announcements/${id}`);
        a = res.announcement;
      }catch(e){
        return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
      }
    }

    const title = a ? a.title : "";
    const summary = a ? a.summary : "";
    const content = a ? a.content : "";
    const image = a ? a.image : null;
    const attachments = a ? (a.attachments || []) : [];
    const status = a ? a.status : "draft";

    return `<div class="page">
      <a href="#/admin-announcements" class="btn btn-ghost btn-sm">↩ العودة إلى قائمة الإعلانات</a>
      <div class="panel mt-16">
        <div class="panel-header">
          <h3>${isNew ? "إعلان جديد" : "تعديل الإعلان"}</h3>
          ${!isNew ? `<span class="status-chip ${statusChipClass(status)}">${statusLabel(status)}</span>` : ""}
        </div>

        <div id="ann-form-error"></div>

        <form id="ann-form" data-id="${a ? a.id : ''}">
          <div class="field">
            <label>عنوان الإعلان *</label>
            <input type="text" name="title" value="${escapeHtml(title)}" required>
          </div>
          <div class="field">
            <label>وصف مختصر *</label>
            <textarea name="summary" required>${escapeHtml(summary)}</textarea>
            <div class="hint">يظهر هذا الوصف في بطاقة الإعلان ضمن قائمة الإعلانات لدى الحكام.</div>
          </div>

          <div class="field">
            <label>المحتوى الكامل *</label>
            ${rteToolbarHtml()}
            <div id="ann-content-editor" class="rte-editor" contenteditable="true">${content || ""}</div>
          </div>

          <div class="field">
            <label>الصورة الرئيسية (اختياري)</label>
            <div id="ann-image-zone">${imageZoneHtml(image)}</div>
          </div>

          <div class="field">
            <label>المرفقات (اختياري — PDF أو صور)</label>
            <div class="upload-box" style="max-width:260px;">
              <input type="file" id="ann-attachments-input" accept="image/*,application/pdf" multiple>
              <div class="icon">📎</div>
              <div class="label">اضغط لإضافة مرفقات</div>
            </div>
            <div id="ann-attachments-list" class="announce-attachments-list mt-16">
              ${(!isNew ? attachments.map(existingAttachmentRowHtml).join("") : "")}
            </div>
            <div id="ann-pending-attachments-list" class="announce-attachments-list mt-16"></div>
          </div>

          <div class="wizard-actions">
            <button type="button" class="btn btn-outline" data-action="ann-preview">👁 معاينة</button>
            <button type="submit" class="btn btn-primary">💾 حفظ</button>
          </div>
        </form>

        ${!isNew ? `
        <div class="section-title">حالة الإعلان</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${status !== "published" ? `<button type="button" class="btn btn-success btn-sm" data-action="ann-publish" data-id="${a.id}">نشر الإعلان</button>` : `<button type="button" class="btn btn-warning btn-sm" data-action="ann-hide" data-id="${a.id}">إخفاء الإعلان</button>`}
          ${status !== "archived" ? `<button type="button" class="btn btn-ghost btn-sm" data-action="ann-archive" data-id="${a.id}">أرشفة</button>` : ""}
          <button type="button" class="btn btn-ghost btn-sm" data-action="ann-pin" data-id="${a.id}">${a.isPinned ? "إلغاء التثبيت" : "📌 تثبيت في الأعلى"}</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="ann-delete" data-id="${a.id}" data-title="${escapeHtml(a.title)}">حذف الإعلان</button>
        </div>` : ""}
      </div>
    </div>`;
  }

  function rteToolbarHtml(){
    return `<div class="rte-toolbar">
      <button type="button" class="rte-btn" data-cmd="bold" title="عريض"><b>B</b></button>
      <button type="button" class="rte-btn" data-cmd="italic" title="مائل"><i>I</i></button>
      <button type="button" class="rte-btn" data-cmd="underline" title="تسطير"><u>U</u></button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" data-cmd="insertUnorderedList" title="قائمة نقطية">•≡</button>
      <button type="button" class="rte-btn" data-cmd="insertOrderedList" title="قائمة رقمية">1≡</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" data-cmd="createLink" title="إدراج رابط">🔗</button>
      <button type="button" class="rte-btn" data-cmd="removeFormat" title="إزالة التنسيق">✕ تنسيق</button>
    </div>`;
  }

  function imageZoneHtml(image){
    if(ST.pendingImagePreviewUrl){
      return `
        <img class="upload-preview" style="width:150px;height:150px;" src="${ST.pendingImagePreviewUrl}">
        <button type="button" class="btn btn-outline btn-sm" data-action="ann-cancel-image">✕ إلغاء الصورة الجديدة</button>`;
    }
    if(image && !ST.removeExistingImage){
      return `
        <img class="upload-preview" style="width:150px;height:150px;" src="${image.url}">
        <div style="display:flex;gap:8px;margin-top:8px;">
          <label class="btn btn-outline btn-sm" style="cursor:pointer;">تغيير الصورة<input type="file" id="ann-image-input" accept="image/*" style="display:none;"></label>
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="ann-remove-image">✕ حذف الصورة</button>
        </div>`;
    }
    return `<div class="upload-box" style="max-width:200px;">
      <input type="file" id="ann-image-input" accept="image/*">
      <div class="icon">🖼️</div>
      <div class="label">اضغط لإضافة صورة</div>
    </div>`;
  }

  function existingAttachmentRowHtml(att){
    return `<div class="announce-attachment-row" data-existing-attachment-id="${att.id}">
      <span class="icon">${fileIcon(att.mimetype)}</span>
      <span class="name">${escapeHtml(att.originalName || "مرفق")}</span>
      <span class="size">${fmtSize(att.size)}</span>
      <button type="button" class="btn btn-danger-outline btn-sm" data-action="ann-remove-existing-attachment" data-attid="${att.id}">✕ حذف</button>
    </div>`;
  }

  function renderPendingAttachmentsList(){
    const el = document.getElementById("ann-pending-attachments-list");
    if(!el) return;
    el.innerHTML = ST.pendingAttachmentFiles.map((f, idx)=>`
      <div class="announce-attachment-row is-pending">
        <span class="icon">${fileIcon(f.type)}</span>
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="size">${fmtSize(f.size)}</span>
        <button type="button" class="btn btn-danger-outline btn-sm" data-action="ann-remove-pending-attachment" data-idx="${idx}">✕ إزالة</button>
      </div>`).join("");
  }

  function previewOverlayHtml(a){
    return `
    <div class="announce-detail-badges">
      ${a.isPinned ? `<span class="announce-badge pinned">📌 مثبت</span>` : ""}
      <span class="announce-badge new">معاينة</span>
    </div>
    <h2 class="announce-detail-title">${escapeHtml(a.title || "(بدون عنوان)")}</h2>
    <div class="announce-detail-date">📅 ${fmtDate(new Date().toISOString())}</div>
    ${a.imageUrl ? `<img class="announce-detail-image" src="${a.imageUrl}" alt="">` : ""}
    <div class="rte-content">${a.content || ""}</div>`;
  }

  function openPreview(a){
    closePreview();
    const overlay = document.createElement("div");
    overlay.id = "ann-preview-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,20,15,0.72);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:34px 16px;overflow:auto;";
    overlay.addEventListener("click", (e)=>{ if(e.target===overlay) closePreview(); });
    const box = document.createElement("div");
    box.className = "panel";
    box.style.cssText = "max-width:640px;width:100%;position:relative;";
    box.innerHTML = `<button type="button" class="btn btn-outline btn-sm" style="position:absolute;left:16px;top:16px;" data-action="ann-close-preview">✕ إغلاق المعاينة</button>` + previewOverlayHtml(a);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", escClosePreview);
    overlay.querySelector('[data-action="ann-close-preview"]').addEventListener("click", closePreview);
  }
  function escClosePreview(e){ if(e.key === "Escape") closePreview(); }
  function closePreview(){
    const el = document.getElementById("ann-preview-overlay");
    if(el) el.remove();
    document.removeEventListener("keydown", escClosePreview);
  }

  /* ============================================================
     ADMIN: action handlers (publish/hide/archive/pin/delete)
     ============================================================ */

  async function runAdminAction(action, id, extra){
    const endpoints = {
      "ann-publish": { url:`/admin/announcements/${id}/publish`, method:"POST" },
      "ann-hide": { url:`/admin/announcements/${id}/hide`, method:"POST" },
      "ann-archive": { url:`/admin/announcements/${id}/archive`, method:"POST" },
      "ann-pin": { url:`/admin/announcements/${id}/pin`, method:"POST" },
      "ann-delete": { url:`/admin/announcements/${id}`, method:"DELETE" },
    };
    const ep = endpoints[action];
    if(!ep) return;
    try{
      await api(ep.url, { method: ep.method });
      window.location.reload();
    }catch(e){
      alert(e.message);
    }
  }

  /* ============================================================
     MOUNT: attach listeners for whichever page/segment was rendered
     ============================================================ */

  function mount(seg, id, session){
    if(seg === "announcements"){
      document.querySelectorAll('[data-action="open-announcement"]').forEach(el=>{
        el.addEventListener("click", ()=> go(`announcement/${el.getAttribute("data-id")}`));
      });
    }

    if(seg === "admin-announcements"){
      const search = document.getElementById("ann-admin-search");
      if(search) search.addEventListener("input", applyAdminFilter);
      document.querySelectorAll('[data-action="ann-filter-status"]').forEach(el=>{
        el.addEventListener("click", ()=>{
          ST.adminStatusFilter = el.getAttribute("data-status");
          go("admin-announcements");
        });
      });
      applyAdminFilter();
      attachAdminActionButtons();
    }

    if(seg === "admin-announcement-edit"){
      attachAdminActionButtons();
      attachEditFormHandlers(id);
    }
  }

  function attachAdminActionButtons(){
    ["ann-publish","ann-hide","ann-archive","ann-pin"].forEach(action=>{
      document.querySelectorAll(`[data-action="${action}"]`).forEach(btn=>{
        btn.addEventListener("click", ()=> runAdminAction(action, btn.getAttribute("data-id")));
      });
    });
    document.querySelectorAll('[data-action="ann-delete"]').forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const t = btn.getAttribute("data-title");
        if(!confirm(`هل تريد حذف الإعلان "${t}" نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
        runAdminAction("ann-delete", btn.getAttribute("data-id"));
      });
    });
  }

  function attachEditFormHandlers(routeId){
    const form = document.getElementById("ann-form");
    if(!form) return;
    const isNew = !routeId || routeId === "new";
    const editor = document.getElementById("ann-content-editor");

    // rich-text toolbar
    document.querySelectorAll(".rte-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        editor.focus();
        const cmd = btn.getAttribute("data-cmd");
        if(cmd === "createLink"){
          const url = prompt("أدخل رابط الوجهة:");
          if(url) document.execCommand(cmd, false, url);
        } else {
          document.execCommand(cmd, false, null);
        }
      });
    });

    // image selection
    function bindImageInput(){
      const input = document.getElementById("ann-image-input");
      if(!input) return;
      input.addEventListener("change", ()=>{
        const file = input.files && input.files[0];
        if(!file) return;
        ST.pendingImageFile = file;
        ST.removeExistingImage = false;
        ST.pendingImagePreviewUrl = URL.createObjectURL(file);
        document.getElementById("ann-image-zone").innerHTML = imageZoneHtml(null);
        bindImageInput();
        bindImageZoneButtons();
      });
    }
    function bindImageZoneButtons(){
      const cancelBtn = document.querySelector('[data-action="ann-cancel-image"]');
      if(cancelBtn) cancelBtn.addEventListener("click", async ()=>{
        ST.pendingImageFile = null;
        ST.pendingImagePreviewUrl = null;
        const zone = document.getElementById("ann-image-zone");
        if(!isNew){
          try{ const { announcement } = await api(`/admin/announcements/${routeId}`); zone.innerHTML = imageZoneHtml(announcement.image); }
          catch(e){ zone.innerHTML = imageZoneHtml(null); }
        } else zone.innerHTML = imageZoneHtml(null);
        bindImageInput(); bindImageZoneButtons();
      });
      const removeBtn = document.querySelector('[data-action="ann-remove-image"]');
      if(removeBtn) removeBtn.addEventListener("click", ()=>{
        ST.removeExistingImage = true;
        document.getElementById("ann-image-zone").innerHTML = imageZoneHtml(null);
        bindImageInput(); bindImageZoneButtons();
      });
    }
    bindImageInput();
    bindImageZoneButtons();

    // attachments selection (new files, pending until save)
    const attInput = document.getElementById("ann-attachments-input");
    if(attInput) attInput.addEventListener("change", ()=>{
      Array.from(attInput.files || []).forEach(f => ST.pendingAttachmentFiles.push(f));
      attInput.value = "";
      renderPendingAttachmentsList();
      bindPendingAttachmentRemovers();
    });
    function bindPendingAttachmentRemovers(){
      document.querySelectorAll('[data-action="ann-remove-pending-attachment"]').forEach(btn=>{
        btn.addEventListener("click", ()=>{
          ST.pendingAttachmentFiles.splice(Number(btn.getAttribute("data-idx")), 1);
          renderPendingAttachmentsList();
          bindPendingAttachmentRemovers();
        });
      });
    }

    // remove an already-saved attachment (immediate server call)
    document.querySelectorAll('[data-action="ann-remove-existing-attachment"]').forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        if(!confirm("هل تريد حذف هذا المرفق؟")) return;
        try{
          await api(`/admin/announcements/${routeId}/attachments/${btn.getAttribute("data-attid")}`, { method:"DELETE" });
          btn.closest(".announce-attachment-row").remove();
        }catch(e){ alert(e.message); }
      });
    });

    // preview
    const previewBtn = document.querySelector('[data-action="ann-preview"]');
    if(previewBtn) previewBtn.addEventListener("click", ()=>{
      const fd = new FormData(form);
      openPreview({
        title: fd.get("title"),
        content: editor.innerHTML,
        imageUrl: ST.pendingImagePreviewUrl || (form.querySelector(".upload-preview") && !ST.removeExistingImage ? form.querySelector(".upload-preview").src : null),
      });
    });

    // submit (create or edit)
    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const errEl = document.getElementById("ann-form-error");
      if(errEl) errEl.innerHTML = "";
      const title = form.querySelector('[name="title"]').value.trim();
      const summary = form.querySelector('[name="summary"]').value.trim();
      const content = editor.innerHTML.trim();
      if(!title || !summary || !stripHtml(content)){
        if(errEl) errEl.innerHTML = `<div class="error-msg">يرجى تعبئة العنوان والوصف المختصر والمحتوى.</div>`;
        return;
      }

      const fd = new FormData();
      fd.append("title", title);
      fd.append("summary", summary);
      fd.append("content", content);
      if(ST.pendingImageFile) fd.append("image", ST.pendingImageFile);
      else if(ST.removeExistingImage) fd.append("removeImage", "true");
      ST.pendingAttachmentFiles.forEach(f => fd.append("attachments", f));

      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.classList.add("is-loading");
      try{
        if(isNew){
          const { announcement } = await api("/admin/announcements", { method:"POST", body:fd, isForm:true });
          go(`admin-announcement-edit/${announcement.id}`);
        } else {
          await api(`/admin/announcements/${routeId}`, { method:"PUT", body:fd, isForm:true });
          go("admin-announcements");
        }
      }catch(err){
        submitBtn.disabled = false; submitBtn.classList.remove("is-loading");
        if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  window.LWFAnnouncements = { listPage, detailPage, adminListPage, adminEditPage, refreshNav, mount };

})();
