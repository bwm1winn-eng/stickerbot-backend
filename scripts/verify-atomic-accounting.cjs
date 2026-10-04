// Isolated backend checks: evaluates the actual server with stubbed HTTP, app and
// environment. It loads no credentials, opens no listener and makes no network calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, timingSafeEqual } = require("node:crypto");

const routes = new Map();
const calls = [];
let respond = async () => { throw new Error("Unexpected HTTP call"); };
const app = { use() {}, get() {}, post(route, handler) { routes.set(route, handler); }, listen() {} };
const express = () => app;
express.json = () => () => {};
const context = vm.createContext({
  express, cors: () => () => {}, sharp: () => { throw new Error("Unused image stub"); },
  Buffer, URL, URLSearchParams, createHmac, timingSafeEqual,
  console: { log() {}, warn() {}, error() {} },
  process: { env: {
    BOT_TOKEN: "isolated-bot", TELEGRAM_WEBHOOK_SECRET: "isolated-secret",
    SUPABASE_URL: "https://database.test", SUPABASE_KEY: "isolated-service-key",
  } },
  fetch: async (url, options = {}) => {
    const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return respond(call);
  },
});
const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, "../server.js"), "utf8")
  .replace(/^import[^\r\n]*(?:\r?\n|$)/gm, "");
vm.runInContext(source, context, { filename: "audit-server.js" });

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body), json: async () => body,
});
function reset(handler) { calls.length = 0; respond = handler; }
function message(payload = { type: "balance", userId: 42, amount: 100 }, extra = {}) {
  return { from: { id: 42 }, chat: { id: 42 }, successful_payment: {
    invoice_payload: JSON.stringify(payload), currency: "XTR",
    total_amount: payload.stars ?? context.amountToStars(payload.amount || 100),
    telegram_payment_charge_id: "charge-001", ...extra,
  } };
}
async function webhook(body, secret = "isolated-secret") {
  let status;
  const res = { sendStatus(code) { status = code; return this; } };
  await routes.get("/telegram-webhook")({ body, get: () => secret }, res);
  return status;
}

async function run() {
  reset(() => reply(17));
  assert.equal(await context.adjustBalance(42, 2, { type: "reward", description: "test", metadata: { source: "test" } }), 17);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://database.test/rest/v1/rpc/account_adjust_balance");
  assert.deepEqual(calls[0].body, { p_user_id: 42, p_delta: 2, p_event_type: "reward", p_description: "test", p_metadata: { source: "test" } });

  reset(() => reply({ code: "P0001", message: "insufficient balance", details: "test-details" }, 400));
  await assert.rejects(context.adjustBalance(42, -100), (err) => {
    assert.equal(err.code, "INSUFFICIENT_BALANCE");
    assert.equal(err.dbCode, "P0001");
    assert.equal(err.message, "insufficient balance");
    assert.equal(err.status, 400);
    assert.equal(err.details, "test-details");
    return true;
  });
  reset(() => reply(8));
  assert.equal(await context.maybeApplyDailyBonus(42, { tier: "standard", last_bonus_date: "2099-01-01" }), 8);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://database.test/rest/v1/rpc/account_apply_daily_bonus");
  assert.deepEqual(calls[0].body.p_bonus_by_tier, { standard: 3, luxury: 8, ultimate: 35 });

  const valid = message();
  assert.ok(context.parseSuccessfulPayment(valid));
  assert.ok(context.parseSuccessfulPayment(message({ type: "subscription", userId: 42, tier: "standard" }, { total_amount: 19 })));
  assert.ok(context.parseSuccessfulPayment(message({ type: "subscription", userId: 42, tier: "standard", stars: 18 }, { total_amount: 18 })));
  const invalid = [
    message({}, { invoice_payload: "{" }), message({}, { invoice_payload: "null" }),
    message({}, { invoice_payload: "[]" }), message({ type: "other", userId: 42, amount: 100 }),
    message({ type: "balance", userId: 42, amount: -100 }),
    message({ type: "balance", userId: 42, amount: "100" }),
    message({ type: "balance", userId: "42", amount: 100 }),
    message({ type: "subscription", userId: 42, tier: "constructor" }, { total_amount: 19 }),
    message({ type: "subscription", userId: 42, tier: "missing" }, { total_amount: 19 }),
    { ...message(), from: { id: 43 } }, message(undefined, { currency: "USD" }),
    message(undefined, { total_amount: 999 }), message(undefined, { telegram_payment_charge_id: "" }),
    message({ type: "balance", userId: 42, amount: 100, stars: "12" }),
    message({ type: "balance", userId: 42, amount: 100, stars: 12 }, { total_amount: 13 }),
  ];
  for (const candidate of invalid) {
    assert.equal(context.parseSuccessfulPayment(candidate), null);
    reset(() => { throw new Error("Invalid update must not call HTTP"); });
    assert.equal(await webhook({ update_id: 1, message: candidate }), 200);
    assert.equal(calls.length, 0);
  }

  const precheckout = { id: "checkout-1", from: { id: 42 }, ...valid.successful_payment };
  reset(() => reply({ ok: true }));
  assert.equal(await webhook({ pre_checkout_query: precheckout }), 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.ok, true);
  assert.equal(calls[0].body.pre_checkout_query_id, "checkout-1");
  reset(() => reply({ ok: true }));
  assert.equal(await webhook({ pre_checkout_query: { ...precheckout, from: { id: 43 } } }), 200);
  assert.equal(calls[0].body.ok, false);
  assert.ok(calls[0].body.error_message);
  reset(() => reply({ ok: false }));
  assert.equal(await webhook({ pre_checkout_query: precheckout }), 500);

  reset(() => reply({ message: "database write failed", code: "XX000" }, 500));
  assert.equal(await webhook({ message: valid }), 500);
  assert.equal(calls.length, 1);
  reset(() => { throw new Error("Temporary database network failure"); });
  assert.equal(await webhook({ message: valid }), 500);
  reset(() => reply({ message: "payment charge already used with different details", code: "22023" }, 400));
  assert.equal(await webhook({ message: valid }), 200);

  reset(({ url }) => url.includes("database.test") ? reply({ applied: true, balance: 115, expiresAt: null }) : reply({ ok: true }));
  assert.equal(await webhook({ message: valid }), 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.p_charge_id, "charge-001");
  assert.equal(calls[0].body.p_payment_type, "balance");
  assert.equal(calls[1].body.chat_id, 42);
  reset(() => reply({ applied: false, balance: 115, expiresAt: null }));
  assert.equal(await webhook({ message: valid }), 200);
  assert.equal(calls.length, 1);
  reset(({ url }) => {
    if (url.includes("database.test")) return reply({ applied: true, balance: 115, expiresAt: null });
    throw new Error("Telegram unavailable after payment commit");
  });
  assert.equal(await webhook({ message: valid }), 200);
  assert.equal(calls.length, 2);

  const subscription = message({ type: "subscription", userId: 42, tier: "standard", stars: 19 }, { total_amount: 19 });
  reset(({ url }) => url.includes("database.test")
    ? reply({ applied: true, balance: 15, expiresAt: "2099-01-01T00:00:00.000Z" }) : reply({ ok: true }));
  assert.equal(await webhook({ message: subscription }), 200);
  assert.equal(calls[0].body.p_tier, "standard");
  assert.equal(calls[0].body.p_amount, null);
  assert.equal(calls.length, 2);
  reset(() => { throw new Error("Bad webhook secret must not make HTTP calls"); });
  assert.equal(await webhook({ message: valid }, "incorrect-secret"), 401);
  assert.equal(calls.length, 0);
  console.log("PASS: atomic RPC routing, parsed DB errors, invoice validation, checkout rejection, payment retry, duplicate suppression and notification failure handling");
}
run().catch((err) => { console.error(err); process.exitCode = 1; });

