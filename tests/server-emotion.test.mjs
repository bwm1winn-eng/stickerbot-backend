import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { EMOTION_VARIANTS } from '../emotion-catalog.js';

// Execute the actual server routes with in-memory dependencies. No dotenv,
// provider, Telegram, database, listener, or worker is started by this fixture.
const source = (await readFile(new URL('../server.js', import.meta.url), 'utf8'))
  .replace(/^import[^\r\n]*(?:\r?\n|$)/gm, '');
const token = 'fixture-only-token';
const copy = (value) => JSON.parse(JSON.stringify(value));

function signedData(userId = 123, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id: userId }) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

function serverFixture({ tier = null, ownerId, banned = false, database, telegram } = {}) {
  const calls = [];
  const logs = [];
  const routes = new Map();
  const guards = [];
  const assets = new Map();
  const claims = new Set();
  const prompts = [];
  let balance = 1000;
  let creatorDependencies;
  let generator = async (prompt, background) => { prompts.push({ prompt, background }); return Buffer.from('fixture-image'); };
  const app = {
    use(...args) { if (args[0] === '/api') guards.push(args[1]); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    listen() {},
  };
  const express = () => app;
  express.json = () => () => {};
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value), json: async () => value });
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, AbortSignal, createHmac, timingSafeEqual, EMOTION_VARIANTS,
    express, cors: () => () => {}, sharp: () => { throw new Error('unexpected sharp call'); },
    process: { env: { BOT_TOKEN: token, SUPABASE_URL: 'https://database.fixture', SUPABASE_KEY: 'fixture-key', ...(ownerId ? { OWNER_TELEGRAM_ID: String(ownerId) } : {}) } },
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
    stickerBackground: (mode = 'white', color) => ({ mode, ...(color ? { color } : {}) }),
    backgroundPrompt: (background) => `fixture ${background.mode} background`,
    normalizeSticker: async (buffer) => buffer,
    createCreatorFeatures: (dependencies) => {
      creatorDependencies = dependencies;
      return { register() {}, start() { throw new Error('worker must not start'); }, async putAsset(userId, buffer) { const id = `asset-${assets.size + 1}`; assets.set(id, { userId, buffer }); return id; } };
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, options });
      if (parsed.hostname === 'api.telegram.org') {
        if (!telegram) throw new Error('unexpected Telegram request');
        return telegram(parsed, options, response);
      }
      assert.equal(parsed.hostname, 'database.fixture', 'unexpected external request');
      const path = parsed.pathname.replace('/rest/v1/', '') + parsed.search;
      const body = options.body ? JSON.parse(options.body) : undefined;
      const custom = database ? await database(path, options, body, response) : undefined;
      if (custom !== undefined) return custom;
      if (path.startsWith('app_user_moderation?')) return response([{ banned }]);
      if (path.startsWith('balances?')) return response([{ balance }]);
      if (path.startsWith('subscriptions?')) return response([{ user_id: 123, active: !!tier, expires_at: tier ? '2099-01-01T00:00:00Z' : null, tier, first_purchase_done: false, last_coin_purchase_at: null }]);
      if (path.startsWith('promo_redemptions?')) {
        if (options.method === 'POST') { if (claims.has(body.code)) return response([]); claims.add(body.code); return response([body]); }
        const codes = parsed.searchParams.get('code');
        if (options.method === 'DELETE') { for (const code of [...claims]) if (codes?.includes(code)) claims.delete(code); return response(null); }
        return response([...claims].filter((code) => codes?.includes(code)).map((code) => ({ code })));
      }
      if (path === 'rpc/account_adjust_balance') { balance += body.p_delta; return response(balance); }
      throw new Error(`unexpected fixture database path: ${path}`);
    },
  });
  new vm.Script(`${source}\n globalThis.serverTestHooks = {
    getFreeEmotionUsage, getFreeDailyImageUsage, generateStickerSet, extractUserId,
    channelTaskTelegramRequest, verifyChannelTaskMembership, FREE_DAILY_IMAGE_LIMIT, TIERS,
    replaceGenerator(fn) { generateOneImage = fn; }
  };`, { filename: 'server.js' }).runInContext(context);
  context.serverTestHooks.replaceGenerator((...args) => generator(...args));
  return {
    hooks: context.serverTestHooks, calls, logs, claims, prompts, assets,
    get creatorDependencies() { return creatorDependencies; },
    setGenerator(fn) { generator = fn; },
    async request(path, body = {}, initData = signedData()) {
      const req = { body: { ...body, initData }, query: {}, params: {} };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = copy(value); return this; } };
      for (const guard of guards) { let next = false; await guard(req, res, () => { next = true; }); if (!next) return res; }
      const handler = routes.get(`POST ${path}`);
      assert.ok(handler, `missing route ${path}`);
      await handler(req, res);
      return res;
    },
  };
}

test('catalogue contains 36 distinct moods and preserves the original first six', () => {
  assert.equal(EMOTION_VARIANTS.length, 36);
  assert.deepEqual(EMOTION_VARIANTS.slice(0, 6).map((item) => item.key), ['happy', 'sad', 'wow', 'love', 'angry', 'wink']);
  assert.equal(new Set(EMOTION_VARIANTS.map((item) => item.key)).size, 36);
  assert.equal(new Set(EMOTION_VARIANTS.map((item) => item.description)).size, 36);
  assert.ok(EMOTION_VARIANTS.every((item) => item.description.length > 15 && item.emoji && Object.isFrozen(item)));
  assert.ok(Object.isFrozen(EMOTION_VARIANTS));
});

test('free emotion usage reads only the daily marker and resets at the next UTC midnight', async () => {
  const fixture = serverFixture();
  assert.deepEqual(copy(await fixture.hooks.getFreeEmotionUsage(123, '2026-12-31')), { limit: 1, used: 0, remaining: 1, available: true, resetAt: '2027-01-01T00:00:00.000Z' });
  const query = fixture.calls.at(-1).url.searchParams;
  assert.equal(query.get('code'), 'eq.__free_emotions_2026-12-31');
  assert.equal(query.get('user_id'), 'eq.123');
  assert.equal(query.get('limit'), '1');
  fixture.claims.add('__free_emotions_2026-12-31');
  assert.deepEqual(copy(await fixture.hooks.getFreeEmotionUsage(123, '2026-12-31')), { limit: 1, used: 1, remaining: 0, available: false, resetAt: '2027-01-01T00:00:00.000Z' });
});

test('daily image usage includes all eight slots', async () => {
  const fixture = serverFixture();
  for (let slot = 1; slot <= 5; slot++) fixture.claims.add(`__free_image_2026-10-08_${slot}`);
  assert.deepEqual(copy(await fixture.hooks.getFreeDailyImageUsage(123, '2026-10-08')), { limit: 8, used: 5 });
  assert.match(fixture.calls.at(-1).url.searchParams.get('code'), /__free_image_2026-10-08_8/);
});

for (const path of ['/api/balance', '/api/subscription/status']) {
  test(`${path} reports signed free quotas and canonical integration dependencies`, async () => {
    const fixture = serverFixture();
    const result = await fixture.request(path);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.freeDaily, { limit: 8, used: 0, remaining: 8 });
    assert.equal(result.body.freeEmotion.available, true);
    assert.equal(result.body.freeEmotion.limit, 1);
    assert.match(result.body.freeEmotion.resetAt, /T00:00:00\.000Z$/);
    assert.equal(fixture.creatorDependencies.getFreeEmotionUsage, fixture.hooks.getFreeEmotionUsage);
    assert.equal(fixture.creatorDependencies.getFreeDailyImageUsage, fixture.hooks.getFreeDailyImageUsage);
    assert.equal(typeof fixture.creatorDependencies.isOwnerUser, 'function');
    assert.equal(fixture.creatorDependencies.EMOTION_VARIANTS, EMOTION_VARIANTS);
  });
  test(`${path} returns null free emotion quota for paid users and owners`, async () => {
    for (const config of [{ tier: 'standard' }, { tier: 'luxury' }, { tier: 'ultimate' }, { ownerId: 123 }]) {
      const fixture = serverFixture(config);
      const result = await fixture.request(path);
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.freeEmotion, null);
      assert.ok(!fixture.calls.some((call) => call.url.pathname.includes('promo_redemptions')));
    }
  });
  test(`${path} rejects unsigned, forged, expired, and banned identities before quota access`, async () => {
    for (const initData of ['', signedData().replace('123', '124'), signedData(123, Math.floor(Date.now() / 1000) - 86401)]) {
      const fixture = serverFixture();
      const result = await fixture.request(path, {}, initData);
      assert.equal(result.statusCode, 400);
      assert.equal(fixture.calls.length, 0);
    }
    const fixture = serverFixture({ banned: true });
    const result = await fixture.request(path);
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.code, 'ACCOUNT_BANNED');
    assert.ok(!fixture.calls.some((call) => call.url.pathname.includes('promo_redemptions')));
  });
}

test('single emotion generation combines canonical mood, style, background, and tier prompt', async () => {
  const fixture = serverFixture();
  const selected = EMOTION_VARIANTS[27];
  const images = await fixture.hooks.generateStickerSet('  little fox  ', 1, (id) => `/test/${id}`, {
    cfg: fixture.hooks.TIERS.luxury, style: 'paper', background: { mode: 'transparent' }, userId: 123,
    emotion: { key: selected.key, description: 'untrusted injected description', emoji: 'wrong' },
  });
  assert.equal(fixture.prompts.length, 1);
  const prompt = fixture.prompts[0].prompt;
  assert.match(prompt, /little fox/);
  assert.match(prompt, /layered paper-cut illustration/);
  assert.match(prompt, /fixture transparent background/);
  assert.match(prompt, /premium glossy sticker finish/);
  assert.ok(prompt.includes(selected.description));
  assert.ok(!prompt.includes('untrusted injected description'));
  assert.deepEqual(copy(images[0]), { id: 'asset-1', url: '/test/asset-1', animated: false, emotion: selected.key, emoji: selected.emoji });
});

test('unknown emotion keys and malformed emotion inputs fail before provider calls', async () => {
  const fixture = serverFixture();
  for (const emotion of ['made-up', { key: 'made-up' }, 7, {}]) {
    await assert.rejects(fixture.hooks.generateStickerSet('fox', 1, null, { emotion, userId: 123 }), { code: 'INVALID_EMOTION' });
  }
  assert.equal(fixture.prompts.length, 0);
});

test('paid legacy emotion shortcut accepts exactly six images on each tier', async () => {
  for (const [tier, unitCost] of [['standard', 4], ['luxury', 3], ['ultimate', 2]]) {
    const fixture = serverFixture({ tier });
    const result = await fixture.request('/api/generate', { prompt: 'fox', count: 6, preset: 'emotions' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.images.length, 6);
    assert.equal(result.body.cost, 6 * unitCost);
    assert.deepEqual(result.body.images.map((item) => item.emotion), EMOTION_VARIANTS.slice(0, 6).map((item) => item.key));
    assert.deepEqual(result.body.images.map((item) => item.emoji), EMOTION_VARIANTS.slice(0, 6).map((item) => item.emoji));
    assert.equal(fixture.claims.size, 0);
    const invalid = await fixture.request('/api/generate', { prompt: 'fox', count: 36, preset: 'emotions' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, 'INVALID_PRESET_COUNT');
  }
});

test('free accounts cannot bypass the daily emotion job through the direct shortcut', async () => {
  const fixture = serverFixture();
  const result = await fixture.request('/api/generate', { prompt: 'fox', count: 6, preset: 'emotions' });
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'FREE_EMOTIONS_JOB_REQUIRED');
  assert.equal(fixture.prompts.length, 0);
  assert.equal(fixture.claims.size, 0);
  assert.ok(!fixture.calls.some((call) => call.options.method === 'POST'));
});

test('accepted numeric strings in the legacy shortcut always produce six images', async () => {
  for (const count of ['6', '0x6', '0b110', '6.0']) {
    const fixture = serverFixture({ tier: 'standard' });
    const result = await fixture.request('/api/generate', { prompt: 'fox', count, preset: 'emotions' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.images.length, 6);
    assert.equal(result.body.cost, 24);
  }
});

test('ordinary generation caps stay eight free and 6/10/12 paid', async () => {
  for (const [tier, cap] of [[null, 8], ['standard', 6], ['luxury', 10], ['ultimate', 12]]) {
    const fixture = serverFixture({ tier });
    const result = await fixture.request('/api/generate', { prompt: 'fox', count: 36 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.images.length, cap);
    if (!tier) {
      assert.deepEqual(result.body.freeDaily, { limit: 8, used: 8, remaining: 0 });
      const exhausted = await fixture.request('/api/generate', { prompt: 'fox', count: 1 });
      assert.equal(exhausted.statusCode, 429);
      assert.equal(exhausted.body.code, 'DAILY_FREE_LIMIT');
    }
  }
});

test('failed free images release their daily slots and refund only failed images', async () => {
  const fixture = serverFixture();
  let attempts = 0;
  fixture.setGenerator(async () => { if (++attempts <= 2) throw new Error('fixture image failure'); return Buffer.from('fixture-image'); });
  const result = await fixture.request('/api/generate', { prompt: 'fox', count: 8 });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.images.length, 6);
  assert.equal(result.body.cost, 30);
  assert.equal(result.body.balance, 970);
  assert.equal(fixture.claims.size, 6);
  assert.deepEqual(result.body.freeDaily, { limit: 8, used: 6, remaining: 2 });
});

test('simultaneous free generations share eight unique daily slots', async () => {
  const fixture = serverFixture();
  const results = await Promise.all([
    fixture.request('/api/generate', { prompt: 'first fox', count: 8 }),
    fixture.request('/api/generate', { prompt: 'second fox', count: 8 }),
  ]);
  assert.ok(results.every((result) => [200, 429].includes(result.statusCode)));
  assert.equal(results.reduce((total, result) => total + (result.body.images?.length || 0), 0), 8);
  assert.equal(fixture.claims.size, 8);
  assert.equal(fixture.prompts.length, 8);
  assert.equal(results.reduce((total, result) => total + (result.body.cost || 0), 0), 40);
});

test('a failed later reservation insert releases previously confirmed daily slots', async () => {
  let inserts = 0;
  const fixture = serverFixture({ database: (path, options, body, response) => {
    if (path.startsWith('promo_redemptions?') && options.method === 'POST' && ++inserts === 3) return response({ message: 'fixture reservation failure', code: 'XX000' }, 500);
  } });
  const result = await fixture.request('/api/generate', { prompt: 'fox', count: 8 });
  assert.equal(result.statusCode, 500);
  assert.equal(fixture.claims.size, 0);
  assert.equal(fixture.prompts.length, 0);
  assert.ok(!fixture.calls.some((call) => call.url.pathname.endsWith('account_adjust_balance')));
});

test('channel task database status failures are distinct from membership failures and logs contain no raw identifiers', async () => {
  const privateMarker = 'database-secret-user-123456789-token';
  const fixture = serverFixture({ database: (path, options, body, response) => path.startsWith('promo_redemptions?') ? response({ message: privateMarker, code: 'XX000' }, 500) : undefined });
  const result = await fixture.request('/api/tasks/channel/status');
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'CHANNEL_TASK_STATUS_UNAVAILABLE');
  const logs = JSON.stringify(fixture.logs);
  assert.match(logs, /database_request_failed/);
  assert.match(logs, /hasChannelTaskClaim/);
  assert.ok(!logs.includes(privateMarker));
  assert.ok(!logs.includes(token));
});

test('bot without channel administrator access never checks the user or grants a reward', async () => {
  const fixture = serverFixture({ telegram: (url, options, response) => url.pathname.endsWith('/getMe')
    ? response({ ok: true, result: { id: 999, is_bot: true } })
    : response({ ok: true, result: { user: { id: 999 }, status: 'member' } }) });
  const result = await fixture.request('/api/tasks/channel/claim');
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'CHANNEL_TASK_CONFIGURATION');
  assert.equal(result.body.reason, 'bot_admin_required');
  const telegramCalls = fixture.calls.filter((call) => call.url.hostname === 'api.telegram.org');
  assert.equal(telegramCalls.length, 2);
  assert.equal(telegramCalls[1].url.searchParams.get('user_id'), '999');
  assert.ok(!fixture.calls.some((call) => call.url.pathname.endsWith('account_claim_channel_task')));
  const logs = JSON.stringify(fixture.logs);
  assert.match(logs, /getChatMember/);
  assert.match(logs, /bot_admin_required/);
  assert.ok(!logs.includes('999'));
  assert.ok(!logs.includes(token));
});

test('channel claim database lookup failure records the actual method without raw messages', async () => {
  const fixture = serverFixture({ database: (path, options, body, response) => path.startsWith('promo_redemptions?') ? response({ message: 'private-user-id fixture-only-token', code: 'XX000' }, 500) : undefined });
  const result = await fixture.request('/api/tasks/channel/claim');
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.code, 'CHANNEL_TASK_CLAIM_FAILED');
  const logs = JSON.stringify(fixture.logs);
  assert.match(logs, /hasChannelTaskClaim/);
  assert.ok(!logs.includes('account_claim_channel_task'));
  assert.ok(!logs.includes('private-user-id'));
  assert.ok(!logs.includes(token));
});

test('Telegram network and timeout diagnostics never emit exception token URLs', async () => {
  for (const [name, reason] of [['Error', 'telegram_network_failure'], ['TimeoutError', 'telegram_timeout']]) {
    const fixture = serverFixture({ telegram: async () => { const error = new Error(`https://api.telegram.org/bot${token}/getMe?user_id=private-user-id`); error.name = name; throw error; } });
    const result = await fixture.request('/api/tasks/channel/status');
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.reason, reason);
    const logs = JSON.stringify(fixture.logs);
    assert.match(logs, /getMe/);
    assert.ok(!logs.includes(token));
    assert.ok(!logs.includes('private-user-id'));
  }
});

test('Telegram error diagnostics classify safe methods and reasons without descriptions or token URLs', async () => {
  for (const [status, description, code, reason] of [
    [401, 'Unauthorized fixture-only-token', 'CHANNEL_TASK_CONFIGURATION', 'bot_authentication_failed'],
    [400, 'Bad Request: chat not found private-channel-id', 'CHANNEL_TASK_CONFIGURATION', 'channel_unavailable'],
    [400, 'CHAT_ADMIN_REQUIRED private-user-id', 'CHANNEL_TASK_CONFIGURATION', 'bot_admin_required'],
    [429, 'rate limit private-user-id', 'CHANNEL_CHECK_UNAVAILABLE', 'telegram_rate_limited'],
    [500, 'server failed private-user-id', 'CHANNEL_CHECK_UNAVAILABLE', 'telegram_server_failure'],
  ]) {
    const fixture = serverFixture({ telegram: (url, options, response) => response({ ok: false, error_code: status, description, parameters: { retry_after: 3 } }, status) });
    const result = await fixture.request('/api/tasks/channel/status');
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, code);
    assert.equal(result.body.reason, reason);
    const logs = JSON.stringify(fixture.logs);
    assert.match(logs, /getMe/);
    assert.ok(!logs.includes(description));
    assert.ok(!logs.includes(token));
    assert.ok(!logs.includes('private-'));
  }
});

test('all paid plans still grant zero daily coins', () => {
  const fixture = serverFixture();
  assert.deepEqual(Object.values(fixture.hooks.TIERS).map((tier) => tier.dailyBonus), [0, 0, 0]);
});
