const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(process.argv[2] || path.resolve(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('async function handleChatMessage(message)');
const end = source.indexOf('\nconst FALLBACK_HELP_TEXT', start);
assert.ok(start >= 0 && end > start);

function fixture({ used = 0, balance = 100, produced = 4, paid = false, fail = false, banned = false } = {}) {
  const state = { used, balance, requested: [], deltas: [], messages: [] };
  const context = vm.createContext({
    process: { env: {} }, console, Date, Map,
    GEN_COST_PER_IMAGE: 5, CHAT_GEN_COUNT: 4,
    generatedCache: new Map(), lastGenerationByUser: new Map(),
    getOrCreateSubscription: async () => ({}),
    tierConfig: () => paid ? { discountPerImage: 1 } : null,
    isOwnerUser: () => false,
    isAccountBanned: async () => banned,
    reserveFreeDailyImageSlots: async (_user, count) => {
      const slots = Array.from({ length: Math.min(count, 4 - state.used) }, (_, n) => `slot-${state.used + n}`);
      state.used += slots.length;
      return slots;
    },
    releaseFreeDailyImageSlots: async (_user, slots) => { state.used -= slots.length; },
    adjustBalance: async (_user, delta) => {
      if (state.balance + delta < 0) throw Object.assign(new Error('insufficient balance'), { code: 'INSUFFICIENT_BALANCE' });
      state.balance += delta; state.deltas.push(delta); return state.balance;
    },
    generateStickerSet: async (_prompt, count) => {
      state.requested.push(count);
      if (fail) throw new Error('provider failed');
      return Array.from({ length: Math.min(count, produced) }, (_, n) => ({ id: `test-${n}` }));
    },
    sendTelegramMessage: async (_chat, text) => state.messages.push(text),
    sendTelegramPhoto: async () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  return { state, run: () => context.handleChatMessage({ chat: { id: 123 }, from: { id: 456 }, text: '/create test cat' }) };
}

(async () => {
  const blocked = fixture({ banned: true });
  await blocked.run();
  assert.equal(blocked.state.balance, 100);
  assert.deepEqual(blocked.state.requested, []);
  assert.equal(blocked.state.messages.length, 1);
  const remaining = fixture({ used: 2 });
  await remaining.run();
  assert.deepEqual(remaining.state.requested, [2]);
  assert.equal(remaining.state.balance, 90);
  assert.equal(remaining.state.used, 4);
  await remaining.run();
  assert.deepEqual(remaining.state.requested, [2], 'shared daily limit must block the next chat generation');
  assert.equal(remaining.state.balance, 90);

  const partial = fixture({ produced: 2 });
  await partial.run();
  assert.equal(partial.state.balance, 90, 'charge only two successful images');
  assert.equal(partial.state.used, 2, 'failed images release quota');
  assert.deepEqual(partial.state.deltas, [-20, 10]);

  const none = fixture({ produced: 0 });
  await none.run();
  assert.equal(none.state.balance, 100);
  assert.equal(none.state.used, 0);

  const insufficient = fixture({ balance: 0 });
  await insufficient.run();
  assert.equal(insufficient.state.used, 0);
  assert.deepEqual(insufficient.state.requested, []);

  const failed = fixture({ fail: true });
  await assert.rejects(failed.run(), /provider failed/);
  assert.equal(failed.state.balance, 100);
  assert.equal(failed.state.used, 0);

  const premium = fixture({ used: 4, paid: true });
  await premium.run();
  assert.deepEqual(premium.state.requested, [4]);
  assert.equal(premium.state.used, 4);
  assert.equal(premium.state.balance, 84);
  console.log('PASS: shared chat quota, partial/full/exception refunds, insufficient funds, paid plan bypass. No external requests.');
})().catch(error => { console.error(error); process.exitCode = 1; });
