// Provider reliability checks against actual server code, without AI requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHmac, timingSafeEqual } = require("node:crypto");
const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, "../server.js"), "utf8")
  .replace(/^import[^\r\n]*(?:\r?\n|$)/gm, "");

function fixture(responses, { key = "" } = {}) {
  const state = { clock: Date.now(), requests: [], waits: [], logs: [] };
  class FixtureDate extends Date { static now() { return state.clock; } }
  const app = { use() {}, get() {}, post() {}, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const context = vm.createContext({
    express, cors: () => () => {}, sharp: () => { throw new Error("Unused sharp stub"); },
    Buffer, URL, URLSearchParams, createHmac, timingSafeEqual, Date: FixtureDate,
    AbortSignal: { timeout(ms) { return { deadlineMs: ms }; } },
    setTimeout(callback, delay) { state.waits.push(delay); state.clock += delay; callback(); },
    console: { log() {}, error() {}, warn(...items) { state.logs.push(items.join(" ")); } },
    process: { env: { POLLINATIONS_KEY: key } },
    fetch: async (url, options = {}) => {
      state.requests.push({ url, timeout: options.signal?.deadlineMs });
      const next = responses[state.requests.length - 1];
      assert.ok(next, "unexpected additional provider request");
      state.clock += next.elapsed || 0;
      if (next.network) throw new Error("https://provider.test/PRIVATE_PROMPT?key=PRIVATE_KEY");
      return { status: next.status || 200, ok: !next.status || next.status < 400,
        headers: { get: () => next.retryAfter || null },
        text: async () => { throw new Error("Raw provider error text must not be read"); },
        arrayBuffer: async () => {
          if (next.bodyError) throw new Error("PRIVATE_KEY response read timed out");
          return Buffer.from("isolated-image");
        },
      };
    },
  });
  vm.runInContext(source, context, { filename: "provider-server-fixture.js" });
  return { context, state };
}

async function run() {
  const payment = fixture([{ status: 402 }]);
  await assert.rejects(payment.context.generateViaFreeEndpoint("PRIVATE_PROMPT"), (error) => error.code === "IMAGE_PROVIDER_PAYMENT_REQUIRED");
  assert.equal(payment.state.requests.length, 1);
  assert.deepEqual(payment.state.waits, []);

  const limited = fixture([{ status: 429, retryAfter: "1" }, {}]);
  assert.equal((await limited.context.generateViaFreeEndpoint("idea")).toString(), "isolated-image");
  assert.equal(limited.state.requests.length, 2); assert.deepEqual(limited.state.waits, [1000]);
  const longLimit = fixture([{ status: 429, retryAfter: "60" }]);
  await assert.rejects(longLimit.context.generateViaFreeEndpoint("idea"));
  assert.equal(longLimit.state.requests.length, 1); assert.deepEqual(longLimit.state.waits, []);
  const repeated = fixture([{ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" }]);
  await assert.rejects(repeated.context.generateViaFreeEndpoint("idea"));
  assert.equal(repeated.state.requests.length, 2); assert.deepEqual(repeated.state.waits, [1000]);
  const serverRecovery = fixture([{ status: 503 }, {}]);
  assert.equal((await serverRecovery.context.generateViaFreeEndpoint("idea")).toString(), "isolated-image");
  assert.equal(serverRecovery.state.requests.length, 2);

  const fallback = fixture([{ network: true, elapsed: 1000 }, {}], { key: "PRIVATE_KEY&value=extra" });
  assert.equal((await fallback.context.generateOneImage("PRIVATE_PROMPT")).toString(), "isolated-image");
  assert.deepEqual(fallback.state.requests.map(({ timeout }) => timeout), [45000, 44000], "paid and free share a 45-second budget");
  assert.equal(new URL(fallback.state.requests[0].url).searchParams.get("key"), "PRIVATE_KEY&value=extra");
  assert.ok(fallback.state.logs.every((log) => !log.includes("PRIVATE_KEY") && !log.includes("PRIVATE_PROMPT") && !log.includes("https:")));

  const exhausted = fixture([{ network: true, elapsed: 45000 }], { key: "PRIVATE_KEY" });
  await assert.rejects(exhausted.context.generateOneImage("idea"));
  assert.equal(exhausted.state.requests.length, 1, "fallback may not exceed the original deadline");
  const bodyFailure = fixture([{ bodyError: true }, {}], { key: "PRIVATE_KEY" });
  assert.equal((await bodyFailure.context.generateOneImage("idea")).toString(), "isolated-image");
  assert.ok(bodyFailure.state.logs.every((log) => !log.includes("PRIVATE_KEY")));
  const networkFailure = fixture([{ network: true }]);
  await assert.rejects(networkFailure.context.generateViaFreeEndpoint("idea"), (error) =>
    !error.message.includes("PRIVATE_KEY") && !error.message.includes("PRIVATE_PROMPT") && error.code === "IMAGE_PROVIDER_UNAVAILABLE");
  assert.ok(networkFailure.state.requests.every(({ timeout }) => timeout > 0 && timeout <= 45000));
  console.log("PASS: provider timeout/shared budget, no 402 retries, bounded 429/503 retry respecting Retry-After, encoded paid key, safe URL/body diagnostics, body failure and deadline exhaustion. No AI requests or real charges.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
