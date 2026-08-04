// realtime.js — in-process WebSocket registry for chat live-updates.
//
// Keyed by userId -> Set of open sockets (a user may have several tabs/devices
// open at once). Kept deliberately tiny: routes/chat.js decides *what* to
// broadcast and *to whom*; this module only knows how to reach a socket.
//
// register/unregister also report whether this call was a genuine PRESENCE
// transition (first device connecting / last device disconnecting) — a user
// with 2 open tabs closing 1 is not a transition, so presence.js only ever
// touches the database or broadcasts "went offline" on the one call where
// the Set actually became empty. This is what makes "دعم تعدد الأجهزة"
// (multi-device: stay online until *every* device has disconnected) correct
// for free, without presence.js needing to know anything about sockets.

const clients = new Map();

function register(userId, ws) {
  const hadAny = clients.has(userId) && clients.get(userId).size > 0;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
  return { becameOnline: !hadAny };
}

function unregister(userId, ws) {
  const set = clients.get(userId);
  if (!set || !set.has(ws)) return { becameOffline: false };
  set.delete(ws);
  const becameOffline = set.size === 0;
  if (becameOffline) clients.delete(userId);
  return { becameOffline };
}

function isOnline(userId) {
  return clients.has(userId);
}

function sendToUser(userId, event, payload) {
  const set = clients.get(userId);
  if (!set) return;
  const msg = JSON.stringify({ event, payload });
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function sendToUsers(userIds, event, payload, excludeUserId) {
  const seen = new Set();
  userIds.forEach((id) => {
    if (id === excludeUserId || seen.has(id)) return;
    seen.add(id);
    sendToUser(id, event, payload);
  });
}

module.exports = { register, unregister, isOnline, sendToUser, sendToUsers };
