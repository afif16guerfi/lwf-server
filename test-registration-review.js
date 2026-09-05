// Standalone functional test for the account activation review cycle
// (registration -> pending_review -> accept|needs_edit|reject -> resubmit
// -> pending_review -> accept). Runs the REAL route handlers over real
// HTTP, with only the Mongo-backed db.js module swapped for an in-memory
// stand-in (same getAll/saveAll interface), since this sandbox has no
// MongoDB access. Everything else (schema.js, auditCore.js, notificationsCore.js,
// middleware/auth.js, routes/auth.js, routes/admin.js) runs unmodified.

const path = require("path");
const http = require("http");
const express = require("express");

// ---- In-memory db.js stand-in, injected into Node's module cache BEFORE
// anything else requires "../db", so every route gets this instance. ----
const dbPath = require.resolve("./db");
let STATE = {
  users: [], applications: [], requests: [], conversations: [], conversationMembers: [], messages: [], announcements: [],
  notifications: [], refereeLists: [], settings: {}, documentRequirements: [], auditLog: [],
};
const mockDb = {
  async getAll() { return STATE; },
  async saveAll(data) { STATE = data; return true; },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// settingsCore.isRegistrationOpen / isSiteEnabled need a shape — patch minimal defaults directly on STATE.settings
const { DEFAULT_SETTINGS } = require("./settingsCore");
STATE.settings = { ...DEFAULT_SETTINGS };

const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app;
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ method, path, host: "127.0.0.1", port: PORT, headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let PORT;
let server;

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  \u2713 " + msg);
}

async function main() {
  server = app.listen(0);
  PORT = server.address().port;

  // Seed an admin account directly in-memory (bypassing signup, since signup only creates referees).
  const bcrypt = require("bcryptjs");
  const { v4: uuidv4 } = require("uuid");
  STATE.users.push({
    id: uuidv4(), role: "admin", username: "admin", email: "admin@lwf.dz", phone: "0555000000",
    fullNameAr: "الإدارة", fullNameLatin: "Admin", password: await bcrypt.hash("Admin@123", 10),
    accountStatus: "active", createdAt: new Date().toISOString(),
  });

  console.log("\n== 1) Referee signs up ==");
  let res = await request("POST", "/api/auth/signup", { body: {
    fullNameAr: "احمد محمد", fullNameLatin: "Ahmed Mohamed", username: "ahmed01", email: "ahmed@example.com", phone: "0551234567", password: "pass1234",
  } });
  assert(res.status === 200, "signup succeeds (200)");
  assert(res.body.user.accountStatus === "pending", "new account starts in accountStatus=pending (pending_review)");
  const refereeToken = res.body.token;
  const refereeId = res.body.user.id;

  console.log("\n== Admin logs in ==");
  res = await request("POST", "/api/auth/login", { body: { username: "admin", password: "Admin@123" } });
  assert(res.status === 200, "admin login succeeds");
  const adminToken = res.body.token;

  console.log("\n== 2) Referee is blocked from protected actions while pending_review (backend enforcement) ==");
  res = await request("PUT", "/api/auth/registration", { token: refereeToken, body: { fields: { fullNameAr: "x" } } });
  assert(res.status === 400, "PUT /auth/registration refused while pending_review (not needs_edit yet)");

  console.log("\n== 3) Admin sees it in the review queue ==");
  res = await request("GET", "/api/admin/users", { token: adminToken });
  const listed = res.body.users.find((u) => u.id === refereeId);
  assert(!!listed, "referee appears in admin users list");
  assert(listed.accountStatus === "pending", "listed with accountStatus=pending");
  assert(listed.awaitingReview === true, "flagged awaitingReview=true");

  console.log("\n== 4) Admin requests an edit on the name (🔵) ==");
  res = await request("POST", `/api/admin/users/${refereeId}/request-edit`, { token: adminToken, body: {
    fields: ["fullNameAr"], note: "يرجى تصحيح الاسم واللقب حسب بطاقة التعريف.",
  } });
  assert(res.status === 200, "request-edit succeeds");
  assert(res.body.accountStatus === "needs_edit", "account moves to needs_edit");

  console.log("\n== 5) Referee sees the note + flagged field only ==");
  res = await request("GET", "/api/auth/registration-status", { token: refereeToken });
  assert(res.body.accountStatus === "needs_edit", "referee sees needs_edit");
  assert(res.body.reviewFields.length === 1 && res.body.reviewFields[0] === "fullNameAr", "only fullNameAr flagged");
  assert(res.body.reviewNote.includes("بطاقة التعريف"), "admin note is visible to the referee");

  console.log("\n== 6) Referee is still blocked from the full app while needs_edit ==");
  res = await request("GET", "/api/admin/users", { token: refereeToken });
  assert(res.status === 403, "referee can't call admin-only routes (unrelated check, sanity)");

  console.log("\n== 7) Referee corrects the field (does NOT auto-resubmit) ==");
  res = await request("PUT", "/api/auth/registration", { token: refereeToken, body: { fields: { fullNameAr: "محمد أحمد" } } });
  assert(res.status === 200, "field update accepted while needs_edit");
  assert(res.body.user.accountStatus === "needs_edit", "status stays needs_edit until explicit resubmit");
  assert(res.body.user.fullNameAr === "محمد أحمد", "user.fullNameAr updated (single source of truth, mirrored immediately)");

  console.log("\n== 8) Referee explicitly resubmits ==");
  res = await request("POST", "/api/auth/registration/resubmit", { token: refereeToken });
  assert(res.status === 200, "resubmit succeeds");
  assert(res.body.user.accountStatus === "pending", "back to pending_review (same account, same registration)");

  console.log("\n== 9) No duplicate account/application was created ==");
  assert(STATE.users.filter((u) => u.role === "referee").length === 1, "still exactly one referee account");
  assert(STATE.applications.length === 1, "still exactly one application record");

  console.log("\n== 10) Admin re-reviews and accepts (🟢) ==");
  res = await request("GET", `/api/admin/users/${refereeId}/registration-history`, { token: adminToken });
  assert(res.body.registrationHistory.length >= 3, "registration history recorded: created, needs_edit request, resubmit");
  res = await request("POST", `/api/admin/users/${refereeId}/accept`, { token: adminToken });
  assert(res.status === 200, "accept succeeds");
  assert(res.body.accountStatus === "active", "account is now active");

  console.log("\n== 11) Referee now sees fullNameAr synced everywhere (single source of truth) ==");
  res = await request("GET", "/api/auth/me", { token: refereeToken });
  assert(res.body.user.accountStatus === "active", "referee's own /auth/me reflects active status");
  assert(res.body.user.fullNameAr === "محمد أحمد", "corrected name is what's now shown (no stale copy)");

  console.log("\n== 12) Backend enforcement: can't bypass by calling the API directly ==");
  res = await request("PUT", "/api/auth/registration", { token: refereeToken, body: { fields: { fullNameAr: "hack" } } });
  assert(res.status === 400, "PUT /auth/registration refused once active (not needs_edit)");

  console.log("\n== 13) Second referee: full reject cycle (🔴) ==");
  res = await request("POST", "/api/auth/signup", { body: {
    fullNameAr: "سارة علي", fullNameLatin: "Sara Ali", username: "sara01", email: "sara@example.com", phone: "0559876543", password: "pass1234",
  } });
  const sara = res.body.user.id;
  const saraToken = res.body.token;
  res = await request("POST", `/api/admin/users/${sara}/reject`, { token: adminToken, body: {} });
  assert(res.status === 400, "reject refused without a reason (mandatory)");
  res = await request("POST", `/api/admin/users/${sara}/reject`, { token: adminToken, body: { reason: "المعلومات غير مطابقة للوثائق الرسمية." } });
  assert(res.status === 200, "reject with reason succeeds");
  assert(res.body.accountStatus === "rejected", "account is rejected");

  res = await request("GET", "/api/auth/registration-status", { token: saraToken });
  assert(res.body.accountStatus === "rejected", "referee sees rejected status");
  assert(res.body.rejectionReason.includes("مطابقة"), "referee sees the rejection reason");

  console.log("\n== 14) Rejected account stays blocked from active-only routes ==");
  res = await request("PUT", "/api/auth/registration", { token: saraToken, body: { fields: { fullNameAr: "x" } } });
  assert(res.status === 400, "PUT /auth/registration refused while rejected");

  console.log("\n== 15) Admin reopens the rejected account, then accepts it ==");
  res = await request("POST", `/api/admin/users/${sara}/reopen`, { token: adminToken });
  assert(res.status === 200 && res.body.accountStatus === "pending", "reopen returns to pending_review");
  res = await request("POST", `/api/admin/users/${sara}/accept`, { token: adminToken });
  assert(res.status === 200 && res.body.accountStatus === "active", "accept after reopen succeeds");

  console.log("\n== 16) Audit log captured the referee's self-correction ==");
  res = await request("GET", "/api/admin/audit-log", { token: adminToken });
  const entry = res.body.entries.find((e) => e.userId === refereeId && e.field === "fullNameAr");
  assert(!!entry && entry.oldValue === "احمد محمد" && entry.newValue === "محمد أحمد", "audit log has the exact old->new name change");
  assert(entry.source === "self_edit" && entry.changedBy === "referee", "correctly attributed to the referee's self-correction");

  console.log("\n\u2705 ALL SCENARIOS PASSED\n");
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  if (server) server.close();
  process.exit(1);
});
