/* =========================================================
   LWF EL OUED — Chat module (private / public / group chats)
   Self-contained: exposes window.LWFChat, consumed by app.js's router.
   Relies on api(), escapeHtml(), getSession(), fmtDate(), go(),
   openDocLightbox() already defined globally by app.js (loaded first).
   ========================================================= */
(function(){

  // Fixed-identity icons for the two conversation kinds that aren't "a
  // person": the public/broadcast chat and any private conversation with
  // the platform admin. Line-icon SVGs (not emoji) so they render crisp
  // and identical everywhere, same reasoning as the sun/moon theme icons —
  // and each gets its own gradient in chat.css specifically so it reads as
  // "not a regular referee" at a glance in the conversation list.
  const ICON_ANNOUNCE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z"></path><path d="M16 8a4 4 0 0 1 0 8"></path><path d="M19 5a8 8 0 0 1 0 14"></path></svg>`;
  const ICON_SHIELD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg>`;
  const ICON_SHIELD_SM = ICON_SHIELD.replace(/width="20" height="20"/, 'width="15" height="15"');

  const ST = {
    session: null,
    ws: null,
    _wsToken: null,
    _intentionalClose: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    conversations: [],
    currentId: null,
    currentConv: null,
    currentMembers: [],
    messages: [],
    hasMore: false,
    otherLastReadAt: null,
    typingActive: false,
    searchQuery: "",
    pendingAttachment: null,
    reactionCatalog: null,
    mounted: false,
  };
  // Mirrors the server's REACTIONS list in routes/chat.js — used only as a
  // fallback if GET /chat/reactions can't be reached (e.g. briefly offline),
  // so the picker still has something to show. The real, authoritative list
  // is always fetched from the server (see ensureReactionCatalog below).
  const FALLBACK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡", "👏", "🔥", "🎉"];
  const QUICK_REACTION = "❤️"; // double-tap default, matching WhatsApp/Telegram/Messenger
  const typingTimers = {};
  let lastTypingPingAt = 0;

  /* ---------- formatting helpers ---------- */
  function fmtChatTime(iso){
    if(!iso) return "";
    return new Date(iso).toLocaleTimeString('ar-DZ', {hour:'2-digit', minute:'2-digit'});
  }
  function dayLabel(iso){
    const d = new Date(iso), now = new Date();
    if(d.toDateString() === now.toDateString()) return "اليوم";
    const yest = new Date(now); yest.setDate(now.getDate()-1);
    if(d.toDateString() === yest.toDateString()) return "أمس";
    return fmtDate(iso);
  }
  function initial(name){ return (name||"؟").trim().charAt(0) || "؟"; }
  // Anchored to the server clock (see the "server-time" case in handleEvent)
  // rather than Date.now() directly — a phone with a wrong system clock must
  // not show a wrong "منذ N دقائق".
  function serverNow(){ return Date.now() + (ST.serverTimeOffsetMs || 0); }
  // Picks the right one of the exact formats requested — minutes/hours-ago
  // while recent, "اليوم الساعة HH:MM" / "أمس الساعة HH:MM" once it's been
  // long enough that a bare relative count stops being useful, then a day
  // count, then a plain date for anything older than a week.
  function formatLastSeen(iso){
    if(!iso) return "غير متصل";
    const then = new Date(iso);
    const nowMs = serverNow();
    const diffMs = Math.max(0, nowMs - then.getTime());
    const diffMin = Math.floor(diffMs / 60000);
    if(diffMin < 1) return "آخر ظهور منذ لحظات";
    if(diffMin < 60){
      if(diffMin === 1) return "آخر ظهور منذ دقيقة";
      if(diffMin === 2) return "آخر ظهور منذ دقيقتين";
      return `آخر ظهور منذ ${diffMin} دقيقة`;
    }
    const now = new Date(nowMs);
    const sameDay = then.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const isYesterday = then.toDateString() === yest.toDateString();
    const diffHr = Math.floor(diffMin / 60);
    if(sameDay && diffHr < 6){
      if(diffHr === 1) return "آخر ظهور منذ ساعة";
      if(diffHr === 2) return "آخر ظهور منذ ساعتين";
      return `آخر ظهور منذ ${diffHr} ساعات`;
    }
    const timeStr = then.toLocaleTimeString('ar-DZ', {hour:'2-digit', minute:'2-digit'});
    if(sameDay) return `آخر ظهور اليوم الساعة ${timeStr}`;
    if(isYesterday) return `آخر ظهور أمس الساعة ${timeStr}`;
    const diffDays = Math.floor(diffMs / 86400000);
    if(diffDays <= 6) return diffDays === 2 ? "آخر ظهور منذ يومين" : `آخر ظهور منذ ${diffDays} أيام`;
    return `آخر ظهور بتاريخ ${fmtDate(iso)}`;
  }
  function presenceLabel(entity){ return entity.online ? "🟢 متصل الآن" : formatLastSeen(entity.lastSeenAt); }
  // Pushed live by presence.js (server) the instant a contact's *first*
  // device connects or *last* device disconnects — updates every place that
  // could currently be showing that person's name: the sidebar (private
  // conversations), the open chat's header, and an open group's member list.
  function handlePresenceUpdate(payload){
    const { userId, online, lastSeenAt } = payload || {};
    if(!userId) return;
    let sidebarChanged = false;
    ST.conversations.forEach((c)=>{
      if(c.type === "private" && c.otherUserId === userId){ c.online = online; c.lastSeenAt = lastSeenAt; sidebarChanged = true; }
    });
    if(sidebarChanged) renderSidebar();

    if(ST.currentConv && ST.currentConv.type === "private" && ST.currentConv.otherUserId === userId){
      ST.currentConv.online = online;
      ST.currentConv.lastSeenAt = lastSeenAt;
      const avatarEl = document.querySelector("#chat-main .chat-view-header .chat-avatar");
      if(avatarEl) avatarEl.classList.toggle("online", !!online);
      if(!ST.typingActive){
        const sub = document.getElementById("chat-typing-line");
        if(sub) sub.textContent = headerSubtitle(ST.currentConv);
      }
    }

    const member = ST.currentMembers.find((mm)=>mm.userId===userId);
    if(member){
      member.online = online;
      member.lastSeenAt = lastSeenAt;
      const row = document.querySelector(`[data-member-row="${userId}"]`);
      if(row && ST.currentConv) row.outerHTML = memberRowHtml(member, ST.currentConv);
    }
  }
  // A connect/disconnect event refreshes "last seen" immediately, but the
  // relative text ("منذ 5 دقائق") also needs to keep advancing on its own
  // while nothing changes — a light periodic repaint of whatever presence
  // text is currently on screen, not a network request.
  setInterval(()=>{
    if(ST.currentConv && ST.currentConv.type === "private" && !ST.currentConv.online && !ST.typingActive){
      const sub = document.getElementById("chat-typing-line");
      if(sub) sub.textContent = headerSubtitle(ST.currentConv);
    }
    document.querySelectorAll("[data-member-row]").forEach((row)=>{
      const uid = row.getAttribute("data-member-row");
      const m = ST.currentMembers.find((mm)=>mm.userId===uid);
      if(m && !m.online && ST.currentConv) row.outerHTML = memberRowHtml(m, ST.currentConv);
    });
  }, 60000);
  // A referee whose account isn't active yet (pending review, needs edit,
  // or rejected) can only reach the admin through one private conversation —
  // the UI never offers to delete it (the backend refuses it too, see
  // routes/chat.js DELETE /conversations/:id, which now checks the same
  // "not active" condition).
  function isPendingReferee(){ return !!(ST.session && ST.session.user.role === "referee" && ST.session.user.accountStatus !== "active"); }

  /* ---------- WebSocket lifecycle ---------- */
  function wsUrl(token){
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  }
  function ensureConnected(session){
    if(!session || !session.token) return;
    if(ST.ws && (ST.ws.readyState === WebSocket.OPEN || ST.ws.readyState === WebSocket.CONNECTING) && ST._wsToken === session.token) return;
    ST.session = session;
    ST._wsToken = session.token;
    ST._intentionalClose = false;
    openSocket();
  }
  // Small live dot next to "الدردشة" reflecting the WebSocket connection
  // state — purely visual, reads from the same lifecycle events the chat
  // already relies on for reconnection, so it can't drift out of sync.
  function setConnStatus(state){
    ST.connStatus = state;
    const dot = document.getElementById("chat-conn-status");
    if(!dot) return;
    dot.className = `chat-conn-dot ${state}`;
    dot.title = state === "connected" ? "متصل بالخادم" : state === "connecting" ? "جارٍ الاتصال بالخادم..." : "غير متصل — سيُعاد الاتصال تلقائيًا";
  }
  function openSocket(){
    setConnStatus("connecting");
    try{
      const ws = new WebSocket(wsUrl(ST._wsToken));
      ST.ws = ws;
      ws.addEventListener("open", ()=>{ ST.reconnectAttempts = 0; setConnStatus("connected"); if(ST.currentId) loadMessagesQuiet(ST.currentId); ackDelivered(); });
      ws.addEventListener("message", (ev)=>{
        try{ const { event, payload } = JSON.parse(ev.data); handleEvent(event, payload); }catch(e){}
      });
      ws.addEventListener("close", ()=>{ if(!ST._intentionalClose){ setConnStatus("offline"); scheduleReconnect(); } });
      ws.addEventListener("error", ()=>{});
    }catch(e){ setConnStatus("offline"); scheduleReconnect(); }
  }
  function scheduleReconnect(){
    clearTimeout(ST.reconnectTimer);
    ST.reconnectAttempts = (ST.reconnectAttempts||0) + 1;
    const delay = Math.min(2000 * ST.reconnectAttempts, 15000);
    ST.reconnectTimer = setTimeout(()=>{ if(getSession()) openSocket(); }, delay);
  }
  function disconnect(){
    ST._intentionalClose = true;
    clearTimeout(ST.reconnectTimer);
    if(ST.ws){ try{ ST.ws.close(); }catch(e){} }
    ST.ws = null; ST._wsToken = null;
    ST.currentId = null; ST.currentConv = null; ST.messages = []; ST.conversations = [];
  }

  function handleEvent(event, payload){
    switch(event){
      // "مزامنة الوقت مع الخادم وليس مع ساعة الجهاز" — sent once per
      // connection/reconnect by server.js; every relative "منذ N دقائق"-style
      // last-seen calculation below is anchored to this, not to the
      // device's own (possibly wrong) clock.
      case "server-time":
        ST.serverTimeOffsetMs = new Date(payload.now).getTime() - Date.now();
        break;
      case "presence:update": handlePresenceUpdate(payload); break;
      // Requests/announcements notifications — see notificationsCore.js.
      // Handled by public/notifications.js's own module; chat.js only owns
      // the shared WebSocket connection, so it forwards the event along.
      case "notification:new":
        if(window.LWFNotifications) window.LWFNotifications.onRealtimeNotification(payload);
        break;
      // Receiving this push at all — regardless of which conversation is
      // currently open — proves the device is online and got the message,
      // so it's the trigger for the ✓✓ grey "delivered" tick.
      case "message:new": ackDelivered(); appendOrUpdateMessage(payload); break;
      case "message:edited": updateMessageInPlace(payload); break;
      case "message:deleted": markMessageDeletedInPlace(payload); break;
      case "typing": showTyping(payload); break;
      case "read:updated":
        updateMemberTimestamp(payload.conversationId, payload.userId, { lastReadAt: payload.readAt, lastDeliveredAt: payload.deliveredAt });
        if(payload.conversationId === ST.currentId && ST.currentConv && ST.currentConv.type === "private"){
          ST.otherLastReadAt = payload.readAt;
        }
        if(payload.conversationId === ST.currentId) renderMessages();
        break;
      case "delivered:updated":
        updateMemberTimestamp(payload.conversationId, payload.userId, { lastDeliveredAt: payload.deliveredAt });
        if(payload.conversationId === ST.currentId) renderMessages();
        break;
      case "member:added":
      case "member:removed":
      case "group:renamed":
      case "group:photo_changed":
      case "conversation:created":
      case "conversation:member_joined":
        loadConversations();
        if(payload.conversationId === ST.currentId) refreshCurrentConversationMeta();
        break;
      case "conversation:cleared":
        loadConversations();
        if(payload.conversationId === ST.currentId){ ST.messages = []; renderMessages(); }
        break;
      case "conversation:deleted":
        loadConversations();
        if(payload.conversationId === ST.currentId){
          ST.currentId = null; ST.currentConv = null; ST.messages = [];
          showPlaceholder();
        }
        break;
    }
  }

  /* ---------- data loading ---------- */
  async function loadConversations(){
    try{
      const { conversations } = await api("/chat/conversations");
      ST.conversations = conversations;
      renderSidebar();
      recomputeBadge();
    }catch(e){ /* silent — sidebar just stays as-is */ }
  }
  async function loadMessagesQuiet(id){
    try{
      const { messages, hasMore } = await api(`/chat/conversations/${id}/messages?limit=50`);
      if(ST.currentId === id){ ST.messages = messages; ST.hasMore = hasMore; renderMessages(); }
    }catch(e){}
  }
  async function refreshCurrentConversationMeta(){
    if(!ST.currentId) return;
    try{
      const [{ conversation }, { members }] = await Promise.all([
        api(`/chat/conversations/${ST.currentId}`),
        api(`/chat/conversations/${ST.currentId}/members`),
      ]);
      ST.currentConv = conversation;
      ST.currentMembers = members;
      const nameEl = document.querySelector(".chat-view-name");
      const subEl = document.getElementById("chat-typing-line");
      const avatarEl = document.querySelector("#chat-main .chat-view-header .chat-avatar");
      if(nameEl) nameEl.textContent = conversation.name;
      if(subEl && !ST.typingActive) subEl.textContent = headerSubtitle(conversation);
      if(avatarEl) avatarEl.outerHTML = avatarHtml(conversation);
      if(conversation.type === "private"){
        const other = members.find(m=>m.userId === conversation.otherUserId);
        ST.otherLastReadAt = other ? other.lastReadAt : null;
        renderMessages();
      }
    }catch(e){
      if(e.status === 404){
        ST.currentId = null; ST.currentConv = null; ST.messages = [];
        showPlaceholder();
      }
    }
  }
  function markRead(id){
    const conv = ST.conversations.find(c=>c.id===id);
    if(conv && conv.unreadCount > 0){ conv.unreadCount = 0; renderSidebar(); recomputeBadge(); }
    api(`/chat/conversations/${id}/read`, { method:"POST" }).catch(()=>{});
  }
  // Tells the server "this device is online and receiving" so senders can
  // see the ✓✓ grey "delivered" tick even for conversations the recipient
  // hasn't opened yet. Throttled — this can be triggered by every incoming
  // message, no need to hit the API more than a few times a second.
  let lastDeliveredAckAt = 0;
  function ackDelivered(){
    const now = Date.now();
    if(now - lastDeliveredAckAt < 1500) return;
    lastDeliveredAckAt = now;
    api("/chat/delivered", { method:"POST" }).catch(()=>{});
  }
  // Keeps ST.currentMembers (used to compute per-message ✓/✓✓ status for
  // every conversation type, not just private ones) in sync with live
  // read/delivered events without a full members re-fetch.
  function updateMemberTimestamp(conversationId, userId, patch){
    if(conversationId !== ST.currentId) return;
    const m = ST.currentMembers.find(mm=>mm.userId===userId);
    if(!m) return;
    Object.entries(patch).forEach(([k,v])=>{ if(v) m[k] = v; });
  }

  /* ---------- badge ---------- */
  function updateBadgeDom(total){
    const el = document.getElementById("chat-unread-badge");
    if(!el) return;
    if(total > 0){ el.textContent = total > 99 ? "99+" : String(total); el.style.display = ""; }
    else{ el.style.display = "none"; }
  }
  function recomputeBadge(){
    updateBadgeDom(ST.conversations.reduce((s,c)=>s+(c.unreadCount||0),0));
  }
  async function refreshBadge(){
    try{ const { totalUnread } = await api("/chat/summary"); updateBadgeDom(totalUnread); }catch(e){}
  }

  /* ---------- sidebar ---------- */
  function avatarHtml(c){
    if(c.type === "public") return `<div class="chat-avatar public">${ICON_ANNOUNCE}</div>`;
    if(c.type === "group"){
      if(c.photoUrl) return `<img class="chat-avatar" src="${escapeHtml(c.photoUrl)}" alt="">`;
      return `<div class="chat-avatar group">👥</div>`;
    }
    if(c.otherUserRole === "admin") return `<div class="chat-avatar admin">${ICON_SHIELD}</div>`;
    const cls = `chat-avatar${c.online ? ' online' : ''}`;
    if(c.photoUrl) return `<img class="${cls}" src="${escapeHtml(c.photoUrl)}" alt="">`;
    return `<div class="${cls}">${escapeHtml(initial(c.name))}</div>`;
  }
  // Same idea as avatarHtml() above but for a plain person record (a member,
  // a user in a picker list, someone who reacted) rather than a full
  // conversation object — falls back to the initials circle whenever the
  // person hasn't uploaded a صورة شمسية yet (or the account has none, e.g.
  // the admin), so there's never a broken image. The admin's own entry
  // always gets the shield badge instead, same as their private-chat avatar.
  function personAvatarHtml(p, sizeClass){
    const cls = `chat-avatar${sizeClass ? ' '+sizeClass : ''}${p.online ? ' online' : ''}`;
    if(p.userRole === "admin" || p.role === "admin"){
      return `<span class="${cls} admin">${sizeClass === "sm" ? ICON_SHIELD_SM : ICON_SHIELD}</span>`;
    }
    if(p.photoUrl) return `<img class="${cls}" src="${escapeHtml(p.photoUrl)}" alt="">`;
    return `<span class="${cls}">${escapeHtml(initial(p.fullNameAr))}</span>`;
  }
  function conversationItemHtml(c){
    const active = c.id === ST.currentId ? "active" : "";
    const preview = c._typingLabel
      ? `<span class="chat-typing-text">${escapeHtml(c._typingLabel)} يكتب الآن...</span>`
      : `<span class="chat-conv-preview">${escapeHtml(c.lastMessage||"")}</span>`;
    return `<div class="chat-conv-item ${active}" data-chat-action="select-conv" data-id="${c.id}">
      ${avatarHtml(c)}
      <div class="chat-conv-info">
        <div class="chat-conv-top"><span class="chat-conv-name">${escapeHtml(c.name)}</span><span class="chat-conv-time">${c.lastMessageAt ? fmtChatTime(c.lastMessageAt) : ""}</span></div>
        <div class="chat-conv-bottom">${preview}${c.unreadCount > 0 ? `<span class="chat-conv-badge">${c.unreadCount>99?'99+':c.unreadCount}</span>` : ""}</div>
      </div>
    </div>`;
  }
  function renderSidebar(){
    const listEl = document.getElementById("chat-conv-list");
    if(!listEl) return;
    const q = (ST.searchQuery||"").trim().toLowerCase();
    const filtered = ST.conversations.filter(c => !q || c.name.toLowerCase().includes(q));
    if(!filtered.length){
      listEl.innerHTML = `<div class="chat-empty-list">${ST.conversations.length ? "لا توجد نتائج مطابقة" : "لا توجد محادثات بعد"}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(conversationItemHtml).join("");
  }

  function updateSidebarForMessage(msg){
    const conv = ST.conversations.find(c=>c.id===msg.conversationId);
    if(!conv){ loadConversations(); return; }
    conv.lastMessage = msg.deletedAt ? "🚫 تم حذف هذه الرسالة" : (msg.poll ? `📊 استطلاع: ${msg.poll.question}` : (msg.attachment ? (msg.message || `📎 ${msg.attachment.originalName||'مرفق'}`) : msg.message));
    conv.lastMessageAt = msg.createdAt;
    if(msg.senderId !== ST.session.user.id && msg.conversationId !== ST.currentId){
      conv.unreadCount = (conv.unreadCount||0) + 1;
    }
    ST.conversations.sort((a,b)=> new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    renderSidebar();
    recomputeBadge();
  }

  /* ---------- conversation view ---------- */
  function headerSubtitle(c){
    if(c.type === "private") return presenceLabel(c);
    if(c.type === "group") return `${c.memberCount} أعضاء`;
    return `${c.memberCount} عضو · دردشة عامة`;
  }
  function showPlaceholder(){
    const mainEl = document.getElementById("chat-main");
    if(mainEl) mainEl.innerHTML = `<div class="chat-placeholder"><div class="icon">💬</div><h3>اختر محادثة</h3><p class="muted">اختر محادثة من القائمة أو ابدأ محادثة جديدة</p></div>`;
  }

  async function selectConversation(id){
    ST.currentId = id;
    ST.pendingAttachment = null;
    document.getElementById("chat-shell")?.classList.add("show-main");
    renderSidebar();
    const mainEl = document.getElementById("chat-main");
    if(mainEl) mainEl.innerHTML = `<div class="page center-txt muted">جارِ تحميل المحادثة...</div>`;
    try{
      const [{ conversation }, { members }, { messages, hasMore }] = await Promise.all([
        api(`/chat/conversations/${id}`),
        api(`/chat/conversations/${id}/members`),
        api(`/chat/conversations/${id}/messages?limit=50`),
      ]);
      ST.currentConv = conversation;
      ST.currentMembers = members;
      ST.messages = messages;
      ST.hasMore = hasMore;
      if(conversation.type === "private"){
        const other = members.find(m=>m.userId===conversation.otherUserId);
        ST.otherLastReadAt = other ? other.lastReadAt : null;
      }else{
        ST.otherLastReadAt = null;
      }
      renderConversationView();
      markRead(id);
    }catch(e){
      if(mainEl) mainEl.innerHTML = `<div class="page"><div class="error-msg">${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderConversationView(){
    const mainEl = document.getElementById("chat-main");
    if(!mainEl) return;
    const c = ST.currentConv;
    mainEl.innerHTML = `
      <div class="chat-view">
        <div class="chat-view-header">
          <button type="button" class="chat-icon-btn chat-back-btn" data-chat-action="back-to-list">→</button>
          ${avatarHtml(c)}
          <div class="chat-view-title">
            <div class="chat-view-name">${escapeHtml(c.name)}</div>
            <div class="chat-view-sub" id="chat-typing-line">${headerSubtitle(c)}</div>
          </div>
          <div class="chat-header-menu-wrap">
            <button type="button" class="chat-icon-btn" data-chat-action="header-menu-toggle">⋮</button>
            <div class="chat-dropdown chat-dropdown-left" id="chat-header-dropdown" style="display:none;">
              <button type="button" data-chat-action="open-groupinfo">ℹ️ معلومات المحادثة</button>
              ${c.permissions.canClear ? `<button type="button" data-chat-action="clear-conv">🧹 مسح الرسائل</button>` : ""}
              ${c.permissions.canDelete ? `<button type="button" data-chat-action="delete-conv">🗑 حذف المجموعة</button>` : ""}
              ${c.permissions.canLeave ? `<button type="button" data-chat-action="leave-group">🚪 مغادرة المجموعة</button>` : ""}
              ${(c.permissions.canDeleteForMe && !isPendingReferee()) ? `<button type="button" data-chat-action="delete-for-me">🗑 حذف المحادثة</button>` : ""}
            </div>
          </div>
        </div>
        <div class="chat-load-older" id="chat-load-older" style="display:none;">⏳ جارِ تحميل الرسائل الأقدم...</div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-composer">
          <div class="chat-attach-chip" id="chat-attach-chip" style="display:none;">
            <span class="chat-file-icon">📎</span><span id="chat-attach-name"></span>
            <button type="button" class="chat-icon-btn xs" data-chat-action="attach-remove">✕</button>
          </div>
          <div class="chat-composer-row">
            <div class="chat-composer-plus-wrap">
              <button type="button" class="chat-icon-btn" data-chat-action="composer-plus-toggle" title="إضافة">➕</button>
              <div class="chat-dropdown chat-dropdown-up" id="chat-composer-plus-dropdown" style="display:none;">
                <button type="button" data-chat-action="attach-btn">📎 إرفاق ملف</button>
                <button type="button" data-chat-action="open-create-poll">📊 إنشاء استطلاع</button>
              </div>
            </div>
            <input type="file" id="chat-file-input" style="display:none;">
            <div class="chat-emoji-wrap">
              <button type="button" class="chat-icon-btn" data-chat-action="emoji-toggle" title="إيموجي">😊</button>
              ${emojiPanelHtml()}
            </div>
            <textarea id="chat-text-input" rows="1" placeholder="اكتب رسالة..."></textarea>
            <button type="button" class="chat-send-btn" data-chat-action="send" title="إرسال">➤</button>
          </div>
        </div>
        <div class="chat-drop-overlay"><div>📎 أفلت الملف هنا لإرفاقه</div></div>
      </div>`;
    renderMessages();
    const msgsEl = document.getElementById("chat-messages");
    if(msgsEl) msgsEl.addEventListener("scroll", onChatMessagesScroll);
  }

  let loadingOlder = false;
  async function loadOlderMessages(){
    if(loadingOlder || !ST.hasMore || !ST.currentId || !ST.messages.length) return;
    loadingOlder = true;
    const el = document.getElementById("chat-messages");
    const indicator = document.getElementById("chat-load-older");
    if(indicator) indicator.style.display = "";
    const prevHeight = el ? el.scrollHeight : 0;
    const oldest = ST.messages[0];
    try{
      const { messages, hasMore } = await api(`/chat/conversations/${ST.currentId}/messages?limit=50&before=${encodeURIComponent(oldest.createdAt)}`);
      if(ST.currentId){
        ST.messages = [...messages, ...ST.messages];
        ST.hasMore = hasMore;
        renderMessages(true);
        if(el) el.scrollTop = el.scrollHeight - prevHeight;
      }
    }catch(e){ /* silent — the user can just keep scrolling to retry */ }
    if(indicator) indicator.style.display = "none";
    loadingOlder = false;
  }
  function onChatMessagesScroll(e){
    if(e.target.scrollTop < 60) loadOlderMessages();
  }

  function attachmentHtml(att){
    if(att.mimetype && att.mimetype.startsWith("image")){
      return `<img class="chat-msg-image" src="${att.url}" data-chat-action="zoom" data-url="${att.url}" data-mime="${att.mimetype||''}" data-title="${escapeHtml(att.originalName||'')}">`;
    }
    return `<a class="chat-file-chip" href="${att.url}" target="_blank" rel="noopener noreferrer">
      <span class="chat-file-icon">📎</span><span class="chat-file-name">${escapeHtml(att.originalName||'ملف مرفق')}</span>
    </a>`;
  }
  // Three-stage status, mirroring WhatsApp/Telegram:
  //  "sent"      — ✓  single grey tick, the server accepted the message.
  //  "delivered" — ✓✓ grey, every other member's device has received it
  //                (even if they haven't opened this conversation).
  //  "read"      — ✓✓ blue, every other member has actually opened and
  //                read it. In a group/public chat this only turns blue
  //                once *everyone* has read it, same as WhatsApp groups.
  function computeMsgStatus(m){
    if(!ST.currentConv || !ST.currentMembers) return "sent";
    const others = ST.currentMembers.filter(mm=>mm.userId !== m.senderId);
    if(!others.length) return "sent";
    const created = new Date(m.createdAt);
    const allRead = others.every(mm=> mm.lastReadAt && new Date(mm.lastReadAt) >= created);
    if(allRead) return "read";
    const allDelivered = others.every(mm=> mm.lastDeliveredAt && new Date(mm.lastDeliveredAt) >= created);
    if(allDelivered) return "delivered";
    return "sent";
  }
  function readTickHtml(m){
    const status = computeMsgStatus(m);
    const icon = status === "sent" ? "✓" : "✓✓";
    return `<span class="chat-msg-tick${status !== "sent" ? ' '+status : ''}">${icon}</span>`;
  }
  function messageBubbleHtml(m, isGroupLike){
    const me = ST.session.user.id;
    const isMine = m.senderId === me;
    const isAdminMsg = m.senderRole === "admin";
    const isPoll = !m.deletedAt && !!m.poll;
    const canEdit = !m.deletedAt && !isPoll && (isMine || ST.session.user.role === "admin");
    const canDel = !m.deletedAt && (isMine || ST.session.user.role === "admin");
    const canCopy = !m.deletedAt && !isPoll && !!(m.message && m.message.trim());
    const canReact = !m.deletedAt;
    const hasReactions = !!(m.reactions && m.reactions.length);
    return `<div class="chat-msg ${isMine ? 'mine' : 'theirs'}${isPoll ? ' chat-msg-poll' : ''}${hasReactions ? ' has-reactions' : ''}" data-msgid="${m.id}">
      <div class="chat-bubble-wrap">
        ${(!isMine && isGroupLike) ? `<div class="chat-msg-sender">${escapeHtml(m.senderName)}${isAdminMsg ? ' <span class="chat-admin-tag">الإدارة</span>' : ''}</div>` : ""}
        <div class="chat-bubble ${isAdminMsg ? 'admin-msg' : ''}" data-id="${m.id}">
          <div class="chat-bubble-inner" id="chat-bubble-inner-${m.id}">
            ${m.deletedAt ? `<div class="chat-msg-deleted">🚫 تم حذف هذه الرسالة</div>` :
              isPoll ? pollBubbleHtml(m) :
              `${m.attachment ? attachmentHtml(m.attachment) : ""}${m.message ? `<div class="chat-msg-text">${escapeHtml(m.message).replace(/\n/g,'<br>')}</div>` : ""}`}
          </div>
          <div class="chat-msg-meta">
            ${(m.editedAt && !m.deletedAt) ? `<span class="chat-msg-edited">معدَّلة</span>` : ""}
            <span class="chat-msg-time">${fmtChatTime(m.createdAt)}</span>
            ${isMine && !m.deletedAt ? readTickHtml(m) : ""}
          </div>
          ${reactionsBarHtml(m)}
        </div>
        ${(canEdit || canDel || canCopy || canReact) ? `<div class="chat-msg-menu-wrap">
          ${canReact ? `<div class="chat-reaction-wrap" id="chat-reaction-wrap-${m.id}">
            <button type="button" class="chat-icon-btn xs" data-chat-action="msg-react-toggle" data-id="${m.id}" title="تفاعل">🙂+</button>
            ${reactionPickerHtml(m)}
          </div>` : ""}
          ${(canEdit || canDel || canCopy) ? `<button type="button" class="chat-icon-btn xs" data-chat-action="msg-menu-toggle" data-id="${m.id}">⋮</button>
          <div class="chat-dropdown chat-msg-dropdown" id="chat-msg-dropdown-${m.id}" style="display:none;">
            ${canCopy ? `<button type="button" data-chat-action="msg-copy" data-id="${m.id}">📋 نسخ النص</button>` : ""}
            ${canEdit ? `<button type="button" data-chat-action="msg-edit" data-id="${m.id}">✎ تعديل</button>` : ""}
            ${canDel ? `<button type="button" data-chat-action="msg-delete" data-id="${m.id}">🗑 حذف</button>` : ""}
          </div>` : ""}
        </div>` : ""}
      </div>
    </div>`;
  }
  function renderMessages(keepScroll){
    const el = document.getElementById("chat-messages");
    if(!el) return;
    const isGroupLike = ST.currentConv && ST.currentConv.type !== "private";
    let html = "";
    let lastDay = null;
    ST.messages.forEach((m)=>{
      const day = dayLabel(m.createdAt);
      if(day !== lastDay){ html += `<div class="chat-day-sep"><span>${day}</span></div>`; lastDay = day; }
      html += messageBubbleHtml(m, isGroupLike);
    });
    el.innerHTML = html || `<div class="chat-empty-list">لا توجد رسائل بعد — ابدأ المحادثة!</div>`;
    if(!keepScroll) el.scrollTop = el.scrollHeight;
  }

  function appendOrUpdateMessage(msg){
    updateSidebarForMessage(msg);
    if(msg.conversationId !== ST.currentId) return;
    const idx = ST.messages.findIndex(m=>m.id===msg.id);
    const isNew = idx < 0;
    if(idx >= 0) ST.messages[idx] = msg; else ST.messages.push(msg);
    renderMessages();
    if(isNew){
      const el = document.querySelector(`.chat-msg[data-msgid="${msg.id}"]`);
      if(el) el.classList.add("chat-msg-pop");
    }
    if(msg.senderId !== ST.session.user.id) markRead(ST.currentId);
  }
  function updateMessageInPlace(msg){
    updateSidebarForMessage(msg);
    if(msg.conversationId !== ST.currentId) return;
    const idx = ST.messages.findIndex(m=>m.id===msg.id);
    if(idx >= 0){ ST.messages[idx] = msg; renderMessages(); }
  }
  function markMessageDeletedInPlace(payload){
    loadConversations();
    if(payload.conversationId !== ST.currentId) return;
    const idx = ST.messages.findIndex(m=>m.id===payload.id);
    if(idx >= 0){ ST.messages[idx] = { ...ST.messages[idx], deletedAt: payload.deletedAt, message:"", attachment:null }; renderMessages(); }
  }
  function showTyping(payload){
    const key = payload.conversationId + "::" + payload.userId;
    clearTimeout(typingTimers[key]);
    typingTimers[key] = setTimeout(()=>{
      delete typingTimers[key];
      if(payload.conversationId === ST.currentId){
        ST.typingActive = false;
        const sub = document.getElementById("chat-typing-line");
        if(sub && ST.currentConv) sub.textContent = headerSubtitle(ST.currentConv);
      }
      const conv = ST.conversations.find(c=>c.id===payload.conversationId);
      if(conv){ conv._typingLabel = null; renderSidebar(); }
    }, 3000);

    if(payload.conversationId === ST.currentId){
      ST.typingActive = true;
      const sub = document.getElementById("chat-typing-line");
      if(sub) sub.textContent = `${payload.fullNameAr} يكتب الآن...`;
    }
    const conv = ST.conversations.find(c=>c.id===payload.conversationId);
    if(conv){ conv._typingLabel = payload.fullNameAr; renderSidebar(); }
  }

  /* ---------- emoji picker ---------- */
  const EMOJI_CATEGORY_ORDER = ["smileys","gestures","people","animals","food","activities","travel","objects","symbols","flags"];
  let emojiCategory = EMOJI_CATEGORY_ORDER[0];
  let emojiQuery = "";

  function emojiPanelHtml(){
    const data = window.LWF_EMOJI || {};
    const tabs = EMOJI_CATEGORY_ORDER.filter((k)=>data[k]).map((k)=>`
      <button type="button" class="chat-emoji-tab${k===emojiCategory ? ' active' : ''}" data-chat-action="emoji-cat" data-cat="${k}" title="${escapeHtml(data[k].label)}">${data[k].icon}</button>
    `).join("");
    return `<div class="chat-emoji-panel" id="chat-emoji-panel" style="display:none;">
      <div class="chat-emoji-search"><input type="text" id="chat-emoji-search" placeholder="🔍 بحث عن إيموجي..."></div>
      <div class="chat-emoji-tabs">${tabs}</div>
      <div class="chat-emoji-grid" id="chat-emoji-grid"></div>
    </div>`;
  }
  function renderEmojiGrid(){
    const grid = document.getElementById("chat-emoji-grid");
    if(!grid) return;
    const data = window.LWF_EMOJI || {};
    const q = (emojiQuery||"").trim().toLowerCase();
    let items;
    if(q){
      const keywords = window.LWF_EMOJI_KEYWORDS || {};
      const seen = new Set();
      items = [];
      Object.keys(keywords).forEach((kw)=>{
        if(kw.toLowerCase().includes(q)){
          keywords[kw].forEach((e)=>{ if(!seen.has(e)){ seen.add(e); items.push(e); } });
        }
      });
    }else{
      items = (data[emojiCategory] && data[emojiCategory].items) || [];
    }
    grid.innerHTML = items.length
      ? items.map((e)=>`<button type="button" class="chat-emoji-btn" data-chat-action="emoji-pick" data-emoji="${e}">${e}</button>`).join("")
      : `<div class="muted text-sm" style="padding:10px;">لا توجد نتائج</div>`;
  }
  let emojiResizeHandler = null;
  function toggleEmojiPanel(){
    const panel = document.getElementById("chat-emoji-panel");
    if(!panel) return;
    const willOpen = panel.style.display === "none" || !panel.style.display;
    document.querySelectorAll(".chat-dropdown").forEach((d)=>d.style.display = "none");
    panel.style.display = willOpen ? "" : "none";
    if(willOpen){
      renderEmojiGrid();
      positionEmojiPanel();
      // Keep it correctly positioned across orientation/viewport changes
      // while it's open (e.g. rotating a phone, or the on-screen keyboard
      // resizing the layout). The listener retires itself once the panel is
      // no longer open, so it never leaks across conversation switches.
      if(!emojiResizeHandler){
        emojiResizeHandler = () => {
          const p = document.getElementById("chat-emoji-panel");
          if(!p || p.style.display === "none"){
            window.removeEventListener("resize", emojiResizeHandler);
            emojiResizeHandler = null;
            return;
          }
          positionEmojiPanel();
        };
        window.addEventListener("resize", emojiResizeHandler);
      }
    }
  }
  /* Smart positioning: the panel opens to the left of the button by default
     (see chat.css). If there isn't enough room on that side — e.g. the
     button sits near the left edge of a narrow/mobile chat window — flip it
     to open on the right instead. If neither side has full room (very narrow
     screens), nudge it inward by whatever's left over so it's always fully
     visible instead of being clipped by chat-shell's overflow:hidden or the
     edge of the screen. */
  function positionEmojiPanel(){
    const panel = document.getElementById("chat-emoji-panel");
    const wrap = panel && panel.closest(".chat-emoji-wrap");
    if(!panel || !wrap) return;
    panel.classList.remove("chat-emoji-panel-flip");
    panel.style.transform = "";
    const shell = wrap.closest(".chat-shell");
    const shellRect = shell ? shell.getBoundingClientRect() : null;
    const GAP = 6;
    const boundLeft = shellRect ? shellRect.left : 0;
    const boundRight = shellRect ? shellRect.right : window.innerWidth;
    const wrapRect = wrap.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 300;

    const defaultOverflow = Math.max(0, (boundLeft + GAP) - (wrapRect.right - panelWidth));
    const flipOverflow = Math.max(0, (wrapRect.left + panelWidth) - (boundRight - GAP));

    if(flipOverflow < defaultOverflow) panel.classList.add("chat-emoji-panel-flip");

    const remaining = Math.min(defaultOverflow, flipOverflow);
    if(remaining > 0){
      const usingFlip = panel.classList.contains("chat-emoji-panel-flip");
      panel.style.transform = `translateX(${usingFlip ? "-" : ""}${remaining}px)`;
    }
  }
  function switchEmojiCategory(cat){
    emojiCategory = cat;
    emojiQuery = "";
    const search = document.getElementById("chat-emoji-search");
    if(search) search.value = "";
    document.querySelectorAll(".chat-emoji-tab").forEach((t)=>t.classList.toggle("active", t.getAttribute("data-cat")===cat));
    renderEmojiGrid();
  }
  function insertEmoji(emoji){
    const ta = document.getElementById("chat-text-input");
    if(!ta){ return; }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    const caret = start + emoji.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    autoGrow(ta);
    pingTyping();
  }

  /* ---------- composer ---------- */
  function autoGrow(ta){ ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }
  function pingTyping(){
    if(!ST.currentId) return;
    const now = Date.now();
    if(now - lastTypingPingAt < 2000) return;
    lastTypingPingAt = now;
    api(`/chat/conversations/${ST.currentId}/typing`, { method:"POST" }).catch(()=>{});
  }
  function stageAttachment(file){ ST.pendingAttachment = file; renderAttachPreview(); }
  function renderAttachPreview(){
    const chip = document.getElementById("chat-attach-chip");
    if(!chip) return;
    if(ST.pendingAttachment){
      chip.style.display = "";
      const nameEl = document.getElementById("chat-attach-name");
      if(nameEl) nameEl.textContent = ST.pendingAttachment.name;
    }else{
      chip.style.display = "none";
    }
  }
  async function sendMessage(){
    if(!ST.currentId) return;
    const ta = document.getElementById("chat-text-input");
    const text = ta ? ta.value.trim() : "";
    if(!text && !ST.pendingAttachment) return;
    const file = ST.pendingAttachment;
    if(ta){ ta.value = ""; autoGrow(ta); }
    ST.pendingAttachment = null; renderAttachPreview();
    try{
      const fd = new FormData();
      if(text) fd.append("message", text);
      if(file) fd.append("attachment", file);
      const { message } = await api(`/chat/conversations/${ST.currentId}/messages`, { method:"POST", body:fd, isForm:true });
      appendOrUpdateMessage(message);
    }catch(e){ alert(e.message); }
  }

  function startEditMessage(id){
    const m = ST.messages.find(x=>x.id===id);
    const el = document.getElementById(`chat-bubble-inner-${id}`);
    if(!m || !el) return;
    el.innerHTML = `<textarea class="chat-edit-textarea" id="chat-edit-ta-${id}">${escapeHtml(m.message)}</textarea>
      <div class="chat-edit-actions">
        <button type="button" class="btn btn-primary btn-sm" data-chat-action="msg-edit-save" data-id="${id}">حفظ</button>
        <button type="button" class="btn btn-ghost btn-sm" data-chat-action="msg-edit-cancel" data-id="${id}">إلغاء</button>
      </div>`;
    const ta = document.getElementById(`chat-edit-ta-${id}`);
    if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  async function saveEditMessage(id){
    const ta = document.getElementById(`chat-edit-ta-${id}`);
    if(!ta) return;
    const text = ta.value.trim();
    if(!text) return alert("لا يمكن أن تكون الرسالة فارغة.");
    try{
      const { message } = await api(`/chat/messages/${id}`, { method:"PUT", body:{ message:text } });
      updateMessageInPlace(message);
    }catch(e){ alert(e.message); }
  }
  async function deleteMessage(id){
    if(!confirm("هل تريد حذف هذه الرسالة؟")) return;
    try{
      await api(`/chat/messages/${id}`, { method:"DELETE" });
      const idx = ST.messages.findIndex(m=>m.id===id);
      if(idx >= 0){ ST.messages[idx] = { ...ST.messages[idx], deletedAt: new Date().toISOString(), message:"", attachment:null }; renderMessages(); }
    }catch(e){ alert(e.message); }
  }
  // Small transient confirmation bubble (e.g. "تم نسخ النص") — self-removing,
  // doesn't block interaction, no persisted state.
  let toastTimer = null;
  function showChatToast(text){
    let el = document.getElementById("chat-toast");
    if(!el){
      el = document.createElement("div");
      el.id = "chat-toast";
      el.className = "chat-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{ el.classList.remove("show"); }, 1800);
  }
  async function copyMessageText(id){
    const m = ST.messages.find(x=>x.id===id);
    if(!m || !m.message) return;
    try{
      if(navigator.clipboard && window.isSecureContext){
        await navigator.clipboard.writeText(m.message);
      }else{
        const ta = document.createElement("textarea");
        ta.value = m.message;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showChatToast("✅ تم نسخ النص");
    }catch(e){ showChatToast("تعذّر نسخ النص"); }
  }
  function toggleMsgMenu(id){
    document.querySelectorAll(".chat-dropdown").forEach((d)=>{ if(d.id !== `chat-msg-dropdown-${id}`) d.style.display = "none"; });
    const d = document.getElementById(`chat-msg-dropdown-${id}`);
    if(!d) return;
    const willOpen = d.style.display === "none" || !d.style.display;
    d.style.display = willOpen ? "" : "none";
    if(willOpen) positionDropdown(d);
  }
  let dropdownResizeHandler = null;
  /* Generic clamp for every .chat-dropdown (sidebar "+", header "⋮", and the
     composer "+" attachment menu): after the browser lays it out at its
     CSS-specified default position, measure where it actually landed and, if
     any edge pokes past the chat shell / viewport, nudge it back on-screen
     with a transform. This is what was silently breaking the composer "+"
     menu — it had no left/right override, so it inherited the default
     left:0 and grew further right from a button that already sits at the
     right edge of the row in this RTL layout, pushing most of the menu off
     the right edge of the screen. Measuring the real rendered position (
     instead of hardcoding a direction per dropdown) fixes that case and
     covers any future dropdown the same way. */
  function positionDropdown(el){
    const wrap = el && el.parentElement;
    if(!el || !wrap) return;
    el.style.transform = "";
    const shell = document.getElementById("chat-shell");
    const bounds = (shell || document.body).getBoundingClientRect();
    const GAP = 6;
    const rect = el.getBoundingClientRect();
    let shiftX = 0, shiftY = 0;
    if(rect.left < bounds.left + GAP) shiftX = (bounds.left + GAP) - rect.left;
    else if(rect.right > bounds.right - GAP) shiftX = (bounds.right - GAP) - rect.right;
    if(rect.top < bounds.top + GAP) shiftY = (bounds.top + GAP) - rect.top;
    else if(rect.bottom > bounds.bottom - GAP) shiftY = (bounds.bottom - GAP) - rect.bottom;
    if(shiftX || shiftY) el.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
  }
  function toggleDropdown(domId){
    const el = document.getElementById(domId);
    if(!el) return;
    const willOpen = el.style.display === "none" || !el.style.display;
    document.querySelectorAll(".chat-dropdown").forEach((d)=>d.style.display = "none");
    el.style.display = willOpen ? "" : "none";
    if(willOpen){
      positionDropdown(el);
      if(!dropdownResizeHandler){
        dropdownResizeHandler = () => {
          const open = Array.from(document.querySelectorAll(".chat-dropdown")).find((d) => d.style.display !== "none");
          if(!open){ window.removeEventListener("resize", dropdownResizeHandler); dropdownResizeHandler = null; return; }
          positionDropdown(open);
        };
        window.addEventListener("resize", dropdownResizeHandler);
      }
    }
  }

  /* ---------- modals ---------- */
  function openModal(html){
    const root = document.getElementById("chat-modal-root");
    if(!root) return;
    root.innerHTML = `<div class="chat-modal-overlay">${html}</div>`;
    const overlay = root.querySelector(".chat-modal-overlay");
    overlay.addEventListener("click", (e)=>{ if(e.target === overlay) closeModal(); });
  }
  function closeModal(){
    const root = document.getElementById("chat-modal-root");
    if(root) root.innerHTML = "";
  }

  function renderMemberPicker(containerId, list, checkedIds){
    const el = document.getElementById(containerId);
    if(!el) return;
    if(!list.length){ el.innerHTML = `<div class="muted text-sm" style="padding:10px;">لا يوجد حكام</div>`; return; }
    el.innerHTML = list.map((u)=>`
      <label class="chat-picker-row">
        <input type="checkbox" value="${u.id}" ${checkedIds.includes(u.id)?'checked':''}>
        ${personAvatarHtml(u, "sm")}
        <span>${escapeHtml(u.fullNameAr)}</span>
      </label>`).join("");
  }
  function filterPickerRows(containerId, query){
    const el = document.getElementById(containerId);
    if(!el) return;
    const q = (query||"").trim().toLowerCase();
    el.querySelectorAll(".chat-picker-row").forEach((row)=>{
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  }

  /* ---------- Group photo: pick a file, then crop it to a circle ----------
     A single reusable flow: openPhotoCropModal(onCropped, onCancel) opens
     the OS file picker, then a drag-to-pan / slider-to-zoom crop stage, and
     calls onCropped(blob) with a finished circular PNG once confirmed (or
     onCancel() if the person backs out). Used both by "مجموعة جديدة" (crop
     first, upload happens after the group itself is created and has an id)
     and by group info's "تغيير الصورة" (group already exists, uploads
     immediately). Callers don't need to know any of the pan/zoom math. */
  const CROP_STAGE = 260;   // on-screen crop square, css px
  const CROP_OUTPUT = 480;  // exported PNG resolution — sharp at any avatar size we ever render it at
  let cropState = null;

  function openPhotoCropModal(onCropped, onCancel){
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.addEventListener("change", ()=>{
      const file = input.files && input.files[0];
      if(!file){ if(onCancel) onCancel(); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = ()=>{
        const minScale = Math.max(CROP_STAGE / img.naturalWidth, CROP_STAGE / img.naturalHeight);
        cropState = { img, naturalW: img.naturalWidth, naturalH: img.naturalHeight, minScale, scale: minScale, offsetX: 0, offsetY: 0, onCropped, onCancel };
        cropState.offsetX = (CROP_STAGE - img.naturalWidth * minScale) / 2;
        cropState.offsetY = (CROP_STAGE - img.naturalHeight * minScale) / 2;
        renderCropModal();
      };
      img.onerror = ()=>{ alert("تعذّر فتح هذه الصورة."); if(onCancel) onCancel(); };
      img.src = url;
    });
    // If the person opens the picker and closes it without choosing a file,
    // most browsers never fire "change" — a window focus after the dialog
    // closes is the standard signal to check for that case.
    const checkCancelled = ()=>{
      window.removeEventListener("focus", checkCancelled);
      setTimeout(()=>{ if(!input.files || !input.files.length){ if(onCancel && !cropState) onCancel(); } }, 300);
    };
    window.addEventListener("focus", checkCancelled);
    input.click();
  }
  function clampCropOffsets(){
    const s = cropState;
    const dispW = s.naturalW * s.scale, dispH = s.naturalH * s.scale;
    s.offsetX = Math.max(Math.min(0, CROP_STAGE - dispW), Math.min(0, s.offsetX));
    s.offsetY = Math.max(Math.min(0, CROP_STAGE - dispH), Math.min(0, s.offsetY));
  }
  function applyCropTransform(){
    const s = cropState;
    const imgEl = document.getElementById("crop-img");
    if(!imgEl) return;
    imgEl.style.width = (s.naturalW * s.scale) + "px";
    imgEl.style.height = (s.naturalH * s.scale) + "px";
    imgEl.style.transform = `translate(${s.offsetX}px,${s.offsetY}px)`;
  }
  function renderCropModal(){
    const s = cropState;
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>تحديد صورة المجموعة</h3><button type="button" class="chat-icon-btn" data-chat-action="crop-cancel">✕</button></div>
        <div class="chat-modal-body">
          <div class="crop-stage" id="crop-stage" style="width:${CROP_STAGE}px;height:${CROP_STAGE}px;">
            <img id="crop-img" src="${escapeHtml(s.img.src)}" draggable="false" style="width:${s.naturalW*s.scale}px;height:${s.naturalH*s.scale}px;transform:translate(${s.offsetX}px,${s.offsetY}px);">
            <div class="crop-circle-mask"></div>
          </div>
          <div class="field mt-8">
            <label>تكبير</label>
            <input type="range" id="crop-zoom" min="0" max="100" value="0">
          </div>
          <p class="muted text-sm">اسحب الصورة لتحديد الجزء الذي تريد أن يظهر داخل الدائرة</p>
        </div>
        <div class="chat-modal-foot">
          <button type="button" class="btn btn-outline" data-chat-action="crop-cancel">إلغاء</button>
          <button type="button" class="btn btn-primary" data-chat-action="crop-confirm">استخدام هذه الصورة</button>
        </div>
      </div>`);
    wireCropDrag();
    const zoomEl = document.getElementById("crop-zoom");
    if(zoomEl) zoomEl.addEventListener("input", ()=>{
      const pct = Number(zoomEl.value);
      const newScale = s.minScale * (1 + (pct/100) * 2); // 0% = fits stage exactly, 100% = 3× that
      // Re-anchor on the stage's center point so zooming feels like it
      // zooms into whatever's centered, not toward the image's corner.
      const cx = CROP_STAGE/2, cy = CROP_STAGE/2;
      const imgCx = (cx - s.offsetX) / s.scale, imgCy = (cy - s.offsetY) / s.scale;
      s.scale = newScale;
      s.offsetX = cx - imgCx * s.scale;
      s.offsetY = cy - imgCy * s.scale;
      clampCropOffsets();
      applyCropTransform();
    });
  }
  function wireCropDrag(){
    const stage = document.getElementById("crop-stage");
    const imgEl = document.getElementById("crop-img");
    if(!stage || !imgEl) return;
    let dragging = false, startX=0, startY=0, startOffX=0, startOffY=0;
    stage.addEventListener("pointerdown", (e)=>{
      dragging = true; startX = e.clientX; startY = e.clientY;
      startOffX = cropState.offsetX; startOffY = cropState.offsetY;
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e)=>{
      if(!dragging) return;
      cropState.offsetX = startOffX + (e.clientX - startX);
      cropState.offsetY = startOffY + (e.clientY - startY);
      clampCropOffsets();
      applyCropTransform();
    });
    const stop = ()=>{ dragging = false; };
    stage.addEventListener("pointerup", stop);
    stage.addEventListener("pointercancel", stop);
    stage.addEventListener("pointerleave", stop);
  }
  function cropToCircleBlob(){
    const s = cropState;
    return new Promise((resolve)=>{
      const canvas = document.createElement("canvas");
      canvas.width = CROP_OUTPUT; canvas.height = CROP_OUTPUT;
      const ctx = canvas.getContext("2d");
      const r = CROP_OUTPUT / CROP_STAGE; // same scene, rendered at export resolution instead of on-screen size
      ctx.save();
      ctx.beginPath();
      ctx.arc(CROP_OUTPUT/2, CROP_OUTPUT/2, CROP_OUTPUT/2, 0, Math.PI*2);
      ctx.clip();
      ctx.drawImage(s.img, s.offsetX*r, s.offsetY*r, s.naturalW*s.scale*r, s.naturalH*s.scale*r);
      ctx.restore();
      canvas.toBlob((blob)=> resolve(blob), "image/png", 0.92);
    });
  }
  async function confirmCrop(){
    if(!cropState) return;
    const blob = await cropToCircleBlob();
    const onCropped = cropState.onCropped;
    cropState = null;
    if(onCropped) onCropped(blob);
  }
  function cancelCrop(){
    const onCancel = cropState ? cropState.onCancel : null;
    cropState = null;
    if(onCancel) onCancel(); else closeModal();
  }

  // Draft state for the "مجموعة جديدة" form — kept outside the modal so a
  // trip through the crop flow (which takes over the modal temporarily)
  // doesn't lose whatever name/members the person already picked.
  let newGroupDraft = { name: "", memberIds: [], photoBlob: null, photoPreviewUrl: null };

  function newGroupPhotoPickerHtml(){
    const preview = newGroupDraft.photoPreviewUrl
      ? `<img class="chat-avatar" src="${escapeHtml(newGroupDraft.photoPreviewUrl)}" alt="">`
      : `<div class="chat-avatar group">👥</div>`;
    return `
      <div class="field">
        <label>صورة المجموعة (اختياري)</label>
        <div class="group-photo-picker">
          <button type="button" class="group-photo-picker-avatar" data-chat-action="pick-group-photo" title="اختيار صورة">${preview}</button>
          <div class="group-photo-picker-actions">
            <button type="button" class="btn btn-outline btn-sm" data-chat-action="pick-group-photo">${newGroupDraft.photoPreviewUrl ? 'تغيير الصورة' : 'اختيار صورة'}</button>
            ${newGroupDraft.photoPreviewUrl ? `<button type="button" class="btn btn-ghost btn-sm" data-chat-action="remove-group-photo-draft">إزالة</button>` : ""}
          </div>
        </div>
      </div>`;
  }
  async function openNewGroupModal(){
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>مجموعة جديدة</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">
          ${newGroupPhotoPickerHtml()}
          <div class="field"><label>اسم المجموعة</label><input type="text" id="chat-newgroup-name" placeholder="مثال: حكام الدرجة الأولى" value="${escapeHtml(newGroupDraft.name)}"></div>
          <div class="field">
            <label>الأعضاء</label>
            <input type="text" id="chat-newgroup-search" placeholder="🔍 بحث عن حكم...">
            <div class="chat-member-picker" id="chat-newgroup-list"><div class="muted text-sm" style="padding:10px;">جارِ التحميل...</div></div>
          </div>
          <div id="chat-newgroup-error"></div>
        </div>
        <div class="chat-modal-foot">
          <button type="button" class="btn btn-outline" data-chat-action="modal-close">إلغاء</button>
          <button type="button" class="btn btn-primary" data-chat-action="newgroup-submit">إنشاء المجموعة</button>
        </div>
      </div>`);
    try{
      const { referees } = await api("/chat/directory");
      renderMemberPicker("chat-newgroup-list", referees, newGroupDraft.memberIds);
    }catch(e){
      const el = document.getElementById("chat-newgroup-list");
      if(el) el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  function saveNewGroupDraftFromForm(){
    const nameEl = document.getElementById("chat-newgroup-name");
    newGroupDraft.name = nameEl ? nameEl.value : "";
    newGroupDraft.memberIds = Array.from(document.querySelectorAll("#chat-newgroup-list input[type=checkbox]:checked")).map(c=>c.value);
  }
  function pickNewGroupPhoto(){
    saveNewGroupDraftFromForm();
    openPhotoCropModal(
      (blob)=>{
        newGroupDraft.photoBlob = blob;
        if(newGroupDraft.photoPreviewUrl) URL.revokeObjectURL(newGroupDraft.photoPreviewUrl);
        newGroupDraft.photoPreviewUrl = URL.createObjectURL(blob);
        openNewGroupModal();
      },
      ()=> openNewGroupModal()
    );
  }
  async function submitNewGroup(){
    const nameEl = document.getElementById("chat-newgroup-name");
    const errEl = document.getElementById("chat-newgroup-error");
    const name = nameEl ? nameEl.value.trim() : "";
    if(!name){ if(errEl) errEl.innerHTML = `<div class="error-msg">يرجى إدخال اسم المجموعة.</div>`; return; }
    const memberIds = Array.from(document.querySelectorAll("#chat-newgroup-list input[type=checkbox]:checked")).map(c=>c.value);
    try{
      const { conversation } = await api("/chat/groups", { method:"POST", body:{ name, memberIds } });
      if(newGroupDraft.photoBlob){
        const fd = new FormData();
        fd.append("file", newGroupDraft.photoBlob, "group.png");
        try{ await api(`/chat/groups/${conversation.id}/photo`, { method:"POST", body:fd, isForm:true }); }
        catch(photoErr){ /* group already created successfully — a failed photo upload shouldn't block that */ console.error(photoErr); }
      }
      if(newGroupDraft.photoPreviewUrl) URL.revokeObjectURL(newGroupDraft.photoPreviewUrl);
      newGroupDraft = { name: "", memberIds: [], photoBlob: null, photoPreviewUrl: null };
      closeModal();
      await loadConversations();
      selectConversation(conversation.id);
    }catch(e){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
  }


  async function openRefereesModal(){
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>بدء محادثة مع حكم</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">
          <input type="text" id="chat-referees-search" placeholder="🔍 بحث عن حكم...">
          <div class="chat-member-picker" id="chat-referees-list"><div class="muted text-sm" style="padding:10px;">جارِ التحميل...</div></div>
        </div>
      </div>`);
    try{
      const { referees } = await api("/chat/referees");
      renderRefereesList(referees);
    }catch(e){
      const el = document.getElementById("chat-referees-list");
      if(el) el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  function renderRefereesList(list){
    const el = document.getElementById("chat-referees-list");
    if(!el) return;
    if(!list.length){ el.innerHTML = `<div class="muted text-sm" style="padding:10px;">لا يوجد حكام مسجَّلون</div>`; return; }
    el.innerHTML = list.map((u)=>`
      <div class="chat-picker-row clickable" data-chat-action="referee-pick" data-id="${u.id}">
        ${personAvatarHtml(u, "sm")}
        <span>${escapeHtml(u.fullNameAr)}</span>
        ${u.conversationId ? `<span class="text-sm muted chat-picker-hint">محادثة قائمة</span>` : ""}
      </div>`).join("");
  }
  async function startPrivateChatWithReferee(refereeId){
    try{
      const { conversation } = await api(`/chat/private/${refereeId}`, { method:"POST" });
      closeModal();
      await loadConversations();
      selectConversation(conversation.id);
    }catch(e){ alert(e.message); }
  }

  function memberRowHtml(m, c){
    const canRemove = c.permissions.canRemoveMembers && (c.type === "group" || c.type === "public") && m.userRole !== "admin" && m.userId !== ST.session.user.id;
    return `<div class="chat-member-row" data-member-row="${m.userId}">
      ${personAvatarHtml(m, "sm")}
      <div class="chat-member-info">
        <span class="chat-member-name">${escapeHtml(m.fullNameAr)}${m.userRole==='admin' ? ' <span class="chat-admin-tag">الإدارة</span>' : ''}${(m.role==='owner' && m.userRole!=='admin') ? ' <span class="chat-owner-tag">منشئ المجموعة</span>' : ''}</span>
        <span class="chat-member-presence${m.online ? ' online' : ''}">${presenceLabel(m)}</span>
      </div>
      ${canRemove ? `<button type="button" class="chat-icon-btn xs" data-chat-action="remove-member" data-id="${m.userId}" title="إزالة">✕</button>` : ""}
    </div>`;
  }
  function groupInfoPhotoHtml(c){
    if(c.type !== "group") return "";
    const avatar = c.photoUrl ? `<img class="chat-avatar" src="${escapeHtml(c.photoUrl)}" alt="">` : `<div class="chat-avatar group">👥</div>`;
    if(!c.permissions.canEditPhoto){
      return `<div class="group-photo-picker group-photo-picker-readonly">${avatar}</div>`;
    }
    return `
      <div class="group-photo-picker">
        <button type="button" class="group-photo-picker-avatar" data-chat-action="change-group-photo" title="تغيير الصورة">${avatar}</button>
        <div class="group-photo-picker-actions">
          <button type="button" class="btn btn-outline btn-sm" data-chat-action="change-group-photo">${c.photoUrl ? 'تغيير الصورة' : 'اختيار صورة'}</button>
          ${c.photoUrl ? `<button type="button" class="btn btn-ghost btn-sm" data-chat-action="remove-group-photo">إزالة الصورة</button>` : ""}
        </div>
      </div>`;
  }
  function openGroupInfoModal(){
    const c = ST.currentConv;
    if(!c) return;
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>معلومات المحادثة</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">
          ${groupInfoPhotoHtml(c)}
          ${c.permissions.canRename ? `
            <div class="field"><label>اسم المجموعة</label>
              <div class="flex gap-8"><input type="text" id="chat-rename-input" value="${escapeHtml(c.name)}"><button type="button" class="btn btn-outline btn-sm" data-chat-action="rename-submit">حفظ</button></div>
            </div>` : `<div class="field"><label>الاسم</label><div>${escapeHtml(c.name)}</div></div>`}
          <div id="chat-rename-error"></div>
          <div class="section-title">الأعضاء (${c.memberCount})</div>
          <div id="chat-groupinfo-members">${ST.currentMembers.map(m=>memberRowHtml(m, c)).join("")}</div>
          ${(c.permissions.canAddMembers && (c.type==='group' || c.type==='public')) ? `<button type="button" class="btn btn-outline btn-sm mt-8" data-chat-action="open-addmembers">+ إضافة أعضاء</button>` : ""}
        </div>
      </div>`);
  }
  function changeExistingGroupPhoto(){
    openPhotoCropModal(
      async (blob)=>{
        const fd = new FormData();
        fd.append("file", blob, "group.png");
        try{
          await api(`/chat/groups/${ST.currentId}/photo`, { method:"POST", body:fd, isForm:true });
          await refreshCurrentConversationMeta();
        }catch(e){ alert(e.message); }
        openGroupInfoModal();
      },
      ()=> openGroupInfoModal()
    );
  }
  async function removeExistingGroupPhoto(){
    if(!confirm("إزالة صورة المجموعة؟")) return;
    try{
      await api(`/chat/groups/${ST.currentId}/photo`, { method:"DELETE" });
      await refreshCurrentConversationMeta();
    }catch(e){ alert(e.message); }
    openGroupInfoModal();
  }
  async function submitRename(){
    const input = document.getElementById("chat-rename-input");
    const errEl = document.getElementById("chat-rename-error");
    const name = input ? input.value.trim() : "";
    if(!name) return;
    try{
      await api(`/chat/groups/${ST.currentId}`, { method:"PUT", body:{ name } });
      closeModal();
    }catch(e){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
  }
  async function removeMemberConfirm(userId){
    const m = ST.currentMembers.find(x=>x.userId===userId);
    if(!confirm(`هل تريد إزالة "${m ? m.fullNameAr : ''}" من المجموعة؟`)) return;
    try{
      await api(`/chat/groups/${ST.currentId}/members/${userId}`, { method:"DELETE" });
      closeModal();
    }catch(e){ alert(e.message); }
  }
  async function openAddMembersModal(){
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>إضافة أعضاء</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">
          <input type="text" id="chat-addmembers-search" placeholder="🔍 بحث عن حكم...">
          <div class="chat-member-picker" id="chat-addmembers-list"><div class="muted text-sm" style="padding:10px;">جارِ التحميل...</div></div>
          <div id="chat-addmembers-error"></div>
        </div>
        <div class="chat-modal-foot">
          <button type="button" class="btn btn-outline" data-chat-action="modal-close">إلغاء</button>
          <button type="button" class="btn btn-primary" data-chat-action="add-members-submit">إضافة</button>
        </div>
      </div>`);
    try{
      const { candidates } = await api(`/chat/conversations/${ST.currentId}/candidates`);
      renderMemberPicker("chat-addmembers-list", candidates, []);
    }catch(e){
      const el = document.getElementById("chat-addmembers-list");
      if(el) el.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  async function submitAddMembers(){
    const memberIds = Array.from(document.querySelectorAll("#chat-addmembers-list input[type=checkbox]:checked")).map(c=>c.value);
    const errEl = document.getElementById("chat-addmembers-error");
    if(!memberIds.length){ if(errEl) errEl.innerHTML = `<div class="error-msg">اختر عضوًا واحدًا على الأقل.</div>`; return; }
    try{
      await api(`/chat/groups/${ST.currentId}/members`, { method:"POST", body:{ memberIds } });
      closeModal();
    }catch(e){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
  }
  /* ---------- polls ---------- */
  let pollType = "yesno";

  function openCreatePollModal(){
    pollType = "yesno";
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>إنشاء استطلاع</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">
          <div class="field">
            <label>نوع الاستطلاع</label>
            <div class="chat-poll-type-toggle">
              <button type="button" class="chat-poll-type-btn active" data-chat-action="poll-type" data-type="yesno">نعم / لا</button>
              <button type="button" class="chat-poll-type-btn" data-chat-action="poll-type" data-type="multi">متعدد الخيارات</button>
            </div>
          </div>
          <div class="field"><label>سؤال الاستطلاع</label><input type="text" id="chat-poll-question" placeholder="مثال: هل تستطيع حضور الاجتماع؟"></div>
          <div class="field" id="chat-poll-options-field">
            <label>الخيارات</label>
            <div id="chat-poll-options-list"></div>
            <button type="button" class="btn btn-outline btn-sm mt-8" id="chat-poll-add-btn" data-chat-action="poll-add-option">+ إضافة خيار</button>
          </div>
          <div class="field"><label>موعد انتهاء التصويت (اختياري)</label><input type="datetime-local" id="chat-poll-expires"></div>
          <label class="chat-poll-anon-toggle">
            <input type="checkbox" id="chat-poll-anonymous">
            <span>🔒 استطلاع سري (إخفاء أسماء المصوّتين عن الجميع)</span>
          </label>
          <div id="chat-poll-error"></div>
        </div>
        <div class="chat-modal-foot">
          <button type="button" class="btn btn-outline" data-chat-action="modal-close">إلغاء</button>
          <button type="button" class="btn btn-primary" data-chat-action="poll-submit">نشر الاستطلاع</button>
        </div>
      </div>`);
    renderPollOptionsUI([]);
  }

  function currentPollOptionValues(){
    return Array.from(document.querySelectorAll(".chat-poll-option-input")).map((i)=>i.value);
  }

  function renderPollOptionsUI(existingValues){
    const list = document.getElementById("chat-poll-options-list");
    const addBtn = document.getElementById("chat-poll-add-btn");
    if(!list) return;
    if(pollType === "yesno"){
      list.innerHTML = `
        <div class="chat-poll-option-row static"><span class="chat-poll-radio"></span> نعم</div>
        <div class="chat-poll-option-row static"><span class="chat-poll-radio"></span> لا</div>`;
      if(addBtn) addBtn.style.display = "none";
      return;
    }
    if(addBtn) addBtn.style.display = "";
    const values = existingValues && existingValues.length >= 2 ? existingValues : ["", ""];
    list.innerHTML = values.map((v, idx)=>`
      <div class="chat-poll-option-row">
        <input type="text" class="chat-poll-option-input" data-idx="${idx}" placeholder="خيار ${idx+1}" value="${escapeHtml(v)}">
        ${values.length > 2 ? `<button type="button" class="chat-icon-btn xs" data-chat-action="poll-remove-option" data-idx="${idx}" title="حذف">✕</button>` : ""}
      </div>`).join("");
  }

  function setPollType(type){
    pollType = type;
    document.querySelectorAll(".chat-poll-type-btn").forEach((b)=>b.classList.toggle("active", b.getAttribute("data-type")===type));
    renderPollOptionsUI(type === "multi" ? currentPollOptionValues() : []);
  }

  function addPollOptionRow(){
    if(pollType !== "multi") return;
    const values = currentPollOptionValues();
    if(values.length >= 20) return;
    values.push("");
    renderPollOptionsUI(values);
  }

  function removePollOptionRow(idx){
    if(pollType !== "multi") return;
    const values = currentPollOptionValues();
    if(values.length <= 2) return;
    values.splice(Number(idx), 1);
    renderPollOptionsUI(values);
  }

  async function submitCreatePoll(){
    const qEl = document.getElementById("chat-poll-question");
    const errEl = document.getElementById("chat-poll-error");
    const question = qEl ? qEl.value.trim() : "";
    if(!question){ if(errEl) errEl.innerHTML = `<div class="error-msg">يرجى كتابة سؤال الاستطلاع.</div>`; return; }

    let options;
    if(pollType === "yesno"){
      options = ["نعم", "لا"];
    }else{
      options = currentPollOptionValues().map((v)=>v.trim()).filter(Boolean);
      if(options.length < 2){ if(errEl) errEl.innerHTML = `<div class="error-msg">أضف خيارين على الأقل.</div>`; return; }
    }

    const expiresEl = document.getElementById("chat-poll-expires");
    let expiresAt = null;
    if(expiresEl && expiresEl.value){
      const d = new Date(expiresEl.value);
      if(!isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    const anonEl = document.getElementById("chat-poll-anonymous");
    const anonymous = !!(anonEl && anonEl.checked);

    try{
      const { message } = await api(`/chat/conversations/${ST.currentId}/polls`, { method:"POST", body:{ question, options, expiresAt, anonymous } });
      closeModal();
      appendOrUpdateMessage(message);
    }catch(e){ if(errEl) errEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
  }

  async function votePoll(messageId, optionId){
    if(!messageId || !optionId) return;
    try{
      const { message } = await api(`/chat/polls/${messageId}/vote`, { method:"POST", body:{ optionId } });
      updateMessageInPlace(message);
    }catch(e){ alert(e.message); }
  }

  function pollBubbleHtml(m){
    const poll = m.poll;
    // Server-computed and per-viewer already (see serializePoll in
    // routes/chat.js): totalVotes, votedByMe/myOptionId, and — only when the
    // poll isn't anonymous — each option's real voter list.
    const totalVotes = poll.totalVotes || 0;
    const closed = !!(poll.expiresAt && new Date(poll.expiresAt) <= new Date());
    const showResults = poll.votedByMe || closed;
    const canSeeVoters = !poll.anonymous;

    // Once results are visible, order options by vote count (most-voted
    // first) — same as the request asked for ("ترتيب الخيارات حسب عدد
    // الأصوات"). Before that, keep the original order so voting doesn't jump.
    const orderedOptions = showResults
      ? [...poll.options].sort((a,b)=> b.votesCount - a.votesCount)
      : poll.options;

    const optionsHtml = orderedOptions.map((opt)=>{
      const pct = totalVotes ? Math.round((opt.votesCount/totalVotes)*100) : 0;
      const mine = poll.myOptionId === opt.id;
      if(showResults){
        const clickable = canSeeVoters && opt.votesCount > 0;
        return `<div class="chat-poll-result${mine ? ' mine' : ''}${clickable ? ' clickable' : ''}"
            ${clickable ? `data-chat-action="poll-view-voters" data-msgid="${m.id}" data-optionid="${opt.id}" role="button" tabindex="0"` : ""}>
          <div class="chat-poll-result-top"><span>${escapeHtml(opt.text)}${mine ? ' ✓' : ''}</span><span>${pct}% (${opt.votesCount})</span></div>
          <div class="chat-poll-bar"><div class="chat-poll-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
      }
      return `<button type="button" class="chat-poll-option-btn" data-chat-action="poll-vote" data-msgid="${m.id}" data-optionid="${opt.id}">
        <span class="chat-poll-radio"></span><span>${escapeHtml(opt.text)}</span>
      </button>`;
    }).join("");

    const totalVotesLabel = (canSeeVoters && totalVotes > 0)
      ? `<span class="chat-poll-total clickable" data-chat-action="poll-view-all-voters" data-msgid="${m.id}" role="button" tabindex="0">${totalVotes} صوت 👁</span>`
      : `<span>${totalVotes} صوت</span>`;

    return `<div class="chat-poll">
      <div class="chat-poll-question">📊 ${escapeHtml(poll.question)}${poll.anonymous ? ' <span class="chat-poll-anon-badge" title="استطلاع سري — لا تظهر أسماء المصوّتين">🔒</span>' : ''}</div>
      <div class="chat-poll-options">${optionsHtml}</div>
      <div class="chat-poll-meta">
        ${totalVotesLabel}
        ${closed ? `<span class="chat-poll-closed">🔒 انتهى التصويت</span>` : (poll.expiresAt ? `<span>ينتهي: ${dayLabel(poll.expiresAt)} ${fmtChatTime(poll.expiresAt)}</span>` : "")}
      </div>
    </div>`;
  }

  // Voter-list modal — either a single option (click on that result row) or
  // the whole breakdown (click on the total votes count). Never called for
  // anonymous polls (those rows/labels aren't rendered as clickable at all).
  function openPollVotersModal(messageId, optionId){
    const msg = ST.messages.find(mm=>mm.id===messageId);
    if(!msg || !msg.poll || msg.poll.anonymous) return;
    const poll = msg.poll;
    const options = optionId ? poll.options.filter(o=>o.id===optionId) : [...poll.options].sort((a,b)=>b.votesCount-a.votesCount);
    const body = options.map((opt)=>`
      <div class="chat-poll-voters-group">
        <div class="chat-poll-voters-heading">${escapeHtml(opt.text)} <span class="muted">(${opt.votesCount})</span></div>
        ${opt.voters.length ? opt.voters.map((v)=>`
          <div class="chat-member-row">
            ${personAvatarHtml(v, "sm")}
            <span class="chat-member-name">${escapeHtml(v.fullNameAr)}</span>
          </div>`).join("") : `<div class="muted text-sm" style="padding:6px 4px;">لا يوجد مصوّتون بعد</div>`}
      </div>`).join("");
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>${optionId ? "المصوّتون على هذا الخيار" : "تفاصيل التصويت"}</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">${body}</div>
      </div>`);
  }

  /* ---------- message reactions ---------- */
  // One reaction per user per message (see POST /messages/:id/reactions):
  // adding a different emoji replaces your previous one, tapping the same
  // emoji again removes it. All three gestures below — double-tap, the
  // picker, and re-picking your own reaction — go through this one
  // function, so "add / change / remove" is always the exact same call.
  async function reactToMessage(messageId, emoji){
    try{
      const { message } = await api(`/chat/messages/${messageId}/reactions`, { method:"POST", body:{ emoji } });
      updateMessageInPlace(message);
    }catch(e){ showChatToast(e.message || "تعذّر تسجيل التفاعل"); }
  }
  function quickReactHeart(messageId){
    const m = ST.messages.find(x=>x.id===messageId);
    if(!m || m.deletedAt) return;
    reactToMessage(messageId, QUICK_REACTION);
  }
  // Fetched once per page load and cached — the picker's emoji list comes
  // from the server (see GET /chat/reactions) so adding a new reaction in
  // the future never needs a frontend change, only the server's REACTIONS
  // array. Falls back to a local mirror if the request fails.
  async function ensureReactionCatalog(){
    if(ST.reactionCatalog) return ST.reactionCatalog;
    try{
      const { reactions } = await api("/chat/reactions");
      ST.reactionCatalog = Array.isArray(reactions) && reactions.length ? reactions : FALLBACK_REACTIONS;
    }catch(e){
      ST.reactionCatalog = FALLBACK_REACTIONS;
    }
    return ST.reactionCatalog;
  }
  function reactionsBarHtml(m){
    if(!m.reactions || !m.reactions.length) return "";
    return `<div class="chat-msg-reactions" data-chat-action="react-view" data-id="${m.id}" role="button" tabindex="0" title="عرض من تفاعل">
      ${m.reactions.map(r=>`<span class="chat-reaction-pill${r.mine ? ' mine' : ''}">${r.emoji}<span class="chat-reaction-count">${r.count}</span></span>`).join("")}
    </div>`;
  }
  function reactionPickerHtml(m){
    const catalog = ST.reactionCatalog || FALLBACK_REACTIONS;
    const mine = (m.reactions||[]).find(r=>r.mine);
    return `<div class="chat-dropdown chat-reaction-picker" id="chat-reaction-picker-${m.id}" style="display:none;">
      ${catalog.map(e=>`<button type="button" class="chat-reaction-pick-btn${mine && mine.emoji===e ? ' active' : ''}" data-chat-action="react-pick" data-id="${m.id}" data-emoji="${e}" title="${mine && mine.emoji===e ? 'إزالة التفاعل' : e}">${e}</button>`).join("")}
    </div>`;
  }
  async function openReactionPicker(messageId){
    await ensureReactionCatalog();
    const wrap = document.getElementById(`chat-reaction-wrap-${messageId}`);
    const picker = document.getElementById(`chat-reaction-picker-${messageId}`);
    if(!picker) return;
    // Rebuild in case the catalog just finished loading, or the caller's own
    // current reaction changed since this bubble was last rendered.
    const m = ST.messages.find(x=>x.id===messageId);
    if(m && wrap) picker.outerHTML = reactionPickerHtml(m);
    toggleDropdown(`chat-reaction-picker-${messageId}`);
  }
  function pickReaction(messageId, emoji){
    closeAllDropdowns();
    reactToMessage(messageId, emoji);
  }
  // "من تفاعل" modal — grouped by emoji, same layout as the poll voters
  // modal (openPollVotersModal) so the two feel like one consistent pattern
  // rather than two different components.
  function openReactionsModal(messageId){
    const msg = ST.messages.find(mm=>mm.id===messageId);
    if(!msg || !msg.reactions || !msg.reactions.length) return;
    const body = msg.reactions.map((r)=>`
      <div class="chat-poll-voters-group">
        <div class="chat-poll-voters-heading">${r.emoji} <span class="muted">(${r.count})</span></div>
        ${r.users.map((u)=>`
          <div class="chat-member-row">
            ${personAvatarHtml(u, "sm")}
            <span class="chat-member-name">${escapeHtml(u.fullNameAr)}</span>
          </div>`).join("")}
      </div>`).join("");
    openModal(`
      <div class="chat-modal">
        <div class="chat-modal-head"><h3>التفاعلات</h3><button type="button" class="chat-icon-btn" data-chat-action="modal-close">✕</button></div>
        <div class="chat-modal-body">${body}</div>
      </div>`);
  }

  async function clearConversationConfirm(){
    if(!confirm("هل تريد مسح كل رسائل هذه المحادثة؟ لا يمكن التراجع عن هذا الإجراء.")) return;
    try{ await api(`/chat/conversations/${ST.currentId}/clear`, { method:"POST" }); closeModal(); }catch(e){ alert(e.message); }
  }
  async function deleteConversationConfirm(){
    if(!confirm("هل تريد حذف هذه المجموعة نهائيًا؟ سيتم حذف كل الرسائل والأعضاء ولا يمكن التراجع عن هذا الإجراء.")) return;
    try{ await api(`/chat/groups/${ST.currentId}`, { method:"DELETE" }); closeModal(); }catch(e){ alert(e.message); }
  }
  async function deleteForMeConfirm(){
    if(!confirm("هل تريد حذف هذه المحادثة من قائمتك؟ ستختفي من قائمتك فقط دون التأثير على بقية المشاركين.")) return;
    try{ await api(`/chat/conversations/${ST.currentId}`, { method:"DELETE" }); closeModal(); }catch(e){ alert(e.message); }
  }
  async function leaveGroupConfirm(){
    if(!confirm("هل تريد مغادرة هذه المجموعة؟")) return;
    try{ await api(`/chat/groups/${ST.currentId}/leave`, { method:"POST" }); closeModal(); }catch(e){ alert(e.message); }
  }

  /* ---------- shell-level delegated events ---------- */
  function onShellClick(e){
    if(suppressNextClick){ suppressNextClick = false; return; }
    const actionEl = e.target.closest("[data-chat-action]");
    const action0 = actionEl ? actionEl.getAttribute("data-chat-action") : null;
    const isToggle = action0 && /menu-toggle|plus-toggle|react-toggle/.test(action0);
    if(!isToggle) document.querySelectorAll(".chat-dropdown").forEach((d)=>d.style.display = "none");
    // The emoji panel isn't a .chat-dropdown (picking an emoji shouldn't close
    // it, so multiple emojis can be added to one message) — close it only on
    // a genuine outside click.
    if(!e.target.closest("#chat-emoji-panel") && action0 !== "emoji-toggle"){
      const panel = document.getElementById("chat-emoji-panel");
      if(panel) panel.style.display = "none";
    }
    if(!actionEl) return;
    const action = actionEl.getAttribute("data-chat-action");
    const id = actionEl.getAttribute("data-id");
    switch(action){
      case "select-conv":
        selectConversation(id);
        break;
      case "back-to-list": document.getElementById("chat-shell")?.classList.remove("show-main"); break;
      case "toggle-menu": toggleDropdown("chat-menu-dropdown"); break;
      case "open-newgroup": closeAllDropdowns(); newGroupDraft = { name: "", memberIds: [], photoBlob: null, photoPreviewUrl: null }; openNewGroupModal(); break;
      case "open-referees": closeAllDropdowns(); openRefereesModal(); break;
      case "referee-pick": startPrivateChatWithReferee(id); break;
      case "newgroup-submit": submitNewGroup(); break;
      case "header-menu-toggle": toggleDropdown("chat-header-dropdown"); break;
      case "open-groupinfo": closeAllDropdowns(); openGroupInfoModal(); break;
      case "open-addmembers": openAddMembersModal(); break;
      case "add-members-submit": submitAddMembers(); break;
      case "remove-member": removeMemberConfirm(id); break;
      case "rename-submit": submitRename(); break;
      case "clear-conv": clearConversationConfirm(); break;
      case "delete-conv": deleteConversationConfirm(); break;
      case "leave-group": leaveGroupConfirm(); break;
      case "delete-for-me": deleteForMeConfirm(); break;
      case "modal-close": closeModal(); break;
      case "crop-confirm": confirmCrop(); break;
      case "crop-cancel": cancelCrop(); break;
      case "pick-group-photo": pickNewGroupPhoto(); break;
      case "remove-group-photo-draft": newGroupDraft.photoBlob = null; newGroupDraft.photoPreviewUrl = null; openNewGroupModal(); break;
      case "change-group-photo": changeExistingGroupPhoto(); break;
      case "remove-group-photo": removeExistingGroupPhoto(); break;
      case "composer-plus-toggle": toggleDropdown("chat-composer-plus-dropdown"); break;
      case "attach-btn": closeAllDropdowns(); document.getElementById("chat-file-input")?.click(); break;
      case "attach-remove": ST.pendingAttachment = null; renderAttachPreview(); break;
      case "emoji-toggle": toggleEmojiPanel(); break;
      case "emoji-cat": switchEmojiCategory(actionEl.getAttribute("data-cat")); break;
      case "emoji-pick": insertEmoji(actionEl.getAttribute("data-emoji")); break;
      case "open-create-poll": closeAllDropdowns(); openCreatePollModal(); break;
      case "poll-type": setPollType(actionEl.getAttribute("data-type")); break;
      case "poll-add-option": addPollOptionRow(); break;
      case "poll-remove-option": removePollOptionRow(actionEl.getAttribute("data-idx")); break;
      case "poll-submit": submitCreatePoll(); break;
      case "poll-vote": votePoll(actionEl.getAttribute("data-msgid"), actionEl.getAttribute("data-optionid")); break;
      case "poll-view-voters": openPollVotersModal(actionEl.getAttribute("data-msgid"), actionEl.getAttribute("data-optionid")); break;
      case "poll-view-all-voters": openPollVotersModal(actionEl.getAttribute("data-msgid"), null); break;
      case "send": sendMessage(); break;
      case "msg-menu-toggle": toggleMsgMenu(id); break;
      case "msg-copy": copyMessageText(id); break;
      case "msg-edit": startEditMessage(id); break;
      case "msg-edit-save": saveEditMessage(id); break;
      case "msg-edit-cancel": renderMessages(); break;
      case "msg-delete": deleteMessage(id); break;
      case "msg-react-toggle": openReactionPicker(id); break;
      case "react-pick": pickReaction(id, actionEl.getAttribute("data-emoji")); break;
      case "react-view": openReactionsModal(id); break;
      case "zoom": openDocLightbox(actionEl.getAttribute("data-url"), actionEl.getAttribute("data-mime"), actionEl.getAttribute("data-title")); break;
    }
  }
  function closeAllDropdowns(){ document.querySelectorAll(".chat-dropdown").forEach((d)=>d.style.display = "none"); }

  function onShellInput(e){
    if(e.target.id === "chat-search-input"){ ST.searchQuery = e.target.value; renderSidebar(); }
    else if(e.target.id === "chat-text-input"){ autoGrow(e.target); pingTyping(); }
    else if(e.target.id === "chat-newgroup-search"){ filterPickerRows("chat-newgroup-list", e.target.value); }
    else if(e.target.id === "chat-addmembers-search"){ filterPickerRows("chat-addmembers-list", e.target.value); }
    else if(e.target.id === "chat-referees-search"){ filterPickerRows("chat-referees-list", e.target.value); }
    else if(e.target.id === "chat-emoji-search"){ emojiQuery = e.target.value; renderEmojiGrid(); }
  }
  function onShellKeydown(e){
    if(e.target.id === "chat-text-input" && e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      sendMessage();
    }
  }
  function onShellChange(e){
    if(e.target.id === "chat-file-input"){
      const file = e.target.files[0];
      if(file) stageAttachment(file);
      e.target.value = "";
    }
  }
  function onDragOver(e){ if(!ST.currentId) return; e.preventDefault(); document.querySelector(".chat-drop-overlay")?.classList.add("active"); }
  function onDragLeave(){ document.querySelector(".chat-drop-overlay")?.classList.remove("active"); }
  function onDrop(e){
    if(!ST.currentId) return;
    e.preventDefault();
    document.querySelector(".chat-drop-overlay")?.classList.remove("active");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if(file) stageAttachment(file);
  }

  /* ---------- double-tap-to-react / long-press-for-picker ----------
     Double-click (desktop mouse, and most mobile browsers also fire this on
     a fast double-tap) reacts with the default ❤️, toggling it off if it's
     already the caller's reaction — same as WhatsApp/Telegram. Long-press
     (touch only; desktop already has the always-reachable 🙂+ button) opens
     the full picker instead, so a slow deliberate press never fires the
     quick heart by accident. */
  function onShellDblClick(e){
    const bubble = e.target.closest(".chat-bubble[data-id]");
    if(!bubble) return;
    if(e.target.closest("[data-chat-action]")) return; // let poll votes, ⋮-menu, etc. behave normally
    e.preventDefault();
    quickReactHeart(bubble.getAttribute("data-id"));
  }
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 10;
  let longPressTimer = null;
  let longPressStart = null;
  // Set right before openReactionPicker() fires from a long-press. Lifting
  // the finger afterwards fires a synthetic "click" on the bubble (no
  // data-chat-action), which onShellClick's outside-click logic would
  // otherwise treat as "click outside" and immediately close the picker we
  // just opened — the picker would flash open for a frame and vanish, which
  // is exactly what "doesn't appear on phone" looks like. This eats that one
  // synthetic click and nothing else.
  let suppressNextClick = false;
  function clearLongPress(){
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressStart = null;
  }
  function onBubbleTouchStart(e){
    const bubble = e.target.closest(".chat-bubble[data-id]");
    if(!bubble || e.touches.length !== 1) return;
    const touch = e.touches[0];
    longPressStart = { x: touch.clientX, y: touch.clientY, id: bubble.getAttribute("data-id") };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(()=>{
      if(!longPressStart) return;
      if(navigator.vibrate) try{ navigator.vibrate(15); }catch(e){}
      openReactionPicker(longPressStart.id);
      suppressNextClick = true;
      setTimeout(()=>{ suppressNextClick = false; }, 400); // safety net in case no synthetic click ever arrives
      longPressStart = null;
    }, LONG_PRESS_MS);
  }
  function onBubbleTouchMove(e){
    if(!longPressStart || !e.touches.length) return;
    const touch = e.touches[0];
    if(Math.abs(touch.clientX - longPressStart.x) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(touch.clientY - longPressStart.y) > LONG_PRESS_MOVE_TOLERANCE){
      clearLongPress();
    }
  }
  // Android (and some touch-laptops) pop their own text-selection/context
  // menu on a long-press, which visually wins over — and can silently cancel
  // — our custom picker. Suppressing it only over message bubbles doesn't
  // touch anything else on the page (links, inputs, etc. keep their normal
  // context menu).
  function onBubbleContextMenu(e){
    if(e.target.closest(".chat-bubble[data-id]")) e.preventDefault();
  }
  // See the html.is-touch-device rule in chat.css — a real capability check,
  // used alongside (not instead of) the `hover:none` media query, since
  // neither signal alone is reliable across every real device out there.
  function markTouchDeviceIfNeeded(){
    if(("ontouchstart" in window) || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0){
      document.documentElement.classList.add("is-touch-device");
    }
  }

  /* ---------- page shell / mount ---------- */
  function shellHtml(session){
    const isAdmin = session.user.role === "admin";
    // A pending referee's only chat capability is the admin DM (opened
    // automatically in mount() below) — starting a group or a chat with
    // another referee is blocked server-side too (see requireActiveAccount
    // in routes/chat.js), so the menu that offers those actions is hidden
    // entirely rather than shown and then failing.
    const canStartNewChats = isAdmin || session.user.accountStatus === "active";
    return `
    <div class="chat-page">
      <div class="chat-shell" id="chat-shell">
        <aside class="chat-sidebar" id="chat-sidebar">
          <div class="chat-sidebar-head">
            <h3>الدردشة <span id="chat-conn-status" class="chat-conn-dot connecting" title="جارٍ الاتصال بالخادم..."></span></h3>
            ${canStartNewChats ? `
            <div class="chat-menu-wrap">
              <button type="button" class="chat-icon-btn" data-chat-action="toggle-menu" title="خيارات">➕</button>
              <div class="chat-dropdown chat-dropdown-left" id="chat-menu-dropdown" style="display:none;">
                <button type="button" data-chat-action="open-newgroup">👥 مجموعة جديدة</button>
                ${isAdmin ? `<button type="button" data-chat-action="open-referees">💬 بدء محادثة مع حكم</button>` : `<button type="button" data-chat-action="open-referees">💬 محادثة جديدة</button>`}
              </div>
            </div>` : ""}
          </div>
          <div class="chat-search"><input type="text" id="chat-search-input" placeholder="🔍 بحث في المحادثات..."></div>
          <div class="chat-conv-list" id="chat-conv-list"><div class="muted text-sm" style="padding:16px;">جارِ التحميل...</div></div>
        </aside>
        <section class="chat-main" id="chat-main">
          <div class="chat-placeholder"><div class="icon">💬</div><h3>اختر محادثة</h3><p class="muted">اختر محادثة من القائمة أو ابدأ محادثة جديدة</p></div>
        </section>
        <div id="chat-modal-root"></div>
      </div>
    </div>`;
  }

  /* Keeps the chat shell's height pinned to the *actual* visible viewport
     (not just 100dvh) on phones. 100dvh already tracks the on-screen
     keyboard correctly in most current mobile browsers, but a few
     WebView/Samsung Internet/older Firefox Mobile builds treat the keyboard
     as an overlay instead of shrinking the viewport, which would otherwise
     leave the composer hidden behind it. The Visual Viewport API reports the
     real visible height directly, so we mirror it into --app-vh (see
     chat.css) as a precise override wherever it's available; browsers
     without it simply keep using the 100dvh fallback. */
  function onVisualViewportResize(){
    if(!window.visualViewport) return;
    document.documentElement.style.setProperty("--app-vh", window.visualViewport.height + "px");
  }

  async function mount(session, routeParam){
    ST.session = session;
    ST.mounted = true;
    ST.searchQuery = "";
    // See chat.css: this stops the *document* from scrolling while the chat
    // page is open, which is what was letting the composer get dragged off
    // the bottom of the screen once a conversation filled up with messages.
    document.documentElement.classList.add("chat-locked");
    document.body.classList.add("chat-locked");
    if(window.visualViewport){
      onVisualViewportResize();
      window.visualViewport.addEventListener("resize", onVisualViewportResize);
    }
    const shell = document.getElementById("chat-shell");
    if(shell && !shell._chatWired){
      shell.addEventListener("click", onShellClick);
      shell.addEventListener("input", onShellInput);
      shell.addEventListener("keydown", onShellKeydown);
      shell.addEventListener("change", onShellChange);
      shell.addEventListener("dragover", onDragOver);
      shell.addEventListener("dragleave", onDragLeave);
      shell.addEventListener("drop", onDrop);
      shell.addEventListener("dblclick", onShellDblClick);
      shell.addEventListener("touchstart", onBubbleTouchStart, { passive: true });
      shell.addEventListener("touchmove", onBubbleTouchMove, { passive: true });
      shell.addEventListener("touchend", clearLongPress);
      shell.addEventListener("touchcancel", clearLongPress);
      shell.addEventListener("contextmenu", onBubbleContextMenu);
      shell._chatWired = true;
    }
    markTouchDeviceIfNeeded();
    ensureConnected(session);
    setConnStatus(ST.ws && ST.ws.readyState === WebSocket.OPEN ? "connected" : ST.connStatus || "connecting");
    ackDelivered();
    ensureReactionCatalog();
    await loadConversations();

    if(routeParam && routeParam.indexOf("private-") === 0 && (session.user.role === "admin" || session.user.role === "referee")){
      const otherUserId = routeParam.slice("private-".length);
      try{
        const { conversation } = await api(`/chat/private/${otherUserId}`, { method:"POST" });
        await loadConversations();
        selectConversation(conversation.id);
        return;
      }catch(e){ /* fall through to default selection below */ }
    }

    if(session.user.role === "referee"){
      try{
        const { conversation } = session.user.accountStatus !== "active"
          ? await api("/chat/get-or-create-admin-chat")
          : await api("/chat/private", { method:"POST" });
        if(!ST.conversations.find(c=>c.id===conversation.id)) await loadConversations();
        if(session.user.accountStatus !== "active"){ selectConversation(conversation.id); return; }
      }catch(e){}
    }

    // Merely landing on the chat page must never silently mark a
    // conversation "read" or (on mobile) jump straight into it — the user
    // has to actually tap a conversation for either of those to happen.
    // WhatsApp/Telegram's mobile apps always open to the conversation list
    // for the same reason. On desktop both panes are already visible
    // side-by-side (nothing is hidden from the user, and nothing disappears
    // off-screen), so resuming the last-open conversation there is fine —
    // it's the same "already visible" experience WhatsApp/Telegram Web give.
    const isMobileLayout = window.innerWidth <= 860;
    if(isMobileLayout){
      ST.currentId = null;
      ST.currentConv = null;
      document.getElementById("chat-shell")?.classList.remove("show-main");
      renderSidebar();
      showPlaceholder();
      return;
    }

    if(ST.currentId && ST.conversations.find(c=>c.id===ST.currentId)) selectConversation(ST.currentId);
    else if(ST.conversations.length) selectConversation(ST.conversations[0].id);
    else showPlaceholder();
  }

  function beforeRouteChange(){
    ST.mounted = false;
    document.documentElement.classList.remove("chat-locked");
    document.body.classList.remove("chat-locked");
    if(window.visualViewport) window.visualViewport.removeEventListener("resize", onVisualViewportResize);
    document.documentElement.style.removeProperty("--app-vh");
  }

  window.LWFChat = { shellHtml, mount, beforeRouteChange, ensureConnected, disconnect, refreshBadge };
})();
