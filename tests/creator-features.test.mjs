import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import { EMOTION_VARIANTS } from '../emotion-catalog.js';

// Evaluate the implementation without its image-library imports, listeners, or timers.
const source = (await readFile(new URL('../creator-features.js', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '')
  .replace('export function createCreatorFeatures', 'function createCreatorFeatures');
const ID = '10000000-0000-4000-8000-000000000001';
const USER = 123;
const OWNER = 999;
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const assetId = index => (index + 1).toString(16).padStart(48, '0');
const TIERS = {
  standard: { discountPerImage: 1, generationPauseMs: 700 },
  luxury: { discountPerImage: 2, generationPauseMs: 0 },
  ultimate: { discountPerImage: 3, generationPauseMs: 0 },
};
const validStart = overrides => ({ initData: USER, requestId: ID, prompt: '  A cat  ',
  title: '  Cat collection  ', style: 'vector', count: 8, expectedCost: 40, ...overrides });

function fixture(options = {}) {
  const calls = [], generated = [], created = [], added = [], scheduled = [], routes = new Map();
  const cache = new Map(), assets = new Map(), operations = new Map(options.operations || []);
  const packs = new Map(options.packs || []), jobs = [...(options.jobs || [])];
  const queryValue = (path, key) => new URLSearchParams(path.split('?')[1] || '').get(key)?.replace(/^eq\./, '');
  const freeDaily = { limit: 8, used: 2, remaining: 6 };
  const freeEmotion = { limit: 1, used: 0, remaining: 1, available: true, resetAt: '2030-01-02T00:00:00.000Z' };
  const db = async (path, request = {}) => {
    const body = request.body ? JSON.parse(request.body) : null;
    calls.push({ path, method: request.method || 'GET', body });
    if (options.db) {
      const override = await options.db(path, request, body);
      if (override !== undefined) return override;
    }
    if (path === 'rpc/creator_job_claim') return jobs.shift() || null;
    if (path === 'rpc/creator_job_finish') return { state: body.p_state, refund: 0 };
    if (path === 'rpc/creator_job_start') return { id: body.p_id, state: 'queued', total: body.p_payload.count, cost: body.p_expected_cost, balance: 100 };
    if (path === 'rpc/creator_invite_create_v2') return { expiresAt: '2030-01-08T00:00:00Z', maxUses: 20 };
    if (path === 'rpc/creator_pack_begin') {
      operations.set(body.p_key, { payload: body.p_payload, state: 'running', result: null });
      return { claimed: true };
    }
    if (path.startsWith('subscriptions?')) return options.tier ? [{ tier: options.tier }] : [];
    if (path.startsWith('creator_jobs?')) {
      if (request.method === 'PATCH') return null;
      if (path.includes('select=state')) return [{ state: 'running' }];
      return options.statusJob ? [options.statusJob] : [];
    }
    if (path.startsWith('creator_pack_operations?')) {
      const key = queryValue(path, 'request_key');
      if (request.method === 'PATCH') {
        operations.set(key, { ...operations.get(key), ...body });
        return null;
      }
      return operations.has(key) ? [operations.get(key)] : [];
    }
    if (path.startsWith('sticker_packs?')) {
      if (request.method === 'POST') return null;
      const pack = packs.get(queryValue(path, 'short_name'));
      return pack ? [pack] : [];
    }
    if (path.startsWith('sticker_pack_members?')) {
      return options.contributor ? [{ user_id: USER, joined_at: '2030-01-01T00:00:00Z' }] : [];
    }
    if (path.startsWith('creator_assets?')) {
      const asset = assets.get(queryValue(path, 'id'));
      return asset ? [asset] : [];
    }
    if (path === 'creator_assets' && request.method === 'POST') return null;
    throw new Error('Unexpected mocked database path: ' + path);
  };
  const deps = {
    supabaseRequest: db, generatedCache: cache, TIERS,
    STICKER_ART_STYLES: { vector: 'vector', clay3d: 'clay', paper: 'paper', anime: 'anime' },
    extractUserId: value => Number.isSafeInteger(value) && value > 0 ? value : null,
    isOwnerUser: userId => userId === OWNER,
    isAccountBanned: async () => options.banned || false,
    getOrCreateBalance: async () => 100,
    getFreeDailyImageUsage: async () => clone(freeDaily),
    getFreeEmotionUsage: async () => clone(freeEmotion),
    getBotUsername: async () => 'fixture_bot',
    createStickerSet: async (...args) => { created.push(args); },
    addStickerToSet: async (...args) => { added.push(args); },
    invalidateStickerSetCache: () => {},
    telegramApi: async () => ({ stickers: [] }),
    generateStickerSet: async (prompt, count, url, settings) => {
      const index = generated.length;
      generated.push({ prompt, count, url, settings });
      if (options.failAt?.includes(index)) return [];
      const id = assetId(index);
      cache.set(id, { userId: settings.userId, buffer: Buffer.from('fixture-' + index), expiresAt: Date.now() + 60_000 });
      return [{ id, url: '/api/image/' + id, animated: false }];
    },
  };
  const stickerBackground = (mode = 'white', color = '#ffffff') => ({ mode, color });
  const sandbox = { randomBytes, randomUUID, createHash, Buffer, EMOTION_VARIANTS,
    stickerBackground, normalizeSticker: async buffer => buffer,
    console: { warn: () => {} }, setImmediate: callback => { scheduled.push(callback); },
    setInterval: () => { throw new Error('Live timers are forbidden in these fixtures'); }, __deps: deps };
  vm.runInNewContext(source + '\n__creator = createCreatorFeatures(__deps);', sandbox, { filename: 'creator-features.js' });
  const creator = sandbox.__creator;
  creator.register({ get: (path, handler) => routes.set('GET ' + path, handler), post: (path, handler) => routes.set('POST ' + path, handler) });
  const request = async (path, body, method = 'POST') => {
    const response = { statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = clone(value); return this; } };
    const handler = routes.get(method + ' ' + path);
    assert.ok(handler, 'Registered route: ' + path);
    await handler({ body }, response);
    return response;
  };
  const flush = async () => { while (scheduled.length) await scheduled.shift()(); };
  const seedAssets = (count, userId = USER) => Array.from({ length: count }, (_, index) => {
    const id = assetId(index);
    cache.set(id, { userId, buffer: Buffer.from('fixture-' + index), expiresAt: Date.now() + 60_000 });
    return { id };
  });
  return { creator, calls, cache, assets, generated, created, added, operations, request, flush, seedAssets };
}

test('queue uses the plan matching each persisted image price', async () => {
  for (const [unit, expectedTier] of [[5, null], [4, 'standard'], [3, 'luxury'], [2, 'ultimate']]) {
    const f = fixture({ jobs: [{ id: ID, user_id: USER, total: 2, unit_price: unit,
      payload: { prompt: 'A cat', title: 'Cats', style: 'vector' } }] });
    await f.request('/api/packs/jobs/status', { initData: USER });
    await f.flush();
    assert.equal(f.generated.length, 2);
    for (const attempt of f.generated) assert.equal(attempt.settings.cfg, expectedTier ? TIERS[expectedTier] : null);
    assert.deepEqual(f.generated.map(item => item.settings.emotion), ['happy', 'sad']);
  }
});

test('36-emotion queue preserves canonical order and persists partial failures', async () => {
  const f = fixture({ failAt: [1, 12, 35], jobs: [{ id: ID, user_id: USER, total: 36, unit_price: 2,
    payload: { prompt: 'A cat', title: 'Cats', style: 'clay3d' } }] });
  await f.request('/api/packs/jobs/status', { initData: USER });
  await f.flush();
  assert.equal(f.generated.length, 36);
  assert.deepEqual(f.generated.map(item => item.settings.emotion), EMOTION_VARIANTS.map(item => item.key));
  const updates = f.calls.filter(call => call.path.startsWith('creator_jobs?') && call.body?.attempted);
  const final = updates.at(-1).body;
  assert.equal(final.attempted, 36);
  assert.equal(final.images.length, 33);
  assert.deepEqual(final.images.map(item => item.emotion), EMOTION_VARIANTS.filter((_, index) => ![1, 12, 35].includes(index)).map(item => item.key));
  assert.deepEqual(final.images.map(item => item.emoji), EMOTION_VARIANTS.filter((_, index) => ![1, 12, 35].includes(index)).map(item => item.emoji));
  assert.equal(f.created[0][3].length, 33);
  assert.equal(f.created[0][4].length, 33);
  assert.equal(f.calls.find(call => call.path === 'rpc/creator_job_finish').body.p_state, 'completed');
});

test('banned accounts stop the queue before calling the provider', async () => {
  const f = fixture({ banned: true, jobs: [{ id: ID, user_id: USER, total: 2, unit_price: 5, payload: {} }] });
  await f.request('/api/packs/jobs/status', { initData: USER });
  await f.flush();
  assert.equal(f.generated.length, 0);
  assert.equal(f.calls.find(call => call.path === 'rpc/creator_job_finish').body.p_state, 'interrupted');
});

test('job status scopes reads to the caller and exposes total and actual charged amount', async () => {
  const images = [{ id: assetId(0) }, { id: assetId(1) }, { id: assetId(2) }];
  const f = fixture({ statusJob: { id: ID, state: 'running', total: 8, attempted: 4, cost: 40, unit_price: 5,
    images, payload: { secret: true }, reserved_slots: ['private'], quota_day: '2030-01-01' } });
  const response = await f.request('/api/packs/jobs/status', { initData: USER, id: ID });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.job.total, 8);
  assert.equal(response.body.job.cost, 40);
  assert.equal(response.body.job.charged, 15);
  assert.equal(response.body.job.attempted, 4);
  assert.equal(response.body.job.payload, undefined);
  assert.equal(response.body.job.reserved_slots, undefined);
  assert.equal(response.body.freeDaily.limit, 8);
  assert.equal(response.body.freeEmotion.resetAt, '2030-01-02T00:00:00.000Z');
  assert.ok(f.calls.some(call => call.path.includes(`id=eq.${ID}&user_id=eq.${USER}&select=*`)));
  const owner = fixture();
  const ownerResponse = await owner.request('/api/packs/jobs/status', { initData: OWNER });
  assert.equal(ownerResponse.body.freeDaily, null);
  assert.equal(ownerResponse.body.freeEmotion, null);
  assert.ok(!owner.calls.some(call => call.path.startsWith('subscriptions?')));
});

test('job start derives trusted owner status and normalizes its payload', async () => {
  for (const [userId, forgedOwner, expectedOwner] of [[USER, true, false], [OWNER, false, true]]) {
    const f = fixture();
    const response = await f.request('/api/packs/jobs/start', validStart({ initData: userId, owner: forgedOwner }));
    assert.equal(response.statusCode, 200);
    const payload = f.calls.find(call => call.path === 'rpc/creator_job_start').body.p_payload;
    assert.equal(payload.owner, expectedOwner);
    assert.equal(payload.prompt, 'A cat');
    assert.equal(payload.title, 'Cat collection');
    assert.equal(payload.count, 8);
    assert.equal(response.body.total, 8);
  }
});

test('job routes reject invalid counts and request UUIDs before starting work', async () => {
  for (const change of [{ count: 1 }, { count: 37 }, { count: 2.5 }, { count: '6' }, { requestId: 'not-a-uuid' }, { expectedCost: '40' }]) {
    const f = fixture();
    const response = await f.request('/api/packs/jobs/start', validStart(change));
    assert.equal(response.statusCode, 400, JSON.stringify(change));
    assert.equal(f.calls.length, 0);
  }
  for (const route of ['status', 'cancel']) {
    const f = fixture();
    const response = await f.request('/api/packs/jobs/' + route, { initData: USER, id: 'invalid' });
    assert.equal(response.statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await f.request('/api/packs/jobs/start', validStart({ initData: 'forged' }))).statusCode, 401);
});

test('database business exceptions map to semantic API codes', async () => {
  for (const [message, code] of [['free emotion limit', 'FREE_EMOTION_LIMIT'], ['daily free limit', 'DAILY_FREE_LIMIT'],
    ['insufficient balance', 'INSUFFICIENT_BALANCE'], ['job already active', 'JOB_ALREADY_ACTIVE'], ['queue full', 'QUEUE_FULL']]) {
    const f = fixture({ db: async path => { if (path === 'rpc/creator_job_start') throw Object.assign(new Error(message), { dbCode: 'P0001', code: 'P0001' }); } });
    const response = await f.request('/api/packs/jobs/start', validStart());
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, code);
  }
});

test('invite creation retains existing links by default and validates rotation types', async () => {
  for (const [rotate, expected] of [[undefined, false], [false, false], [true, true]]) {
    const f = fixture();
    const body = { initData: USER, shortName: 'cats_by_fixture_bot', ...(rotate === undefined ? {} : { rotate }) };
    const response = await f.request('/api/packs/invite', body);
    assert.equal(response.statusCode, 200);
    const call = f.calls.find(item => item.path === 'rpc/creator_invite_create_v2');
    assert.equal(call.body.p_rotate, expected);
    assert.match(call.body.p_hash, /^[a-f0-9]{64}$/);
    assert.match(response.body.link, /^https:\/\/t\.me\/fixture_bot\?start=pack_[A-Za-z0-9_-]{43}$/);
  }
  for (const rotate of ['false', 0, null, {}]) {
    const f = fixture();
    assert.equal((await f.request('/api/packs/invite', { initData: USER, shortName: 'cats', rotate })).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
});

test('explicit empty existing-pack targets are rejected', async () => {
  for (const targetPackShortName of ['', '  ', null]) {
    const f = fixture();
    const response = await f.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Cats', stickers: [{ id: assetId(0) }], targetPackShortName });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.code, 'PACK_REQUIRED');
    assert.equal(f.calls.length, 0);
    assert.equal(f.created.length, 0);
  }
});

test('completed save retries succeed after source assets expire', async () => {
  const result = { ok: true, packLink: 'https://t.me/addstickers/already_saved' };
  const f = fixture({ operations: [[ID, { payload: { ids: [assetId(0)], title: 'Cats', target: null }, state: 'completed', result }]] });
  f.cache.set(assetId(0), { userId: USER, buffer: Buffer.from('expired'), expiresAt: Date.now() - 1 });
  const response = await f.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Cats', stickers: [{ id: assetId(0) }] });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, result);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].path.startsWith('creator_pack_operations?'));
  assert.equal(f.created.length, 0);
  const reused = await f.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Other title', stickers: [{ id: assetId(0) }] });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.body.code, 'REQUEST_REUSED');
});

test('saving 36 owned assets creates a pack while 37 assets are rejected', async () => {
  const f = fixture();
  const stickers = f.seedAssets(36);
  const response = await f.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Cats', stickers });
  assert.equal(response.statusCode, 200);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0][3].length, 36);
  assert.equal(f.operations.get(ID).state, 'completed');
  const invalid = fixture();
  const invalidResponse = await invalid.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Cats', stickers: invalid.seedAssets(37) });
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalid.calls.length, 0);
});

test('pack membership controls metadata and adding 36 contributor assets', async () => {
  const name = 'shared_by_fixture_bot';
  const pack = { short_name: name, title: 'Shared cats', user_id: OWNER };
  const denied = fixture({ packs: [[name, pack]] });
  assert.equal(await denied.creator.packAccess(USER, name), null);
  const deniedResponse = await denied.request('/api/add-to-pack', { initData: USER, requestId: ID, targetPackShortName: name, stickers: denied.seedAssets(1) });
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(denied.added.length, 0);
  const contributor = fixture({ contributor: true, packs: [[name, pack]] });
  assert.equal((await contributor.creator.packAccess(USER, name)).role, 'contributor');
  assert.equal(await contributor.creator.packAccess(USER, name, true), null);
  const metadata = await contributor.request('/api/packs/members', { initData: USER, shortName: name });
  assert.equal(metadata.statusCode, 403);
  const saved = await contributor.request('/api/add-to-pack', { initData: USER, requestId: ID, targetPackShortName: name, stickers: contributor.seedAssets(36) });
  assert.equal(saved.statusCode, 200);
  assert.equal(contributor.added.length, 36);
  assert.ok(contributor.added.every(args => args[0] === OWNER && args[1] === name));
  assert.ok(contributor.calls.filter(call => call.path.startsWith('sticker_pack_members?')).length >= 37);
  const ownerMetadata = await contributor.request('/api/packs/members', { initData: OWNER, shortName: name });
  assert.equal(ownerMetadata.statusCode, 200);
});

test('assets owned by another account cannot be saved', async () => {
  const f = fixture();
  const response = await f.request('/api/add-to-pack', { initData: USER, requestId: ID, packName: 'Cats', stickers: f.seedAssets(1, OWNER) });
  assert.equal(response.statusCode, 410);
  assert.equal(f.created.length, 0);
  assert.equal(f.operations.get(ID).state, 'failed');
});
