// presence.js — "Last Seen" / "Online now" policy layer.
//
// realtime.js only knows how to reach a socket and reports raw connect/
// disconnect *transitions* (first device online / last device offline —
// already de-duplicated there across multiple open tabs/devices for the
// same user). This module decides what a transition actually means:
// persist lastSeenAt when a user goes offline, and tell the right people
// about it. Kept separate from realtime.js on purpose, the same way
// routes/chat.js (not realtime.js) decides what to broadcast for messages —
// realtime.js stays a dumb registry either way.

const db = require("./db");
const realtime = require("./realtime");
const { nowIso, contactsOf } = require("./chatCore");

async function broadcastPresence(userId, online, lastSeenAt) {
  const data = await db.getAll();
  const contacts = contactsOf(data, userId);
  if (!contacts.length) return;
  realtime.sendToUsers(contacts, "presence:update", { userId, online, lastSeenAt: online ? null : lastSeenAt });
}

// Called once per user when their *first* device connects (see server.js) —
// not once per socket, so opening a second tab never re-announces "online".
async function handleUserOnline(userId) {
  try {
    await broadcastPresence(userId, true, null);
  } catch (e) {
    console.error("presence: handleUserOnline failed", e);
  }
}

// Called once per user when their *last* device disconnects — covers a
// normal logout, closing the browser/app, and (via the heartbeat in
// server.js) a connection that died without a clean close at all (phone
// battery dying, a sudden power/network outage). Whichever of those it was,
// the moment recorded here is the honest last-seen instant.
async function handleUserOffline(userId) {
  try {
    const iso = nowIso();
    await db.updateUserById(userId, { lastSeenAt: iso });
    await broadcastPresence(userId, false, iso);
  } catch (e) {
    console.error("presence: handleUserOffline failed", e);
  }
}

module.exports = { handleUserOnline, handleUserOffline };
