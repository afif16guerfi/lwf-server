/* =========================================================
   LWF EL OUED — Notifications module (الإشعارات 🔔)
   Self-contained: exposes window.LWFNotifications, consumed by app.js's
   router. Relies on api(), escapeHtml(), fmtDate(), go(), getSession()
   already defined globally by app.js (loaded first). Works identically
   for both referee and admin sessions — every notification is already
   scoped to the caller server-side.
   ========================================================= */
(function(){

  const ST = { list: null };

  const TYPE_META = {
    request_new:                 { icon: "📝", label: "طلب جديد" },
    request_needs_clarification: { icon: "🔵", label: "مطلوب توضيح" },
    request_resubmitted:         { icon: "🔁", label: "إعادة إرسال طلب" },
    request_approved:            { icon: "🟢", label: "قبول طلب" },
    request_rejected:            { icon: "🔴", label: "رفض طلب" },
    announcement_new:            { icon: "📢", label: "إعلان جديد" },
    announcement_updated:        { icon: "📢", label: "تحديث إعلان" },
  };
  function typeMeta(t){ return TYPE_META[t] || { icon: "🔔", label: "إشعار" }; }

  /* ---------- 🔔 bell badge in the topbar — kept up to date on every
     route render, and live-bumped by app.js's WS "notification:new"
     handler (see chat.js) without waiting for the next navigation ---- */
  async function refreshNav(session){
    if(!session) return;
    const badge = document.getElementById("notif-nav-badge");
    if(!badge) return;
    try{
      const { unreadCount } = await api("/notifications/mine/unread-count");
      if(unreadCount > 0){ badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount); badge.style.display = ""; }
      else{ badge.style.display = "none"; }
    }catch(e){ badge.style.display = "none"; }
  }

  function bumpBadgeTo(unreadCount){
    const badge = document.getElementById("notif-nav-badge");
    if(!badge) return;
    if(unreadCount > 0){ badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount); badge.style.display = ""; }
    else{ badge.style.display = "none"; }
  }

  /* ---------- صفحة الإشعارات ---------- */
  async function listPage(){
    let notifications;
    try{
      const res = await api("/notifications/mine");
      notifications = res.notifications;
      ST.list = notifications;
    }catch(e){
      return `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }

    if(!notifications.length){
      return `<div class="page">
        <div class="panel-header"><h3>🔔 الإشعارات</h3></div>
        <div class="empty"><div class="icon">🔕</div><h3>لا توجد إشعارات حاليًا</h3>
        <p class="muted">ستظهر هنا أي إشعارات جديدة تخصّك.</p></div>
      </div>`;
    }

    const unreadCount = notifications.filter(n=>!n.isRead).length;

    return `<div class="page">
      <div class="panel-header">
        <h3>🔔 الإشعارات${unreadCount ? ` <span class="status-chip pending">${unreadCount} غير مقروء</span>` : ""}</h3>
        ${unreadCount ? `<button type="button" class="btn btn-outline btn-sm" data-action="notif-read-all">✓ تعليم الكل كمقروء</button>` : ""}
      </div>
      <div class="panel" style="padding:0;overflow:hidden;">
        ${notifications.map(notifRowHtml).join("")}
      </div>
    </div>`;
  }

  function notifRowHtml(n){
    const meta = typeMeta(n.type);
    return `
    <div class="notif-row ${n.isRead ? "read" : "unread"}" data-action="open-notification" data-id="${n.id}" data-link="${escapeHtml(n.link||"")}"
         style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-bottom:1px solid var(--line);cursor:pointer;${n.isRead ? "" : "background:var(--amber-pale);"}">
      <div style="font-size:20px;line-height:1;">${meta.icon}</div>
      <div style="flex:1;min-width:0;">
        <div class="text-sm" style="font-weight:${n.isRead?600:800};">${n.isRead ? "" : "🔵 "}${escapeHtml(n.title)}</div>
        <div class="text-sm muted mt-8" style="white-space:pre-wrap;">${escapeHtml(n.body)}</div>
        <div class="text-sm muted mt-8">${fmtDate(n.createdAt)}${n.isRead && n.readAt ? " — تمت القراءة " + fmtDate(n.readAt) : ""}</div>
      </div>
    </div>`;
  }

  async function openNotification(id, link){
    try{
      const res = await api(`/notifications/mine/${id}/read`, { method:"POST" });
      bumpBadgeTo(res.unreadCount);
    }catch(e){ /* still navigate even if marking-read failed */ }
    if(link) go(link.replace(/^#\//, ""));
    else render();
  }

  function mount(seg, id, session){
    if(seg === "notifications"){
      document.querySelectorAll('[data-action="open-notification"]').forEach(el=>{
        el.addEventListener("click", ()=> openNotification(el.getAttribute("data-id"), el.getAttribute("data-link")));
      });
      const readAllBtn = document.querySelector('[data-action="notif-read-all"]');
      if(readAllBtn){
        readAllBtn.addEventListener("click", async ()=>{
          try{ await api("/notifications/mine/read-all", { method:"POST" }); render(); }catch(e){ /* ignore */ }
        });
      }
    }
  }

  // Called by chat.js's WS "notification:new" handler for a live badge bump
  // without a full navigation.
  function onRealtimeNotification(payload){
    if(payload && typeof payload.unreadCount === "number") bumpBadgeTo(payload.unreadCount);
  }

  window.LWFNotifications = { listPage, refreshNav, mount, onRealtimeNotification };
})();
