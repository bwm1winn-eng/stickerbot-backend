// Isolated checks against the actual server source. No credentials, listener,
// Telegram payment, provider generation, or database request is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, timingSafeEqual } = require("node:crypto");

const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, "../server.js"), "utf8")
  .replace(/^import[^\r\n]*(?:\r?\n|$)/gm, "");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(tier = "ultimate", { expired = false, failedImages = [] } = {}) {
  const routes = new Map();
  const state = { balance: 10000, debits: [], prompts: [], http: [], tier, expired };
  const app = { use() {}, get() {}, post(route, handler) { routes.set(route, handler); }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const context = vm.createContext({
    express, cors: () => () => {}, sharp: () => { throw new Error("Unused sharp stub"); },
    Buffer, URL, URLSearchParams, createHmac, timingSafeEqual,
    console: { log() {}, warn() {}, error() {} },
    process: { env: { BOT_TOKEN: "isolated-bot", TELEGRAM_WEBHOOK_SECRET: "isolated-secret",
      SUPABASE_URL: "https://database.test", SUPABASE_KEY: "isolated-service-key" } },
    fetch: async (url, options = {}) => {
      const call = { url: String(url), body: options.body ? JSON.parse(options.body) : null };
      state.http.push(call);
      const body = call.url.endsWith("/rpc/account_buy_coin_subscription_v2")
        ? { applied: true, balance: state.balance - call.body.p_expected_price }
        : call.url.endsWith("/createInvoiceLink") ? { ok: true, result: "https://invoice.test/fixture" }
        : (() => { throw new Error(`Unexpected HTTP endpoint ${call.url}`); })();
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    },
  });
  vm.runInContext(source, context, { filename: "premium-server-fixture.js" });
  context.extractUserId = () => 42;
  context.getOrCreateSubscription = async () => ({ active: !!state.tier, tier: state.tier,
    expires_at: state.expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", first_purchase_done: false });
  context.adjustBalance = async (_user, delta, details) => {
    state.debits.push({ delta, details: plain(details) }); state.balance += delta; return state.balance;
  };
  context.generateOneImage = async (prompt) => {
    const index = state.prompts.length;
    state.prompts.push(prompt);
    if (failedImages.includes(index)) throw new Error("Isolated provider failure");
    return Buffer.from("image-fixture");
  };
  context.processToSticker = async (buffer) => buffer;
  async function request(route, body) {
    const result = { status: 200 };
    const res = { status(code) { result.status = code; return this; }, json(value) { result.body = plain(value); return this; } };
    await routes.get(route)({ body, protocol: "https", get: () => "fixture.test" }, res);
    return result;
  }
  return { state, context, request, generate: (body) => request("/api/generate", { prompt: "cat astronaut", count: 6, ...body }) };
}

async function run() {
  const pricing = fixture();
  assert.deepEqual(plain(pricing.context.subscriptionCoinPrices()), { standard: 640, luxury: 1980, ultimate: 8760 });
  assert.deepEqual(plain(vm.runInContext("Object.fromEntries(Object.entries(TIERS).map(([tier,cfg])=>[tier,[cfg.firstStars,cfg.renewStars,cfg.dailyBonus]]))", pricing.context)),
    { standard: [21, 32, 3], luxury: [65, 99, 0], ultimate: [287, 438, 0] });

  for (const tier of ["standard", "luxury", "ultimate"]) {
    const f = fixture(tier);
    const expected = { standard: 640, luxury: 1980, ultimate: 8760 }[tier];
    for (const quote of [undefined, expected - 1, String(expected), null]) {
      const reply = await f.request("/api/subscription/buy-coins", { tier, expectedPrice: quote });
      assert.equal(reply.status, 409);
      assert.equal(reply.body.code, "COIN_SUBSCRIPTION_PRICE_CHANGED");
      assert.equal(reply.body.cost, expected);
      assert.equal(reply.body.quoteRequired, true);
      assert.equal(f.state.http.length, 0, "unconfirmed quote must not reach the database");
    }
    const purchased = await f.request("/api/subscription/buy-coins", { tier, expectedPrice: expected });
    assert.equal(purchased.status, 200);
    assert.equal(f.state.http.length, 1);
    assert.ok(f.state.http[0].url.endsWith("/rpc/account_buy_coin_subscription_v2"));
    assert.deepEqual(f.state.http[0].body, { p_user_id: 42, p_tier: tier, p_expected_price: expected });
    const invoice = await f.request("/api/subscription/create-invoice", { tier });
    const firstStars = { standard: 21, luxury: 65, ultimate: 287 }[tier];
    assert.equal(invoice.status, 200);
    assert.equal(invoice.body.stars, firstStars);
    assert.equal(f.state.http[1].body.prices[0].amount, firstStars);
    assert.equal(JSON.parse(f.state.http[1].body.payload).stars, firstStars);
    assert.ok(f.state.http[1].body.description.length <= 255, "Telegram invoice description limit");
    assert.doesNotMatch(f.state.http[1].body.description, /\+0|Приоритет/);
  }

  for (const tier of [null, "standard", "luxury", "ultimate"]) {
    const expired = tier === "ultimate";
    const f = fixture(tier, { expired });
    for (const style of ["clay3d", "paper", "anime"]) {
      if (tier === "luxury") continue;
      const reply = await f.generate({ style });
      assert.equal(reply.status, 403);
      assert.equal(reply.body.code, "STYLE_TIER_REQUIRED");
    }
    const preset = await f.generate({ preset: "emotions" });
    assert.equal(preset.status, 403);
    assert.equal(preset.body.code, "PRESET_TIER_REQUIRED");
    assert.equal(f.state.debits.length, 0);
    assert.equal(f.state.prompts.length, 0);
  }

  const invalid = fixture();
  for (const body of [{ prompt: 4 }, { style: "constructor" }, { style: "unknown" },
    { preset: "unknown" }, { preset: "emotions", count: 5 }, { preset: "emotions", count: 6.1 }]) {
    assert.equal((await invalid.generate(body)).status, 400);
  }
  assert.equal(invalid.state.debits.length, 0);
  assert.equal(invalid.state.prompts.length, 0);

  for (const style of ["vector", "clay3d", "paper", "anime"]) {
    const f = fixture("luxury");
    const reply = await f.generate({ style, count: 1 });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.images.length, 1);
    assert.equal(reply.body.cost, 3);
    assert.equal(f.state.prompts.length, 1);
    const artPhrase = { vector: "cute cartoon vector style", clay3d: "3D clay render look",
      paper: "layered paper-cut illustration", anime: "anime illustration" }[style];
    assert.ok(f.state.prompts[0].includes(artPhrase));
    if (style === "vector") assert.match(f.state.prompts[0], /cute cartoon vector style/);
    else assert.doesNotMatch(f.state.prompts[0], /cartoon vector|simple flat colors/);
  }

  const full = fixture();
  const generated = await full.generate({ style: "clay3d", preset: "emotions" });
  assert.equal(generated.body.cost, 12);
  assert.equal(generated.body.images.length, 6);
  assert.deepEqual(generated.body.images.map((image) => image.emotion), ["happy", "sad", "wow", "love", "angry", "wink"]);
  assert.equal(full.state.prompts.length, 6);
  assert.equal(new Set(full.state.prompts).size, 6);
  assert.ok(full.state.prompts.every((prompt) => prompt.includes("3D clay render look") && !prompt.includes("cartoon vector")));
  assert.deepEqual(full.state.debits.map(({ delta }) => delta), [-12]);
  assert.equal(full.state.debits[0].details.metadata.preset, "emotions");

  const partial = fixture("ultimate", { failedImages: [1, 4] });
  const partlyGenerated = await partial.generate({ style: "paper", preset: "emotions" });
  assert.equal(partlyGenerated.body.cost, 8);
  assert.deepEqual(partlyGenerated.body.images.map((image) => image.emotion), ["happy", "wow", "love", "wink"]);
  assert.deepEqual(partial.state.debits.map(({ delta }) => delta), [-12, 4]);
  assert.equal(partial.state.prompts.length, 6, "partial failures must not add generation requests");
  const failed = fixture("ultimate", { failedImages: [0, 1, 2, 3, 4, 5] });
  assert.equal((await failed.generate({ preset: "emotions" })).status, 502);
  assert.deepEqual(failed.state.debits.map(({ delta }) => delta), [-12, 12]);

  const oldPrices = { standard: [19, 29], luxury: [52, 79], ultimate: [229, 350] };
  for (const [tier, starsValues] of Object.entries(oldPrices)) {
    for (const stars of starsValues) {
      const payload = JSON.stringify({ type: "subscription", tier, userId: 42, stars });
      assert.ok(pricing.context.parseInvoicePurchase(payload, "XTR", stars, 42), "issued invoice keeps its explicit quoted price");
      assert.equal(pricing.context.parseInvoicePurchase(payload, "XTR", stars + 1, 42), null);
    }
  }
  console.log("PASS: prices/bonus configuration, quote confirmation and v2 RPC, style/preset entitlement, invalid-input rejection before debit, exclusive art prompts, six emotions and refund accounting, issued invoice compatibility. No external requests or real charges.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
