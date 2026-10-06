// Actual-server task checks with isolated Telegram/database fixtures.
// No credential, network request, real claim, or balance mutation is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, timingSafeEqual } = require("node:crypto");
const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, "../server.js"), "utf8")
  .replace(/^import[^\r\n]*(?:\r?\n|$)/gm, "");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({ members = [{ status: "member" }], admin = "administrator", claimed = false,
  botToken = "isolated-bot", rpcCode = null, loseClaimResponse = false, channel = "@Lordeuso" } = {}) {
  const routes = new Map();
  const state = { balance: 15, claimed, memberCalls: 0, telegramCalls: [], databaseCalls: [], waits: [], timeouts: [], logs: [], credits: 0 };
  const app = { use() {}, get() {}, post(route, handler) { routes.set(route, handler); }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body) });
  const context = vm.createContext({
    express, cors: () => () => {}, sharp: () => { throw new Error("Unused sharp stub"); },
    Buffer, URL, URLSearchParams, createHmac, timingSafeEqual,
    AbortSignal: { timeout(ms) { state.timeouts.push(ms); return { isolated: true }; } },
    setTimeout(callback, delay) { state.waits.push(delay); callback(); },
    console: { log() {}, warn() {}, error(...items) { state.logs.push(items.join(" ")); } },
    process: { env: { BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: "isolated-secret",
      SUPABASE_URL: "https://database.test", SUPABASE_KEY: "isolated-service-key", CHANNEL_TASK_CHAT: channel } },
    fetch: async (urlValue, options = {}) => {
      const url = new URL(urlValue);
      if (url.hostname === "api.telegram.org") {
        const method = url.pathname.split("/").at(-1);
        const user = Number(url.searchParams.get("user_id"));
        state.telegramCalls.push({ method, user });
        assert.ok(options.signal, "all membership requests must have a timeout signal");
        if (method === "getMe") return response({ ok: true, result: { id: 777, is_bot: true } });
        assert.equal(method, "getChatMember");
        if (user === 777) return response({ ok: true, result: { user: { id: 777 }, status: admin } });
        const entry = members[Math.min(state.memberCalls++, members.length - 1)];
        if (entry.network) throw new Error("SECRET_TOKEN should never appear in diagnostics");
        if (entry.error_code) return response({ ok: false, ...entry,
          parameters: { retry_after: entry.retryAfter } }, entry.error_code);
        return response({ ok: true, result: { user: { id: entry.userId ?? 42 }, ...entry } });
      }
      assert.equal(url.hostname, "database.test");
      const body = options.body ? JSON.parse(options.body) : null;
      state.databaseCalls.push({ path: url.pathname, method: options.method || "GET", body });
      if (url.pathname.endsWith("/promo_redemptions") && !options.method) {
        return response(state.claimed ? [{ code: "__task_channel_lordeuso" }] : []);
      }
      if (url.pathname.endsWith("/rpc/account_claim_channel_task")) {
        assert.deepEqual(body, { p_user_id: 42 });
        if (rpcCode) return response({ applied: false, alreadyClaimed: false, claimed: false, code: rpcCode, balance: state.balance, reward: 10 });
        if (state.claimed) return response({ applied: false, alreadyClaimed: true, claimed: true, balance: state.balance, reward: 10 });
        state.claimed = true; state.balance += 10; state.credits++;
        if (loseClaimResponse) throw new Error("Isolated lost database response after commit");
        return response({ applied: true, alreadyClaimed: false, claimed: true, balance: state.balance, reward: 10 });
      }
      throw new Error(`Unexpected fixture database endpoint ${url.pathname}`);
    },
  });
  vm.runInContext(source, context, { filename: "channel-task-server-fixture.js" });
  context.extractUserId = () => 42;
  async function request(route, body = {}) {
    const result = { status: 200 };
    const res = { status(code) { result.status = code; return this; }, json(value) { result.body = plain(value); return this; } };
    await routes.get(route)({ body }, res);
    return result;
  }
  return { state, context, request,
    status: () => request("/api/tasks/channel/status"), claim: () => request("/api/tasks/channel/claim") };
}

async function run() {
  for (const member of [{ status: "creator" }, { status: "administrator" }, { status: "member" }, { status: "restricted", is_member: true }]) {
    const f = fixture({ members: [member] });
    const status = await f.status();
    assert.equal(status.status, 200); assert.equal(status.body.joined, true);
    const reward = await f.claim();
    assert.equal(reward.status, 200); assert.equal(reward.body.balance, 25);
    assert.equal(reward.body.alreadyClaimed, false); assert.equal(f.state.credits, 1);
    assert.equal(f.state.telegramCalls.filter(({ method, user }) => method === "getChatMember" && user === 777).length, 1, "admin check is cached briefly");
    assert.ok(f.state.timeouts.every((timeout) => timeout > 0 && timeout <= 4000));
  }
  for (const member of [{ status: "left" }, { status: "kicked" }, { status: "restricted", is_member: false }]) {
    const f = fixture({ members: [member] });
    const status = await f.status();
    assert.equal(status.body.joined, false);
    const reward = await f.claim();
    assert.equal(reward.status, 403); assert.equal(reward.body.code, "CHANNEL_NOT_JOINED");
    assert.equal(f.state.credits, 0); assert.equal(f.state.memberCalls, 3);
    assert.ok(f.state.waits.includes(700), "a negative claim receives one propagation retry");
  }
  const propagated = fixture({ members: [{ status: "left" }, { status: "member" }] });
  assert.equal((await propagated.claim()).status, 200); assert.equal(propagated.state.credits, 1);

  const networkRecovered = fixture({ members: [{ network: true }, { status: "member" }] });
  assert.equal((await networkRecovered.status()).body.joined, true);
  assert.equal(networkRecovered.state.memberCalls, 2);
  const rateRecovered = fixture({ members: [{ error_code: 429, retryAfter: 1 }, { status: "member" }] });
  assert.equal((await rateRecovered.status()).body.joined, true); assert.ok(rateRecovered.state.waits.includes(1000));
  const rateLimited = fixture({ members: [{ error_code: 429, retryAfter: 60 }] });
  const limited = await rateLimited.claim();
  assert.equal(limited.status, 503); assert.equal(limited.body.code, "CHANNEL_CHECK_UNAVAILABLE");
  assert.equal(limited.body.retryAfter, 60); assert.equal(rateLimited.state.memberCalls, 1); assert.equal(rateLimited.state.credits, 0);

  for (const member of [{ network: true }, { status: "unknown" }, { status: "restricted" }, { status: "member", userId: 43 }]) {
    const f = fixture({ members: [member] });
    const reply = await f.claim();
    assert.equal(reply.status, 503); assert.equal(reply.body.code, "CHANNEL_CHECK_UNAVAILABLE");
    assert.equal(f.state.credits, 0);
    assert.ok(f.state.logs.every((log) => !log.includes("SECRET_TOKEN")), "logs must sanitize raw fetch errors");
  }
  for (const options of [{ admin: "member" }, { admin: "left" }, { botToken: "" }, { channel: "@AnotherChannel" },
    { members: [{ error_code: 400, description: "Bad Request: member list is inaccessible" }] }]) {
    const f = fixture(options);
    const reply = await f.claim();
    assert.equal(reply.status, 503); assert.equal(reply.body.code, "CHANNEL_TASK_CONFIGURATION");
    assert.equal(f.state.credits, 0);
  }
  const already = fixture({ claimed: true, admin: "left" });
  assert.equal((await already.status()).body.claimed, true);
  assert.equal((await already.claim()).body.code, "TASK_ALREADY_CLAIMED");
  assert.equal(already.state.telegramCalls.length, 0, "historic claims take precedence over membership failure");

  const raced = fixture();
  const claims = await Promise.all([raced.claim(), raced.claim()]);
  assert.equal(raced.state.credits, 1); assert.equal(raced.state.balance, 25);
  assert.ok(claims.every((reply) => reply.status === 200));
  assert.equal(claims.filter((reply) => reply.body.alreadyClaimed).length, 1);
  const ambiguous = fixture({ loseClaimResponse: true });
  assert.equal((await ambiguous.claim()).status, 500);
  assert.equal((await ambiguous.claim()).body.code, "TASK_ALREADY_CLAIMED");
  assert.equal(ambiguous.state.credits, 1);
  assert.ok(ambiguous.state.databaseCalls.every(({ method }) => method !== "DELETE"), "lost response must not delete a committed claim");
  const exhausted = fixture({ rpcCode: "TASK_REWARD_EXHAUSTED" });
  assert.equal((await exhausted.claim()).body.code, "TASK_REWARD_EXHAUSTED");
  assert.equal(exhausted.state.credits, 0);
  const unavailable = fixture({ rpcCode: "TASK_REWARD_UNAVAILABLE" });
  assert.equal((await unavailable.claim()).body.code, "CHANNEL_TASK_CONFIGURATION");

  const internalPromo = fixture();
  const invalidPromo = await internalPromo.request("/api/promo/redeem", { code: " __task_channel_lordeuso " });
  assert.equal(invalidPromo.status, 400); assert.equal(invalidPromo.body.code, "INVALID_PROMO_CODE");
  assert.equal(internalPromo.state.databaseCalls.length, 0);
  console.log("PASS: membership states, bot-admin requirements, bounded transient/propagation retries, safe error codes, claimed-state precedence, atomic concurrent/ambiguous claims, unavailable/exhausted rewards, and reserved promo rejection. No real Telegram or database calls.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
