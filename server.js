import { createCreatorFeatures } from "./creator-features.js";
import { EMOTION_VARIANTS } from "./emotion-catalog.js";
import { stickerBackground, backgroundPrompt, normalizeSticker } from "./sticker-background.js";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import cors from "cors";
import fetch from "node-fetch";
import sharp from "sharp";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/api", accountAccessGuard);

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEN_COST_PER_IMAGE = 5;
const DEFAULT_BALANCE = 15;
const FREE_DAILY_IMAGE_LIMIT = 8;
const CHANNEL_TASK_CHAT = process.env.CHANNEL_TASK_CHAT || "@Lordeuso";
const CHANNEL_TASK_REWARD = 10;
const CHANNEL_TASK_CLAIM_CODE = "__task_channel_lordeuso";

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — добавление в стикерпак не будет работать");
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️  SUPABASE_URL/SUPABASE_KEY не заданы — баланс работать не будет");

const generatedCache = new Map();
const lastGenerationByUser = new Map();
const helpRequestWindows = new Map();
const HELP_RATE_WINDOW_MS = 60 * 60_000;
const HELP_MAX_REQUESTS_PER_WINDOW = 10;

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(20_000),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  if (!res.ok) {
    let dbError;
    try {
      dbError = JSON.parse(raw);
    } catch {
      dbError = null;
    }
    const err = new Error(dbError?.message || `Supabase error ${res.status}: ${raw.slice(0, 300)}`);
    err.status = res.status;
    err.code = dbError?.code || "SUPABASE_ERROR";
    err.dbCode = dbError?.code;
    err.details = dbError?.details;
    err.hint = dbError?.hint;
    throw err;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getOrCreateBalance(userId) {
  const row = await getOrCreateUserRow(userId);
  return row.balance;
}

async function getOrCreateUserRow(userId) {
  const rows = await supabaseRequest(`balances?user_id=eq.${userId}&select=balance`);
  if (rows && rows.length > 0) return rows[0];

  const created = await supabaseRequest(`balances?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ user_id: userId, balance: DEFAULT_BALANCE }),
  });
  if (created?.length) return created[0];

  const existing = await supabaseRequest(`balances?user_id=eq.${userId}&select=balance`);
  return existing[0];
}

async function recordActivity(userId, event) {
  try {
    await supabaseRequest("account_activity", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        event_type: event.type || "adjustment",
        delta: event.delta || 0,
        balance_after: event.balanceAfter ?? null,
        description: event.description || "",
        metadata: event.metadata || {},
      }),
    });
  } catch (err) {
    console.error("Activity history write failed:", err.message);
  }
}

async function adjustBalance(userId, delta, event = {}) {
  try {
    const balance = await supabaseRequest("rpc/account_adjust_balance", {
      method: "POST",
      body: JSON.stringify({
        p_user_id: userId,
        p_delta: delta,
        p_event_type: event.type || "adjustment",
        p_description: event.description || "",
        p_metadata: event.metadata || {},
      }),
    });
    if (!Number.isInteger(balance)) throw new Error("invalid balance response");
    return balance;
  } catch (err) {
    if (err.dbCode === "P0001" && err.message === "insufficient balance") {
      err.code = "INSUFFICIENT_BALANCE";
    }
    throw err;
  }
}
function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function freeImageClaimCode(day, slot) {
  return `__free_image_${day}_${slot}`;
}

async function getFreeDailyImageUsage(userId, day = utcDateKey()) {
  const codes = Array.from({ length: FREE_DAILY_IMAGE_LIMIT }, (_, i) => freeImageClaimCode(day, i + 1));
  const rows = await supabaseRequest(
    `promo_redemptions?user_id=eq.${userId}&code=in.(${codes.join(",")})&select=code`
  );
  return { limit: FREE_DAILY_IMAGE_LIMIT, used: rows?.length || 0 };
}

async function getFreeEmotionUsage(userId, day = utcDateKey()) {
  const rows = await supabaseRequest(
    `promo_redemptions?user_id=eq.${userId}&code=eq.${encodeURIComponent(`__free_emotions_${day}`)}&select=code&limit=1`
  );
  const used = rows?.length ? 1 : 0;
  const resetAt = new Date(`${day}T00:00:00.000Z`);
  resetAt.setUTCDate(resetAt.getUTCDate() + 1);
  return { limit: 1, used, remaining: 1 - used, available: used === 0, resetAt: resetAt.toISOString() };
}

// Claims use the unique (user_id, code) key to serialize simultaneous requests.
async function reserveFreeDailyImageSlots(userId, count, day = utcDateKey()) {
  const reserved = [];
  try {
    for (let slot = 1; slot <= FREE_DAILY_IMAGE_LIMIT && reserved.length < count; slot++) {
      const code = freeImageClaimCode(day, slot);
      const rows = await supabaseRequest("promo_redemptions?on_conflict=user_id,code", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ user_id: userId, code }),
      });
      if (rows?.length) reserved.push(code);
    }
  } catch (error) {
    // Release only inserts confirmed as ours. An ambiguous failing insert may
    // already have committed, so its slot cannot be safely attributed here.
    try { await releaseFreeDailyImageSlots(userId, reserved); } catch {
      console.error("Free image reservation cleanup failed");
    }
    throw error;
  }
  return reserved;
}

async function releaseFreeDailyImageSlots(userId, codes) {
  if (!codes?.length) return;
  await supabaseRequest(
    `promo_redemptions?user_id=eq.${userId}&code=in.(${codes.join(",")})`,
    { method: "DELETE" }
  );
}

app.post("/api/balance", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    await getOrCreateUserRow(userId);
    const isOwner = isOwnerUser(userId);

    const sub = await getOrCreateSubscription(userId);
    await maybeApplyDailyBonus(userId, sub);
    const balance = await getOrCreateBalance(userId);
    const [freeDaily, freeEmotion] = !tierConfig(sub) && !isOwner
      ? await Promise.all([getFreeDailyImageUsage(userId), getFreeEmotionUsage(userId)])
      : [null, null];

    res.json({
      balance,
      isOwner,
      premium: {
        active: isSubActive(sub),
        tier: isSubActive(sub) ? sub.tier : null,
        expiresAt: sub.expires_at,
      },
      ...(freeDaily ? { freeDaily: { ...freeDaily, remaining: Math.max(0, freeDaily.limit - freeDaily.used) } } : {}),
      freeEmotion,
    });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/history", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const items = await supabaseRequest(
      `account_activity?user_id=eq.${userId}&select=id,event_type,delta,balance_after,description,metadata,created_at&order=created_at.desc,id.desc&limit=100`
    );
    res.json({ items: items || [] });
  } catch (err) {
    console.error("Activity history fetch error:", err.message);
    res.status(500).json({ error: "could not load history" });
  }
});

async function hasChannelTaskClaim(userId) {
  const rows = await supabaseRequest(
    `promo_redemptions?user_id=eq.${userId}&code=eq.${encodeURIComponent(CHANNEL_TASK_CLAIM_CODE)}&select=code&limit=1`
  );
  return !!rows?.length;
}

let channelTaskAdminVerifiedUntil = 0;
let channelTaskAdminCheck = null;
const channelTaskMembershipChecks = new Map();

function channelTaskError(code, reason, retryAfter = 3, diagnostic = {}) {
  const error = new Error(reason);
  error.code = code;
  error.retryAfter = Math.min(60, Math.max(1, Number(retryAfter) || 3));
  error.method = diagnostic.method || "configuration";
  error.reason = diagnostic.reason || "configuration_unavailable";
  if (Number.isInteger(diagnostic.status)) error.status = diagnostic.status;
  return error;
}

// Error messages remain fixed, so fetch failures can never log a bot-token URL.
async function channelTaskTelegramRequest(method, params, deadline) {
  const failure = (code, message, reason, retryAfter = 3, status) => channelTaskError(code, message, retryAfter, { method, reason, status });
  if (!BOT_TOKEN) throw failure("CHANNEL_TASK_CONFIGURATION", "Telegram bot is not configured", "bot_not_configured");
  const query = new URLSearchParams(params);
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("CHANNEL_CHECK_UNAVAILABLE", "Telegram membership check timed out", "deadline_exceeded");
    let response;
    let payload;
    try {
      response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}?${query.toString()}`, {
        signal: AbortSignal.timeout(Math.min(4000, remaining)),
      });
      payload = await response.json();
    } catch (error) {
      if (attempt === 0 && deadline - Date.now() > 500) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      const reason = ["AbortError", "TimeoutError"].includes(error?.name) ? "telegram_timeout" : "telegram_network_failure";
      throw failure("CHANNEL_CHECK_UNAVAILABLE", "Telegram membership network request failed", reason);
    }
    if (response.ok && payload?.ok && payload.result) return payload.result;
    const status = Number(payload?.error_code) || response.status;
    const description = typeof payload?.description === "string" ? payload.description.toLowerCase() : "";
    if (status === 401) {
      throw failure("CHANNEL_TASK_CONFIGURATION", "Telegram bot authentication failed", "bot_authentication_failed", 3, status);
    }
    if (status === 403 ||
      (status === 400 && /chat not found|member list is inaccessible|chat_admin_required|not enough rights|bot.*not.*member/.test(description))) {
      const reason = /chat not found/.test(description) ? "channel_unavailable" : "bot_admin_required";
      throw failure("CHANNEL_TASK_CONFIGURATION", "Channel task requires a valid channel and bot administrator access", reason, 3, status);
    }
    const retryAfter = Math.min(60, Math.max(1, Number(payload?.parameters?.retry_after) || 3));
    const wait = status === 429 ? retryAfter * 1000 : 300;
    if ((status === 429 || status >= 500) && attempt === 0 && wait <= 1000 && deadline - Date.now() > wait) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const reason = status === 429 ? "telegram_rate_limited" : status >= 500 ? "telegram_server_failure" : "telegram_response_invalid";
    throw failure("CHANNEL_CHECK_UNAVAILABLE", status === 429 ? "Telegram membership check rate limited" : "Telegram membership check unavailable", reason, retryAfter, status);
  }
  throw failure("CHANNEL_CHECK_UNAVAILABLE", "Telegram membership check unavailable", "telegram_response_invalid");
}

async function ensureChannelTaskAdmin(deadline) {
  if (CHANNEL_TASK_CHAT.toLowerCase() !== "@lordeuso") {
    throw channelTaskError("CHANNEL_TASK_CONFIGURATION", "Channel task reward is configured for a different channel", 3, { reason: "channel_mismatch" });
  }
  if (channelTaskAdminVerifiedUntil > Date.now()) return;
  if (!channelTaskAdminCheck) {
    channelTaskAdminCheck = (async () => {
      const bot = await channelTaskTelegramRequest("getMe", {}, deadline);
      if (!bot.is_bot || !Number.isSafeInteger(bot.id)) {
        throw channelTaskError("CHANNEL_TASK_CONFIGURATION", "Telegram bot identity is invalid", 3, { method: "getMe", reason: "bot_identity_invalid" });
      }
      const membership = await channelTaskTelegramRequest("getChatMember", { chat_id: CHANNEL_TASK_CHAT, user_id: String(bot.id) }, deadline);
      if (membership?.user?.id !== bot.id || !["creator", "administrator"].includes(membership.status)) {
        throw channelTaskError("CHANNEL_TASK_CONFIGURATION", "Bot administrator access is required for channel tasks", 3, { method: "getChatMember", reason: "bot_admin_required" });
      }
      channelTaskAdminVerifiedUntil = Date.now() + 60_000;
    })();
  }
  const currentCheck = channelTaskAdminCheck;
  try { await currentCheck; } finally {
    if (channelTaskAdminCheck === currentCheck) channelTaskAdminCheck = null;
  }
}

async function verifyChannelTaskMembership(userId, { retryNotJoined = false } = {}) {
  const key = `${userId}:${retryNotJoined ? "claim" : "status"}`;
  if (channelTaskMembershipChecks.has(key)) return channelTaskMembershipChecks.get(key);
  const check = (async () => {
    const deadline = Date.now() + 10_000;
    await ensureChannelTaskAdmin(deadline);
    for (let attempt = 0; attempt < (retryNotJoined ? 2 : 1); attempt++) {
      const member = await channelTaskTelegramRequest("getChatMember", { chat_id: CHANNEL_TASK_CHAT, user_id: String(userId) }, deadline);
      if (!member?.user || member.user.id !== Number(userId)) {
        throw channelTaskError("CHANNEL_CHECK_UNAVAILABLE", "Telegram membership response identity mismatch", 3, { method: "getChatMember", reason: "member_identity_mismatch" });
      }
      if (["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && member.is_member === true)) return true;
      if (!["left", "kicked", "restricted"].includes(member.status) ||
        (member.status === "restricted" && typeof member.is_member !== "boolean")) {
        throw channelTaskError("CHANNEL_CHECK_UNAVAILABLE", "Telegram membership response status is unknown", 3, { method: "getChatMember", reason: "member_status_unknown" });
      }
      if (!retryNotJoined || attempt > 0) return false;
      // A just-completed channel join can take a moment to become visible.
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
  })();
  channelTaskMembershipChecks.set(key, check);
  try { return await check; } finally { channelTaskMembershipChecks.delete(key); }
}

function sendChannelTaskCheckError(res, error) {
  const code = error.code === "CHANNEL_TASK_CONFIGURATION" ? "CHANNEL_TASK_CONFIGURATION" : "CHANNEL_CHECK_UNAVAILABLE";
  // Only fixed classifications are logged; raw Telegram payloads and URLs may contain private data.
  console.error("Channel task verification failed:", { code, method: error.method, reason: error.reason, status: error.status });
  return res.status(503).json({ error: "membership verification unavailable", code, reason: error.reason, retryAfter: error.retryAfter || 3 });
}

app.post("/api/tasks/channel/status", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "invalid Telegram Web App data" });
    const claimed = await hasChannelTaskClaim(userId);
    if (claimed) return res.json({ claimed: true, joined: null, reward: CHANNEL_TASK_REWARD });
    const joined = await verifyChannelTaskMembership(userId);
    res.json({ claimed: false, joined, reward: CHANNEL_TASK_REWARD });
  } catch (err) {
    if (["CHANNEL_CHECK_UNAVAILABLE", "CHANNEL_TASK_CONFIGURATION"].includes(err.code)) {
      return sendChannelTaskCheckError(res, err);
    }
    console.error("Channel task status failed:", { code: "CHANNEL_TASK_STATUS_UNAVAILABLE", method: "hasChannelTaskClaim", reason: "database_request_failed" });
    return res.status(503).json({ error: "channel task status unavailable", code: "CHANNEL_TASK_STATUS_UNAVAILABLE", retryAfter: 3 });
  }
});

app.post("/api/tasks/channel/claim", async (req, res) => {
  let databaseMethod = "hasChannelTaskClaim";
  let databaseReason = "database_request_failed";
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "invalid Telegram Web App data" });
    if (await hasChannelTaskClaim(userId)) {
      return res.status(409).json({ error: "reward already claimed", code: "TASK_ALREADY_CLAIMED" });
    }
    if (!(await verifyChannelTaskMembership(userId, { retryNotJoined: true }))) {
      return res.status(403).json({ error: "join the channel first", code: "CHANNEL_NOT_JOINED" });
    }

    // Claim, credit, and ledger entry commit together. Never DELETE a claim after
    // an ambiguous network failure: the database may already have credited it.
    databaseMethod = "account_claim_channel_task";
    const result = await supabaseRequest("rpc/account_claim_channel_task", {
      method: "POST",
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (result?.code === "TASK_REWARD_EXHAUSTED") {
      return res.status(409).json({ error: "channel task reward is no longer available", code: "TASK_REWARD_EXHAUSTED" });
    }
    if (result?.code === "TASK_REWARD_UNAVAILABLE") {
      throw channelTaskError("CHANNEL_TASK_CONFIGURATION", "Channel task reward configuration is unavailable", 3, { method: "account_claim_channel_task", reason: "reward_configuration_unavailable" });
    }
    if (!result || typeof result.applied !== "boolean" || typeof result.alreadyClaimed !== "boolean" ||
      !result.claimed || !Number.isInteger(result.balance) || result.reward !== CHANNEL_TASK_REWARD ||
      (!result.applied && !result.alreadyClaimed)) {
      databaseReason = "database_response_invalid";
      throw new Error("invalid channel task reward response");
    }
    return res.json({ ok: true, balance: result.balance, reward: result.reward, alreadyClaimed: result.alreadyClaimed });
  } catch (err) {
    if (["CHANNEL_CHECK_UNAVAILABLE", "CHANNEL_TASK_CONFIGURATION"].includes(err.code)) {
      return sendChannelTaskCheckError(res, err);
    }
    console.error("Channel task claim failed:", { code: "CHANNEL_TASK_CLAIM_FAILED", method: databaseMethod, reason: databaseReason });
    return res.status(500).json({ error: "could not grant task reward", code: "CHANNEL_TASK_CLAIM_FAILED" });
  }
});

app.post("/api/balance/adjust", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const delta = Number(req.body.delta);
    if (!Number.isSafeInteger(delta) || delta === 0) {
      return res.status(400).json({ error: "delta must be a non-zero integer" });
    }

    let gameRewardClaim = null;
    if (delta > 0 && !isOwnerUser(userId)) {
      if (delta > 5) {
        return res.status(400).json({ error: "game reward cannot exceed 5" });
      }
      const today = new Date().toISOString().slice(0, 10);
      gameRewardClaim = `__game_reward_${today}`;
      const claim = await supabaseRequest(
        `promo_redemptions?on_conflict=user_id,code`,
        {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify({ user_id: userId, code: gameRewardClaim }),
        }
      );
      if (!claim?.length) {
        const balance = await getOrCreateBalance(userId);
        return res.json({ balance, rewardAlreadyClaimed: true });
      }
    }

    let balance;
    try {
      balance = await adjustBalance(userId, delta, {
        type: delta > 0 ? "reward" : "spend",
        description: delta > 0 ? "Game reward" : "Game play",
        metadata: { source: "mini_game" },
      });
    } catch (err) {
      if (gameRewardClaim) {
        try {
          await supabaseRequest(
            `promo_redemptions?user_id=eq.${userId}&code=eq.${encodeURIComponent(gameRewardClaim)}`,
            { method: "DELETE" }
          );
        } catch (cleanupError) {
          console.error("Game reward claim cleanup error:", cleanupError.message);
        }
      }
      throw err;
    }
    res.json({ balance });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ error: "insufficient balance" });
    }
    console.error("Balance adjust error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/balance/set", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    if (!isOwnerUser(userId)) return res.status(403).json({ error: "forbidden" });

    const amount = Math.round(Number(req.body.amount));
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "amount must be a non-negative number" });
    }

    await getOrCreateBalance(userId);
    const updated = await supabaseRequest(`balances?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ balance: amount }),
    });
    res.json({ balance: updated[0].balance });
  } catch (err) {
    console.error("Balance set error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

function isOwnerUser(userId) {
  const ownerId = Number(process.env.OWNER_TELEGRAM_ID);
  return Number.isSafeInteger(ownerId) && ownerId > 0 && Number(userId) === ownerId;
}

console.log(isOwnerUser(Number(process.env.OWNER_TELEGRAM_ID)) ? "[admin] owner access configured" : "[admin] owner not configured");
const moderationCache = new Map();
async function isAccountBanned(userId) {
  if (isOwnerUser(userId)) return false;
  const cached = moderationCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.banned;
  const rows = await supabaseRequest(`app_user_moderation?user_id=eq.${userId}&select=banned`);
  const banned = rows?.[0]?.banned === true;
  if (moderationCache.size >= 5000) moderationCache.delete(moderationCache.keys().next().value);
  moderationCache.set(userId, { banned, expiresAt: Date.now() + 5000 });
  return banned;
}
// Register before protected routes below; earlier balance/task routes are also
// guarded by the initial middleware delegating to this hoisted helper.
async function accountAccessGuard(req, res, next) {
  const userId = extractUserId(req.body?.initData);
  if (!userId) return next(); // Each endpoint still authenticates its own request.
  try {
    if (await isAccountBanned(userId)) return res.status(403).json({ error: "account banned", code: "ACCOUNT_BANNED" });
    return next();
  } catch {
    return res.status(503).json({ error: "account access check unavailable", code: "ACCOUNT_CHECK_UNAVAILABLE" });
  }
}
app.post("/api/admin/users", async (req, res) => {
  const actor = extractUserId(req.body.initData);
  if (!actor) return res.status(400).json({ error: "Telegram authentication required" });
  if (!isOwnerUser(actor)) return res.status(403).json({ error: "forbidden" });
  try {
    const users = await supabaseRequest("balances?select=user_id,balance&order=user_id.desc&limit=30");
    return res.json({ users: users || [], ownerUserId: actor });
  } catch { return res.status(503).json({ error: "admin data unavailable" }); }
});
app.post("/api/admin/action", async (req, res) => {
  const actor = extractUserId(req.body.initData);
  if (!actor) return res.status(400).json({ error: "Telegram authentication required" });
  if (!isOwnerUser(actor)) return res.status(403).json({ error: "forbidden" });
  const target = Number(req.body.targetUserId);
  const action = req.body.action;
  if (!Number.isSafeInteger(target) || target <= 0) return res.status(400).json({ error: "invalid target ID" });
  if (action === "ban" && isOwnerUser(target)) return res.status(400).json({ error: "owner cannot be banned" });
  try {
    if (action === "inspect") {
      const [balances, subscriptions, moderation, audit] = await Promise.all([
        supabaseRequest(`balances?user_id=eq.${target}&select=balance`),
        supabaseRequest(`subscriptions?user_id=eq.${target}&select=active,tier,expires_at`),
        supabaseRequest(`app_user_moderation?user_id=eq.${target}&select=banned,reason`),
        supabaseRequest(`app_admin_audit?target_id=eq.${target}&select=action,created_at&order=created_at.desc&limit=10`),
      ]);
      return res.json({ ok: true, targetUserId: target, exists: !!balances?.length,
        balance: balances?.[0]?.balance ?? 15, subscription: subscriptions?.[0] || null,
        banned: moderation?.[0]?.banned === true, reason: moderation?.[0]?.reason || "", audit: audit || [] });
    }
    if (!["set-balance", "grant-plan", "revoke-plan", "ban", "unban"].includes(action)) return res.status(400).json({ error: "invalid admin action" });
    const amount = action === "set-balance" ? req.body.amount : null;
    const tier = action === "grant-plan" ? req.body.tier : null;
    const days = action === "grant-plan" ? req.body.days : null;
    const reason = req.body.reason || "";
    if (typeof req.body.requestId !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(req.body.requestId) ||
      typeof reason !== "string" || reason.length > 300 ||
      (action === "set-balance" && (!Number.isInteger(amount) || amount < 0 || amount > 2147483647)) ||
      (action === "grant-plan" && (!["standard", "luxury", "ultimate"].includes(tier) || !Number.isInteger(days) || days < 1 || days > 3650))) {
      return res.status(400).json({ error: "invalid admin parameters" });
    }
    const result = await supabaseRequest("rpc/account_admin_action", { method: "POST", body: JSON.stringify({
      p_actor: actor, p_target: target, p_action: action, p_request_key: req.body.requestId,
      p_amount: amount, p_tier: tier, p_days: days, p_reason: reason,
    }) });
    if (result?.ok !== true) throw new Error("invalid admin response");
    moderationCache.delete(target);
    return res.json(result);
  } catch (err) {
    return res.status(err.code === "22023" ? 400 : 503).json({ error: "admin action not confirmed; refresh and retry the same request" });
  }
});

// ---------- Premium-подписка через Telegram Stars: Standard, Luxury и Ultimate ----------
const SUBSCRIPTION_DURATION_DAYS = 30;

const LUXURY_PROMPT_SUFFIX =
  ", premium glossy sticker finish, subtle gold rim light, extra detailed shading, polished professional look";
const STANDARD_PROMPT_SUFFIX =
  ", clean crisp sticker finish, soft shading, polished look";

// Prices round upward after the requested increase: Standard +10%,
// Luxury/Ultimate +25%. Subscriptions no longer grant daily coins.
// Provider costs and net Stars receipts determine the actual profit margin.
const TIERS = {
  standard: {
    label: "Standard",
    firstStars: 21,
    renewStars: 32,
    discountPerImage: 1,
    maxImages: 6,
    dailyBonus: 0,
    generationPauseMs: 700,
    promptSuffix: STANDARD_PROMPT_SUFFIX,
  },
  luxury: {
    label: "Luxury",
    firstStars: 65,
    renewStars: 99,
    discountPerImage: 2,
    maxImages: 10,
    dailyBonus: 0,
    generationPauseMs: 0,
    promptSuffix: LUXURY_PROMPT_SUFFIX,
  },
  ultimate: {
    label: "Ultimate",
    firstStars: 287,
    renewStars: 438,
    discountPerImage: 3,
    maxImages: 12,
    dailyBonus: 0,
    generationPauseMs: 0,
    promptSuffix: ", exclusive Ultimate sticker art, vivid jewel-tone colors, cinematic rim lighting, crisp die-cut outline, premium collectible finish",
  },
};

function subscriptionCoinPrices() {
  return Object.fromEntries(Object.entries(TIERS).map(([tier, cfg]) => [tier, cfg.renewStars * 8 * 2.5]));
}

const STICKER_ART_STYLES = {
  vector: "cute cartoon vector style, thick outline, simple flat colors",
  clay3d: "3D clay render look, sculpted rounded forms, tactile clay material, soft studio lighting, dimensional shading",
  paper: "layered paper-cut illustration, textured cut-paper shapes, subtle layered shadows",
  anime: "anime illustration, expressive character design, clean cel shading, crisp linework",
};
const creator = createCreatorFeatures({
  supabaseRequest, generatedCache, extractUserId, getBotUsername, telegramApi,
  createStickerSet, addStickerToSet, invalidateStickerSetCache, generateStickerSet,
  isAccountBanned, getOrCreateBalance, getFreeEmotionUsage, getFreeDailyImageUsage,
  isOwnerUser, TIERS, STICKER_ART_STYLES, EMOTION_VARIANTS,
});
creator.register(app);

function studioBenefitsText(tier) {
  if (tier === "ultimate") return "Темы Obsidian Observatory и Origami Atelier, 3D-look и другие стили, наборы из 2–36 эмоций одним запуском.";
  if (tier === "luxury") return "Тема Gold Atelier, 3D-look и другие стили генерации, наборы из 2–10 эмоций одним запуском.";
  if (tier === "standard") return "Наборы из 2–6 эмоций одним запуском.";
  return "Наборы из 2–8 эмоций один раз в день; общий дневной лимит — 8 стикеров.";
}

async function getOrCreateSubscription(userId) {
  const rows = await supabaseRequest(
    `subscriptions?user_id=eq.${userId}&select=user_id,active,expires_at,first_purchase_done,last_bonus_date,tier,last_coin_purchase_at`
  );
  if (rows && rows.length > 0) return rows[0];

  const created = await supabaseRequest(`subscriptions?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: userId,
      active: false,
      expires_at: null,
      first_purchase_done: false,
      tier: null,
    }),
  });
  if (created?.length) return created[0];

  const existing = await supabaseRequest(
    `subscriptions?user_id=eq.${userId}&select=user_id,active,expires_at,first_purchase_done,last_bonus_date,tier,last_coin_purchase_at`
  );
  return existing[0];
}

function isSubActive(sub) {
  return !!(sub && sub.active && sub.expires_at && new Date(sub.expires_at).getTime() > Date.now());
}

function tierConfig(sub) {
  if (!isSubActive(sub)) return null;
  return TIERS[sub.tier] || null;
}

async function maybeApplyDailyBonus() { return 0; }

app.post("/api/subscription/status", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const sub = await getOrCreateSubscription(userId);
    const bonusApplied = await maybeApplyDailyBonus(userId, sub);
    const balance = bonusApplied > 0 ? await getOrCreateBalance(userId) : undefined;
    const active = isSubActive(sub);
    const cfg = tierConfig(sub);
    const [freeDaily, freeEmotion] = !cfg && !isOwnerUser(userId)
      ? await Promise.all([getFreeDailyImageUsage(userId), getFreeEmotionUsage(userId)])
      : [null, null];

    res.json({
      active,
      tier: active ? sub.tier : null,
      expiresAt: sub.expires_at,
      pricing: {
        standard: { firstStars: TIERS.standard.firstStars, renewStars: TIERS.standard.renewStars },
        luxury: { firstStars: TIERS.luxury.firstStars, renewStars: TIERS.luxury.renewStars },
        ultimate: { firstStars: TIERS.ultimate.firstStars, renewStars: TIERS.ultimate.renewStars },
        firstPurchaseDone: !!sub.first_purchase_done,
      },
      perks: cfg
        ? {
            maxImages: cfg.maxImages,
            costPerImage: GEN_COST_PER_IMAGE - cfg.discountPerImage,
            dailyBonus: cfg.dailyBonus,
          }
        : null,
      coinPurchase: {
        prices: subscriptionCoinPrices(),
        nextAvailableAt: sub.last_coin_purchase_at
          ? await supabaseRequest('rpc/account_coin_subscription_next_date', { method: 'POST', body: JSON.stringify({ p_last_purchase: sub.last_coin_purchase_at }) })
          : null,
      },
      bonusApplied,
      ...(freeDaily ? { freeDaily: { ...freeDaily, remaining: Math.max(0, freeDaily.limit - freeDaily.used) } } : {}),
      freeEmotion,
      ...(balance !== undefined ? { balance } : {}),
    });
  } catch (err) {
    console.error("Subscription status error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/help/ask", async (req, res) => {
  const userId = extractUserId(req.body.initData);
  if (!userId) return res.status(401).json({ error: "open the app through Telegram to ask for help" });

  const question = typeof req.body.question === "string" ? req.body.question.trim() : "";
  if (question.length < 3 || question.length > 500) {
    return res.status(400).json({ error: "question must be between 3 and 500 characters" });
  }

  const now = Date.now();
  const recentRequests = (helpRequestWindows.get(userId) || []).filter((time) => now - time < HELP_RATE_WINDOW_MS);
  if (recentRequests.length >= HELP_MAX_REQUESTS_PER_WINDOW) {
    helpRequestWindows.set(userId, recentRequests);
    return res.status(429).json({ error: "AI help limit reached for this hour" });
  }
  recentRequests.push(now);
  helpRequestWindows.set(userId, recentRequests);
  if (helpRequestWindows.size > 5000) {
    for (const [id, times] of helpRequestWindows) {
      if (!times.some((time) => now - time < HELP_RATE_WINDOW_MS)) helpRequestWindows.delete(id);
      if (helpRequestWindows.size <= 4000) break;
    }
  }

  const languageNames = {
    ru: "Russian", en: "English", es: "Spanish", zh: "Simplified Chinese", hi: "Hindi",
    ar: "Arabic", pt: "Portuguese", fr: "French", ja: "Japanese", de: "German", id: "Indonesian", tr: "Turkish",
  };
  const language = languageNames[req.body.language] || "English";
  const prompt = [
    "You are the concise, friendly help assistant for Sticker Bot, a Telegram sticker-creation mini app.",
    "Answer only questions about using the app, generating stickers, sticker packs, balance, and the visible subscription terms.",
    "Do not claim you changed a user's account or payment. Never ask for passwords, bot tokens, or secret keys.",
    `Current 30-day subscription terms: ${Object.entries(TIERS).map(([tier, cfg]) => `${cfg.label}: first month ${cfg.firstStars} Stars, manual renewal ${cfg.renewStars} Stars, ${GEN_COST_PER_IMAGE - cfg.discountPerImage} balance credits per image, up to ${cfg.maxImages} images per batch${cfg.dailyBonus > 0 ? `, ${cfg.dailyBonus} daily balance credits` : ", no daily coin bonus"}`).join("; ")}.`,
    "Free accounts can generate up to eight successful images per UTC day, shared between the app, bot, and emotion jobs. They can start one emotion job per UTC day with 2–8 emotions, charged five coins per successful image; the job still requires enough remaining daily image slots. Emotion jobs allow 2–6 emotions on Standard at four coins each, 2–10 on Luxury at three coins each, and 2–36 on Ultimate at two coins each. Failed images are refunded as usual.",
    "Luxury adds the Gold Atelier interface theme and server-supported vector, clay 3D-look, paper-cut, and anime generation styles. Ultimate includes these features and two Ultimate interface themes. The existing paid emotion-set shortcut generates six static stickers with happy, sad, wow, love, angry, and wink expressions in one request, at the plan's image price.",
    "Styles control the image-generation prompt. A 3D-look sticker is a static raster illustration, not a 3D model or animated sticker. Emotion jobs use separate image generations and cannot guarantee identical character details across independently generated images. Saved recipes and favorite-pack controls are no longer part of the interface.",
    `Premium can also be purchased with coins: ${Object.entries(subscriptionCoinPrices()).map(([tier, amount]) => `${TIERS[tier].label} ${amount}`).join(", ")}, for 30 days. One coin purchase per account every three calendar months across all tiers; Stars purchases have no such cooldown. Coin prices use the regular Stars renewal price times 8 coins per Star times 2.5, without an introductory discount.`,
    `Reply in ${language}, in at most 5 short sentences. If unsure, say so and suggest the in-app tutorial or contacting the bot owner.`,
    `User question: ${question}`,
  ].join("\n\n");

  try {
    const keyParam = process.env.POLLINATIONS_KEY
      ? `?key=${encodeURIComponent(process.env.POLLINATIONS_KEY)}`
      : "";
    const response = await fetch(`https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}${keyParam}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      console.error("Mini App AI help request failed:", response.status);
      return res.status(502).json({ error: "AI help is temporarily unavailable" });
    }
    const answer = (await response.text()).trim().slice(0, 1800);
    if (!answer) return res.status(502).json({ error: "AI help returned an empty answer" });
    res.json({ answer });
  } catch (err) {
    console.error("Mini App AI help error:", err.message);
    res.status(502).json({ error: "AI help is temporarily unavailable" });
  }
});

app.post("/api/subscription/buy-coins", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    if (typeof req.body.tier !== "string" || !Object.prototype.hasOwnProperty.call(TIERS, req.body.tier)) return res.status(400).json({ error: "unknown subscription tier" });
    const cost = subscriptionCoinPrices()[req.body.tier];
    if (!Number.isSafeInteger(req.body.expectedPrice) || req.body.expectedPrice !== cost) {
      return res.status(409).json({ applied: false, code: "COIN_SUBSCRIPTION_PRICE_CHANGED", cost, quoteRequired: true });
    }
    const result = await supabaseRequest("rpc/account_buy_coin_subscription_v2", {
      method: "POST", body: JSON.stringify({ p_user_id: userId, p_tier: req.body.tier, p_expected_price: req.body.expectedPrice }),
    });
    if (!result || typeof result.applied !== "boolean") throw new Error("invalid coin purchase response");
    res.status(result.applied ? 200 : result.code === "INSUFFICIENT_BALANCE" ? 400 : 409).json(result);
  } catch (err) {
    console.error("Coin subscription error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/subscription/create-invoice", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const tier = req.body.tier;
    if (typeof tier !== "string" || !Object.prototype.hasOwnProperty.call(TIERS, tier)) {
      return res.status(400).json({ error: "unknown subscription tier" });
    }
    const cfg = TIERS[tier];

    const sub = await getOrCreateSubscription(userId);
    const isFirstPurchase = !sub.first_purchase_done;
    const stars = isFirstPurchase ? cfg.firstStars : cfg.renewStars;
    const title = sub.first_purchase_done ? `${cfg.label} — продление` : `${cfg.label} — первый месяц`;
    const priceTerms = isFirstPurchase
      ? `Первый месяц ${stars} ⭐, далее ручное продление ${cfg.renewStars} ⭐ за 30 дней.`
      : `Ручное продление на 30 дней — ${stars} ⭐.`;
    const payload = JSON.stringify({ type: "subscription", tier, userId, stars, ts: Date.now() });

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: `${cfg.label}: ${priceTerms} ${GEN_COST_PER_IMAGE - cfg.discountPerImage} монеты за картинку, до ${cfg.maxImages} картинок за раз.${cfg.dailyBonus > 0 ? ` +${cfg.dailyBonus} монеты в день.` : ""} ${studioBenefitsText(tier)}`,
        payload,
        currency: "XTR",
        prices: [{ label: title, amount: stars }],
      }),
    });
    const data = await response.json();
    if (!data.ok) return res.status(500).json({ error: data.description });

    res.json({ link: data.result, stars, tier });
  } catch (err) {
    console.error("Subscription invoice error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/promo/redeem", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const code = String(req.body.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "code is required" });
    if (code.startsWith("__")) return res.status(400).json({ error: "invalid promo code", code: "INVALID_PROMO_CODE" });

    const codes = await supabaseRequest(`promo_codes?code=eq.${encodeURIComponent(code)}&select=*`);
    if (!codes || codes.length === 0) {
      return res.status(404).json({ error: "not_found", message: "Такого промокода не существует" });
    }
    const promo = codes[0];

    if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
      return res.status(400).json({ error: "exhausted", message: "Промокод уже исчерпан" });
    }

    const already = await supabaseRequest(
      `promo_redemptions?user_id=eq.${userId}&code=eq.${encodeURIComponent(code)}&select=user_id`
    );
    if (already && already.length > 0) {
      return res.status(400).json({ error: "already_used", message: "Ты уже использовал этот промокод" });
    }

    await supabaseRequest(`promo_redemptions`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId, code }),
    });
    await supabaseRequest(`promo_codes?code=eq.${encodeURIComponent(code)}`, {
      method: "PATCH",
      body: JSON.stringify({ uses_count: promo.uses_count + 1 }),
    });

    const balance = await adjustBalance(userId, promo.amount, {
      type: "reward",
      description: "Promo code",
      metadata: { source: "promo_code" },
    });
    res.json({ balance, amount: promo.amount });
  } catch (err) {
    console.error("Promo redeem error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, count, initData } = req.body;
    let background;
    try { background = stickerBackground(req.body.background, req.body.color); } catch { return res.status(400).json({error:"invalid background",code:"INVALID_BACKGROUND"}); }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    if (prompt.length > 4000) {
      return res.status(400).json({ error: "prompt exceeds 4000 characters", code: "PROMPT_TOO_LONG" });
    }

    const userId = extractUserId(initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const sub = await getOrCreateSubscription(userId);
    const cfg = tierConfig(sub);
    const premium = !!cfg;
    const maxImages = cfg ? cfg.maxImages : FREE_DAILY_IMAGE_LIMIT;
    const costPerImage = cfg ? GEN_COST_PER_IMAGE - cfg.discountPerImage : GEN_COST_PER_IMAGE;

    const style = req.body.style ?? "vector";
    if (typeof style !== "string" || !Object.prototype.hasOwnProperty.call(STICKER_ART_STYLES, style)) {
      return res.status(400).json({ error: "unknown sticker style", code: "INVALID_STYLE" });
    }
    if (style !== "vector" && cfg !== TIERS.luxury && cfg !== TIERS.ultimate) {
      return res.status(403).json({ error: "this sticker style requires Luxury or Ultimate", code: "STYLE_TIER_REQUIRED" });
    }
    const preset = req.body.preset ?? "none";
    if (preset !== "none" && preset !== "emotions") {
      return res.status(400).json({ error: "unknown generation preset", code: "INVALID_PRESET" });
    }
    if (preset === "emotions" && !premium && !isOwnerUser(userId)) {
      return res.status(403).json({ error: "free emotion sets require the daily emotion job", code: "FREE_EMOTIONS_JOB_REQUIRED" });
    }
    if (preset === "emotions" && Number(count) !== 6) {
      return res.status(400).json({ error: "emotion sets require exactly six images", code: "INVALID_PRESET_COUNT" });
    }

    const NUM_IMAGES = preset === "emotions" ? 6 : Math.min(Math.max(parseInt(count, 10) || 4, 1), maxImages);
    const limitedFreeUser = !premium && !isOwnerUser(userId);
    const reservedSlots = limitedFreeUser ? await reserveFreeDailyImageSlots(userId, NUM_IMAGES) : [];
    const requestedImages = limitedFreeUser ? reservedSlots.length : NUM_IMAGES;
    if (requestedImages === 0) {
      const usage = await getFreeDailyImageUsage(userId);
      return res.status(429).json({ error: "daily free image limit reached", code: "DAILY_FREE_LIMIT", freeDaily: { ...usage, remaining: 0 } });
    }
    const cost = requestedImages * costPerImage;
    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(userId, -cost, {
        type: "generation",
        description: "Sticker generation",
        metadata: { count: requestedImages, costPerImage, style, preset },
      });
    } catch (err) {
      if (limitedFreeUser) await releaseFreeDailyImageSlots(userId, reservedSlots);
      if (err.code === "INSUFFICIENT_BALANCE") return res.status(400).json({ error: "insufficient balance", code: "INSUFFICIENT_BALANCE" });
      throw err;
    }
    let images;
    try {
      images = await generateStickerSet(prompt, requestedImages, (id) => `/api/image/${id}`, { cfg, style, preset, background, userId });
    } catch (err) {
      await adjustBalance(userId, cost, {
        type: "refund",
        description: "Generation failed — coins refunded",
        metadata: { count: requestedImages },
      });
      if (limitedFreeUser) await releaseFreeDailyImageSlots(userId, reservedSlots);
      throw err;
    }
    if (limitedFreeUser && images.length < reservedSlots.length) await releaseFreeDailyImageSlots(userId, reservedSlots.slice(images.length));
    if (images.length < requestedImages) balanceAfterCharge = await adjustBalance(userId, (requestedImages - images.length) * costPerImage, {
      type: "refund",
      description: "Uncreated stickers — coins refunded",
      metadata: { count: requestedImages - images.length },
    });
    if (images.length === 0) {
      const usage = limitedFreeUser ? await getFreeDailyImageUsage(userId) : null;
      return res.status(502).json({ error: "Не удалось сгенерировать ни одной картинки. Попробуй ещё раз.", balance: balanceAfterCharge, ...(usage ? { freeDaily: { ...usage, remaining: Math.max(0, usage.limit - usage.used) } } : {}) });
    }
    const freeDaily = limitedFreeUser ? await getFreeDailyImageUsage(userId) : null;
    res.json({ images, balance: balanceAfterCharge, cost: images.length * costPerImage, premium, ...(freeDaily ? { freeDaily: { ...freeDaily, remaining: Math.max(0, freeDaily.limit - freeDaily.used) } } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

async function generateStickerSet(prompt, numImages, urlBuilder, options = {}) {
  const { cfg = null, style = "vector", preset = "none", background = stickerBackground(), userId } = options;
  const requestedEmotion = typeof options.emotion === "string" ? options.emotion : options.emotion?.key;
  const canonicalEmotion = options.emotion === undefined || options.emotion === null
    ? null
    : EMOTION_VARIANTS.find((emotion) => emotion.key === requestedEmotion);
  if (options.emotion !== undefined && options.emotion !== null && !canonicalEmotion) {
    const error = new Error("unknown sticker emotion");
    error.code = "INVALID_EMOTION";
    throw error;
  }
  const stickerPrompt =
    `sticker, ${prompt.trim()}, ${STICKER_ART_STYLES[style]}, ` +
    `${backgroundPrompt(background)}, centered, high contrast` +
    (cfg ? cfg.promptSuffix : "");

  const images = [];

  for (let i = 0; i < numImages; i++) {
    try {
      const emotion = canonicalEmotion || (preset === "emotions" ? EMOTION_VARIANTS[i] : null);
      const imagePrompt = emotion
        ? `${stickerPrompt}, one recurring character matching the same original idea, ${emotion.description}`
        : stickerPrompt;
      const buffer = await generateOneImage(imagePrompt, background);
      const processed = await normalizeSticker(buffer, background);
      const id = await creator.putAsset(userId, processed);
      images.push({
        id,
        url: urlBuilder ? urlBuilder(id) : "/api/image/" + id,
        animated: false,
        ...(emotion ? { emotion: emotion.key, emoji: emotion.emoji } : {}),
      });
    } catch (err) {
      console.error(`Ошибка генерации картинки #${i}:`, err.message);
    }
    if (i < numImages - 1) {
      const pause = cfg ? cfg.generationPauseMs : 1500;
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
  }

  return images;
}

app.get("/api/image/:id", async (req, res) => {
  let buf;
  try { buf = await creator.getAsset(req.params.id); } catch { return res.status(503).send("temporarily unavailable"); }
  if (!buf) return res.status(404).send("not found");
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "private, max-age=300");
  res.set("X-Content-Type-Options", "nosniff");
  if (req.query.download) {
    res.set("Content-Disposition", `attachment; filename="sticker_${req.params.id}.png"`);
  }
  res.send(buf);
});

app.post("/api/my-packs", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const packs = await creator.accessiblePacks(userId);
    res.json({ packs: packs || [] });
  } catch (err) {
    console.error("My-packs error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

async function getOwnedStickerPack(userId, shortName) {
  if (typeof shortName !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(shortName)) return null;
  const rows = await supabaseRequest(
    `sticker_packs?user_id=eq.${userId}&short_name=eq.${encodeURIComponent(shortName)}&select=short_name,title,user_id`
  );
  return rows?.[0] || null;
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

const stickerSetCache = new Map();
const STICKER_SET_CACHE_TTL_MS = 60_000;

async function getCachedStickerSet(shortName) {
  const cached = stickerSetCache.get(shortName);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const entry = {
    expiresAt: Date.now() + STICKER_SET_CACHE_TTL_MS,
    promise: telegramApi("getStickerSet", { name: shortName }),
  };
  stickerSetCache.set(shortName, entry);
  if (stickerSetCache.size > 256) {
    const oldestShortName = stickerSetCache.keys().next().value;
    if (oldestShortName !== shortName) stickerSetCache.delete(oldestShortName);
  }
  try {
    return await entry.promise;
  } catch (err) {
    if (stickerSetCache.get(shortName) === entry) stickerSetCache.delete(shortName);
    throw err;
  }
}

function invalidateStickerSetCache(shortName) {
  stickerSetCache.delete(shortName);
}

app.post("/api/my-packs/stickers", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await creator.packAccess(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    const stickerSet = await getCachedStickerSet(pack.short_name);
    res.json({
      pack: { shortName: pack.short_name, title: stickerSet.title || pack.title, role: pack.role },
      stickers: (stickerSet.stickers || []).map((sticker) => ({
        fileId: sticker.file_id,
        fileUniqueId: sticker.file_unique_id,
        emoji: sticker.emoji || "😀",
        width: sticker.width,
        height: sticker.height,
      })),
    });
  } catch (err) {
    console.error("Pack-stickers error:", err.message);
    res.status(500).json({ error: "could not load sticker pack" });
  }
});

app.post("/api/my-packs/sticker-image", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await creator.packAccess(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    const stickerSet = await getCachedStickerSet(pack.short_name);
    const fileId = req.body.fileId;
    if (typeof fileId !== "string" || !stickerSet.stickers?.some((sticker) => sticker.file_id === fileId)) {
      return res.status(404).json({ error: "sticker not found in pack" });
    }
    const file = await telegramApi("getFile", { file_id: fileId });
    if (!file.file_path || file.file_path.includes("..")) throw new Error("invalid Telegram file path");
    const imageResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    if (!imageResponse.ok) throw new Error("could not fetch Telegram sticker image");
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) return res.status(413).end();
    res.set("Content-Type", file.file_path.endsWith(".webp") ? "image/webp" : "application/octet-stream");
    res.set("Cache-Control", "private, max-age=300");
    res.send(bytes);
  } catch (err) {
    console.error("Pack-image error:", err.message);
    res.status(500).json({ error: "could not load sticker image" });
  }
});

app.post("/api/my-packs/rename", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!pack) return res.status(404).json({ error: "pack not found" });
    if (!title || [...title].length > 64) return res.status(400).json({ error: "title must be 1 to 64 characters" });
    await telegramApi("setStickerSetTitle", { name: pack.short_name, title });
    invalidateStickerSetCache(pack.short_name);
    await supabaseRequest(`sticker_packs?user_id=eq.${userId}&short_name=eq.${encodeURIComponent(pack.short_name)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    res.json({ ok: true, title });
  } catch (err) {
    console.error("Pack-rename error:", err.message);
    res.status(500).json({ error: "could not rename sticker pack" });
  }
});

app.post("/api/my-packs/edit-sticker", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    const fileId = req.body.fileId;
    const emoji = typeof req.body.emoji === "string" ? req.body.emoji.trim() : "";
    if (!emoji || [...emoji].length > 16) return res.status(400).json({ error: "emoji is required" });
    const stickerSet = await getCachedStickerSet(pack.short_name);
    if (!stickerSet.stickers?.some((sticker) => sticker.file_id === fileId)) {
      return res.status(404).json({ error: "sticker not found in pack" });
    }
    await telegramApi("setStickerEmojiList", { sticker: fileId, emoji_list: [emoji] });
    invalidateStickerSetCache(pack.short_name);
    res.json({ ok: true, emoji });
  } catch (err) {
    console.error("Edit-sticker error:", err.message);
    res.status(500).json({ error: "could not update sticker emoji" });
  }
});

app.post("/api/my-packs/delete", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    await telegramApi("deleteStickerSet", { name: pack.short_name });
    invalidateStickerSetCache(pack.short_name);
    await supabaseRequest(`sticker_packs?user_id=eq.${userId}&short_name=eq.${encodeURIComponent(pack.short_name)}`, {
      method: "DELETE",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete-pack error:", err.message);
    res.status(500).json({ error: "could not delete sticker pack" });
  }
});

app.post("/api/my-packs/delete-sticker", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    const stickerSet = await getCachedStickerSet(pack.short_name);
    const fileId = req.body.fileId;
    if (typeof fileId !== "string" || !stickerSet.stickers?.some((sticker) => sticker.file_id === fileId)) {
      return res.status(404).json({ error: "sticker not found in pack" });
    }
    await telegramApi("deleteStickerFromSet", { sticker: fileId });
    invalidateStickerSetCache(pack.short_name);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete-sticker error:", err.message);
    res.status(500).json({ error: "could not delete sticker" });
  }
});

async function buildStickerPack(userId,packName,ids) { return creator.makePack(userId,packName,ids); }

async function generateOneImage(prompt, background = stickerBackground()) {
  const deadline = Date.now() + 45_000;
  if (process.env.POLLINATIONS_KEY) {
    try {
      return await generateViaPaidEndpoint(prompt, deadline, background);
    } catch (err) {
      console.warn("Paid image provider unavailable; trying fallback:", err.code || "IMAGE_PROVIDER_UNAVAILABLE");
    }
  }
  return generateViaFreeEndpoint(prompt, 1, 0, deadline, background);
}

function imageProviderError(status = 0) {
  const error = new Error(status ? `Sticker image provider returned HTTP ${status}` : "Sticker image provider request failed or timed out");
  error.code = status === 402 ? "IMAGE_PROVIDER_PAYMENT_REQUIRED" : "IMAGE_PROVIDER_UNAVAILABLE";
  return error;
}

async function requestImageProvider(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw imageProviderError();
  try {
    return await fetch(url, { signal: AbortSignal.timeout(Math.min(45_000, remaining)), size:8*1024*1024 });
  } catch {
    // node-fetch errors may contain the full URL, including the prompt and key.
    throw imageProviderError();
  }
}

async function imageProviderBuffer(response) {
  try {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    throw imageProviderError();
  }
}

async function generateViaPaidEndpoint(prompt, deadline = Date.now() + 45_000, background = stickerBackground()) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true&transparent=${background.mode === "transparent"}&key=${encodeURIComponent(process.env.POLLINATIONS_KEY)}`;

  const response = await requestImageProvider(url, deadline);
  if (!response.ok) {
    response.body?.destroy?.();
    throw imageProviderError(response.status);
  }
  return imageProviderBuffer(response);
}

async function generateViaFreeEndpoint(prompt, retries = 1, attempt = 0, deadline = Date.now() + 45_000, background = stickerBackground()) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true&transparent=${background.mode === "transparent"}`;

  const response = await requestImageProvider(url, deadline);
  if (!response.ok) response.body?.destroy?.();

  if ((response.status === 429 || response.status >= 500) && retries > 0) {
    const retryAfter = response.headers?.get("retry-after");
    let wait = 1000;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const dateWait = Date.parse(retryAfter) - Date.now();
      wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(dateWait) ? Math.max(0, dateWait) : 1000;
    }
    // Long rate-limit waits are returned as a failure/refund instead of tying up
    // a batch; retries never occur earlier than the provider's Retry-After.
    if (wait <= 5000 && deadline - Date.now() > wait + 1000) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      return generateViaFreeEndpoint(prompt, retries - 1, attempt + 1, deadline, background);
    }
  }

  if (!response.ok) throw imageProviderError(response.status);
  return imageProviderBuffer(response);
}

async function processToSticker(buffer) {
  return sharp(buffer)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
}

function slugify(str) {
  let slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!slug) slug = "pack";
  if (!/^[a-z]/.test(slug)) slug = "s" + slug;

  return slug;
}

function extractUserId(initData) {
  if (typeof initData !== "string" || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(authDate) || authDate > now + 30 || now - authDate > 86400) return null;

    const dataCheckString = [...params.entries()]
      .filter(([key]) => key !== "hash")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
    const receivedHash = Buffer.from(hash, "hex");
    if (receivedHash.length !== expectedHash.length || !timingSafeEqual(receivedHash, expectedHash)) return null;

    const userJson = params.get("user");
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    const userId = Number(user.id);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

let cachedBotUsername = null;
async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {signal: AbortSignal.timeout(10_000)});
  const data = await res.json();
  cachedBotUsername = data.result.username;
  return cachedBotUsername;
}

async function createStickerSet(userId, shortName, title, pngBuffer, emojis=[]) {
  const buffers=Array.isArray(pngBuffer)?pngBuffer:[pngBuffer];
  const form = new FormData();
  form.append("user_id", String(userId));
  form.append("name", shortName);
  form.append("title", title.slice(0, 64));
  form.append(
    "stickers",
    JSON.stringify(buffers.map((_,i)=>({sticker:`attach://sticker${i}`,format:"static",emoji_list:[emojis[i]||"😀"]})))
  );
  buffers.forEach((buffer,i)=>form.append(`sticker${i}`,new Blob([buffer],{type:"image/png"}),`sticker${i}.png`));

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createNewStickerSet`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API: ${data.description}`);
}

async function addStickerToSet(userId, shortName, pngBuffer) {
  const form = new FormData();
  form.append("user_id", String(userId));
  form.append("name", shortName);
  form.append(
    "sticker",
    JSON.stringify({ sticker: "attach://sticker0", format: "static", emoji_list: ["😀"] })
  );
  form.append("sticker0", new Blob([pngBuffer], { type: "image/png" }), "sticker0.png");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/addStickerToSet`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API: ${data.description}`);
}

const PORT = process.env.PORT || 3000;

const DOLLARS_PER_STAR = 8;
const MIN_AMOUNT = 10;
const MAX_AMOUNT = 10000;

const DISCOUNT_TIERS = [
  { amount: 50, discount: 0 },
  { amount: 500, discount: 0 },
  { amount: 5000, discount: 0 },
];

const STAR_PACKAGES = [
  { id: "small", amount: 50 },
  { id: "medium", amount: 500 },
  { id: "large", amount: 5000 },
];

function discountForAmount(amount) {
  if (amount <= DISCOUNT_TIERS[0].amount) return DISCOUNT_TIERS[0].discount;
  const last = DISCOUNT_TIERS[DISCOUNT_TIERS.length - 1];
  if (amount >= last.amount) return last.discount;
  for (let i = 0; i < DISCOUNT_TIERS.length - 1; i++) {
    const a = DISCOUNT_TIERS[i], b = DISCOUNT_TIERS[i + 1];
    if (amount >= a.amount && amount <= b.amount) {
      const t = (amount - a.amount) / (b.amount - a.amount);
      return a.discount + t * (b.discount - a.discount);
    }
  }
  return 0;
}

function amountToStars(amount) {
  const baseStars = amount / DOLLARS_PER_STAR;
  const discount = discountForAmount(amount);
  return Math.max(1, Math.round(baseStars * (1 - discount)));
}

app.post("/api/create-invoice", async (req, res) => {
  try {
    const { packageId, customAmount, initData } = req.body;

    let amount;
    if (customAmount) {
      amount = Math.round(Number(customAmount));
      if (!amount || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
        return res.status(400).json({ error: `amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}` });
      }
    } else {
      const pkg = STAR_PACKAGES.find((p) => p.id === packageId);
      if (!pkg) return res.status(400).json({ error: "unknown package" });
      amount = pkg.amount;
    }

    const stars = amountToStars(amount);
    const userId = extractUserId(initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const payload = JSON.stringify({ type: "balance", userId, amount, stars, ts: Date.now() });
    const title = `${amount} $`;

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: `Пополнение баланса на ${amount} $`,
        payload,
        currency: "XTR",
        prices: [{ label: title, amount: stars }],
      }),
    });
    const data = await response.json();
    if (!data.ok) return res.status(500).json({ error: data.description });

    res.json({ link: data.result, amount, stars });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

function parseInvoicePurchase(invoicePayload, currency, totalAmount, payerId) {
  let payload;
  try {
    payload = JSON.parse(invoicePayload);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Number.isSafeInteger(payload.userId) || payload.userId <= 0
    || payload.userId !== payerId
    || currency !== "XTR" || !Number.isSafeInteger(totalAmount)
    || totalAmount <= 0 || totalAmount > 2147483647) return null;

  if (payload.type === "subscription") {
    if (typeof payload.tier !== "string" || !Object.prototype.hasOwnProperty.call(TIERS, payload.tier)) return null;
    const cfg = TIERS[payload.tier];
    if (payload.stars === undefined && ![cfg.firstStars, cfg.renewStars].includes(totalAmount)) return null;
  } else if (payload.type === "balance") {
    if (!Number.isSafeInteger(payload.amount) || payload.amount < MIN_AMOUNT || payload.amount > MAX_AMOUNT) return null;
    if (payload.stars === undefined && totalAmount !== amountToStars(payload.amount)) return null;
  } else {
    return null;
  }
  // New invoices retain their quoted price. Older invoices use the current prices.
  if (payload.stars !== undefined
    && (!Number.isSafeInteger(payload.stars) || payload.stars !== totalAmount)) return null;
  return payload;
}

function parseSuccessfulPayment(message) {
  const payment = message?.successful_payment;
  const payload = parseInvoicePurchase(payment?.invoice_payload, payment?.currency,
    payment?.total_amount, message?.from?.id);
  if (!payload || typeof payment?.telegram_payment_charge_id !== "string"
    || !payment.telegram_payment_charge_id.trim()) return null;
  return { payload, payment };
}

app.post("/telegram-webhook", async (req, res) => {
  if (!TELEGRAM_WEBHOOK_SECRET) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not configured; rejecting webhook updates");
    return res.sendStatus(503);
  }
  const receivedSecret = Buffer.from(req.get("X-Telegram-Bot-Api-Secret-Token") || "");
  const expectedSecret = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
  if (receivedSecret.length !== expectedSecret.length || !timingSafeEqual(receivedSecret, expectedSecret)) {
    return res.sendStatus(401);
  }

  try {
    const update = req.body;

    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      if (typeof query.id !== "string" || !query.id) return res.sendStatus(200);
      const payload = parseInvoicePurchase(query.invoice_payload, query.currency, query.total_amount, query.from?.id);
      const answer = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: query.id,
          ok: !!payload,
          ...(!payload ? { error_message: "Счёт недействителен. Откройте приложение и создайте новый счёт." } : {}),
        }),
      });
      const answerResult = await answer.json();
      if (!answer.ok || !answerResult.ok) return res.sendStatus(500);
    }

    if (update.message?.successful_payment) {
      const purchase = parseSuccessfulPayment(update.message);
      if (!purchase) {
        console.error("Ignoring invalid successful_payment update:", update.update_id);
        return res.sendStatus(200);
      }
      const { payload, payment } = purchase;
      let result;
      try {
        result = await supabaseRequest("rpc/account_apply_payment", {
          method: "POST",
          body: JSON.stringify({
            p_user_id: payload.userId,
            p_charge_id: payment.telegram_payment_charge_id,
            p_payment_type: payload.type,
            p_amount: payload.type === "balance" ? payload.amount : null,
            p_tier: payload.type === "subscription" ? payload.tier : null,
            p_stars: payment.total_amount,
            p_duration_days: SUBSCRIPTION_DURATION_DAYS,
          }),
        });
        if (!result || typeof result.applied !== "boolean" || !Number.isInteger(result.balance)) {
          throw new Error("invalid payment processing response");
        }
      } catch (err) {
        if (err.dbCode === "22023") {
          console.error("Ignoring invalid payment details:", err.message);
          return res.sendStatus(200);
        }
        console.error("Payment database processing failed:", err.message);
        return res.sendStatus(500);
      }

      if (!result.applied) return res.sendStatus(200);
      try {
        if (payload.type === "subscription") {
          const cfg = TIERS[payload.tier];
          const expiresAt = new Date(result.expiresAt);
          console.log(`✅ ${cfg.label} активирован: user ${payload.userId}, до ${expiresAt.toISOString()}`);
          await sendTelegramMessage(
            update.message.chat.id,
            `🔴 ${cfg.label} активирован! Действует до ${expiresAt.toLocaleDateString("ru-RU")}.\n` +
              `Возможности: ${GEN_COST_PER_IMAGE - cfg.discountPerImage} монеты/картинка, до ${cfg.maxImages} за раз.${cfg.dailyBonus > 0 ? ` +${cfg.dailyBonus} монеты в день.` : ""}\n` +
              (studioBenefitsText(payload.tier) ? `${studioBenefitsText(payload.tier)}\n` : "") +
              `Продление вручную: ${cfg.renewStars} ⭐ за следующие 30 дней.`
          );
        } else {
          const newBalance = result.balance;
          console.log(`✅ Оплата зачислена: user ${payload.userId}, +${payload.amount} $ → баланс ${newBalance}`);
          await sendTelegramMessage(
            update.message.chat.id,
            `Оплата прошла успешно! Начислено +${payload.amount} $. Текущий баланс: ${newBalance} $`
          );
        }
      } catch (err) {
        console.error("Payment committed; Telegram notification failed:", err.message);
      }
      return res.sendStatus(200);
    }

    if (update.message?.text && !update.message.successful_payment) {
      await handleChatMessage(update.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(req.body?.pre_checkout_query || req.body?.message?.successful_payment ? 500 : 200);
  }
});

const MINI_APP_URL = process.env.MINI_APP_URL || "";

const WELCOME_TEXT =
  "Привет! 👋✨ Я — бот, который рисует стикеры с помощью нейросети.\n\n" +
  "🎨 <b>Как создать стикеры</b>\n" +
  "Два способа на выбор:\n" +
  "1️⃣ Кнопка меню внизу чата — там удобное приложение: выбор количества картинок, покупка $, Standard/Luxury/Ultimate подписка\n" +
  "2️⃣ Прямо тут, текстом:\n" +
  "   <code>/create гиппопотам в очках</code> — сгенерирует 4 картинки\n" +
  "   <code>/save Мои гиппопотамы</code> — сохранит их как стикерпак\n\n" +
  "💬 Не понял что-то — просто напиши мне вопрос, отвечу.\n" +
  "📋 Все команды сразу — напиши /help";

const HELP_COMMANDS_TEXT =
  "📋 <b>Все команды</b>\n\n" +
  "🎨 <b>Создание стикеров</b>\n" +
  "<code>/create описание</code> — до 4 стикеров (5 монет за картинку без подписки, с подпиской дешевле)\n" +
  "<code>/save название пака</code> — сохранить последнюю генерацию\n\n" +
  "💰 <b>Баланс</b>\n" +
  "У новых — 15 $ бесплатно. Не хватает? Купи $ за Telegram Stars в приложении, либо спроси про промокод.\n\n" +
  "Без подписки — до 8 успешно созданных стикеров в день для бота и приложения вместе, обновление в 00:00 UTC. Набор из 2–8 эмоций можно запустить один раз в день; он расходует этот же лимит и стоит 5 монет за успешный стикер.\n\n" +
  "🔴 <b>Premium (Standard / Luxury / Ultimate)</b>\n" +
  "Скидки на генерацию и больше картинок за раз. Первый месяц: Standard 21⭐, Luxury 65⭐, Ultimate 287⭐; продление вручную: 32⭐, 99⭐ и 438⭐ соответственно. Все тарифы — без ежедневных монетных подарков. Кнопка Premium — в приложении.\n" +
  "Наборы эмоций: Standard — 2–6, Luxury — 2–10, Ultimate — 2–36 за один запуск. Цена за успешный стикер: 4, 3 и 2 монеты соответственно; за несозданные картинки — возврат. Luxury: тема Gold Atelier и стили — вектор, 3D-look, бумага, аниме. Ultimate: эти возможности и темы Obsidian Observatory и Origami Atelier. 3D-look — статичная иллюстрация с объёмным видом.\n\n" +
  "Покупка на 30 дней за монеты: Standard 640, Luxury 1980, Ultimate 8760. Доступна раз в три календарных месяца на аккаунт.\n\n" +
  "🔍 <b>Где сохранённые стикеры</b>\n" +
  "Иконка стикеров в поле ввода сообщения → «Мои наборы». Управлять паками (переименовать, удалить) — через официального бота @Stickers.\n\n" +
  "❓Любой другой вопрос — просто напиши текстом, отвечу.";

const SYSTEM_CONTEXT = `Ты — дружелюбный помощник Telegram-бота для генерации стикеров нейросетью.
Есть два способа создать стикеры: 1) через мини-приложение (кнопка меню внизу чата) —
там можно выбрать количество картинок, купить $ за Stars, оформить Premium-подписку (Standard, Luxury или Ultimate);
2) прямо в чате с ботом текстовыми командами: "/create описание" генерирует 4 картинки, а
"/save название пака" сохраняет их как стикерпак. Стоимость генерации — 5 $ за картинку по умолчанию.
Новым пользователям выдаётся 15 $ бесплатно. Есть три уровня Premium-подписки через Telegram Stars:
Без подписки общий лимит — 8 успешно созданных стикеров в день для бота и приложения вместе, обновление в 00:00 UTC. Набор из 2–8 эмоций можно запустить один раз в день, он стоит 5 монет за успешную картинку и расходует тот же дневной лимит.
Standard (21⭐ первый месяц, затем 32⭐) даёт 4 монеты за картинку, до 6 картинок за раз, без ежедневных монетных подарков;
Luxury (65⭐ первый месяц, затем 99⭐) даёт 3 монеты за картинку и до 10 картинок за раз;
Ultimate (287⭐ первый месяц, затем 438⭐) даёт 2 монеты за картинку и до 12 картинок за раз.
У Luxury и Ultimate ежедневных монетных бонусов нет. Подписки вручную продлеваются раз в 30 дней.
В мини-приложении Luxury даёт тему Gold Atelier и быстрый выбор стиля генерации: вектор, 3D-look (объёмная глиняная иллюстрация), бумага и аниме.
Ultimate включает эти возможности и темы Obsidian Observatory и Origami Atelier. Наборы эмоций доступны во всех тарифах: Standard — 2–6 эмоций по 4 монеты, Luxury — 2–10 по 3 монеты, Ultimate — 2–36 по 2 монеты за успешный стикер. Пользователь вводит одну идею и выбирает количество эмоций. За несозданные картинки монеты возвращаются.
Обычные генерации по-прежнему ограничены 6, 10 и 12 картинками за раз для Standard, Luxury и Ultimate. В приложении также доступны загрузка своих PNG/JPEG/WebP, выбор фона и приглашения в общий набор. Участники добавляют, владелец управляет набором. Прозрачный фон отделяется при возможности; если отделение не удалось, картинка не засчитывается. 3D-look создаёт статичную иллюстрацию, не 3D-модель и не анимированный стикер. Независимые генерации не гарантируют полное совпадение деталей персонажа. Темы меняют интерфейс. Сохранённые шаблоны и избранные наборы убраны из интерфейса.
Подписки также можно купить за монеты в приложении: Standard 640, Luxury 1980, Ultimate 8760 на 30 дней. Покупка за монеты доступна раз в три календарных месяца на аккаунт для всех тарифов вместе; ограничение не относится к Stars.
После сохранения стикеры сразу появляются в личном списке стикерпаков в
Telegram: их можно найти через встроенный поиск стикеров в любом чате (иконка стикеров в поле ввода
сообщения → раздел "Мои наборы"), а управлять своими сохранёнными наборами можно через официального
Telegram-бота @Stickers. Если генерация не удалась — монеты за несозданные картинки возвращаются,
можно попробовать ещё раз: сервис иногда перегружен. Отвечай кратко, по-дружески, на языке вопроса пользователя (русский
или английский). Если вопрос не связан с ботом и стикерами — вежливо верни разговор к теме бота.`;

async function handleChatMessage(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text = message.text.trim();

  const packInvite=text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+pack_([A-Za-z0-9_-]{43})$/);
  if(packInvite){
    if(message.chat.type!=='private')return;
    if(await isAccountBanned(fromId)){await sendTelegramMessage(chatId,'Access restricted.');return;}
    const url=new URL(MINI_APP_URL||'https://stickersai.netlify.app/');url.searchParams.set('invite',packInvite[1]);
    await telegramApi('sendMessage',{chat_id:chatId,text:'You have been invited to a shared sticker pack. Open the app to review and join. / Вас пригласили в общий набор стикеров. Откройте приложение, чтобы вступить.',reply_markup:{inline_keyboard:[[{text:'Open shared pack / Открыть набор',web_app:{url:url.href}}]]}});
    return;
  }

  const OWNER_ID = process.env.OWNER_TELEGRAM_ID ? Number(process.env.OWNER_TELEGRAM_ID) : null;
  if (OWNER_ID && fromId === OWNER_ID) {
    const setMatch = text.match(/^\/setbalance\s+(-?\d+)$/i);
    const addMatch = text.match(/^\/addbalance\s+(-?\d+)$/i);

    if (setMatch) {
      const amount = parseInt(setMatch[1], 10);
      await supabaseRequest(`balances?user_id=eq.${fromId}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ balance: amount }),
      }).catch(async () => {
        await supabaseRequest(`balances`, {
          method: "POST",
          body: JSON.stringify({ user_id: fromId, balance: amount }),
        });
      });
      await sendTelegramMessage(chatId, `✅ Баланс установлен: ${amount} $`);
      return;
    }

    if (addMatch) {
      const delta = parseInt(addMatch[1], 10);
      const newBalance = await adjustBalance(fromId, delta, {
        type: delta > 0 ? "adjustment" : "spend",
        description: "Bot balance adjustment",
        metadata: { source: "owner_command" },
      });
      await sendTelegramMessage(chatId, `✅ Баланс изменён на ${delta > 0 ? "+" : ""}${delta}. Текущий баланс: ${newBalance} $`);
      return;
    }

    if (text === "/mybalance") {
      const balance = await getOrCreateBalance(fromId);
      await sendTelegramMessage(chatId, `Текущий баланс: ${balance} $`);
      return;
    }

    const grantMatch = text.match(/^\/grantpremium\s+(standard|luxury|ultimate)(?:\s+(\d+))?$/i);
    if (grantMatch) {
      const tier = grantMatch[1].toLowerCase();
      const days = grantMatch[2] ? parseInt(grantMatch[2], 10) : SUBSCRIPTION_DURATION_DAYS;
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const exists = await supabaseRequest(`subscriptions?user_id=eq.${fromId}&select=user_id`);
      if (exists && exists.length > 0) {
        await supabaseRequest(`subscriptions?user_id=eq.${fromId}`, {
          method: "PATCH",
          body: JSON.stringify({ active: true, expires_at: expiresAt, first_purchase_done: true, tier }),
        });
      } else {
        await supabaseRequest(`subscriptions`, {
          method: "POST",
          body: JSON.stringify({ user_id: fromId, active: true, expires_at: expiresAt, first_purchase_done: true, tier }),
        });
      }
      await sendTelegramMessage(chatId, `✅ ${TIERS[tier].label} выдан бесплатно на ${days} дн. (для тестов, без начисления Stars)`);
      return;
    }

    const promoMatch = text.match(/^\/createpromo\s+(\S+)\s+(\d+)(?:\s+(\d+))?$/i);
    if (promoMatch) {
      const code = promoMatch[1].toUpperCase();
      const amount = parseInt(promoMatch[2], 10);
      const maxUses = promoMatch[3] ? parseInt(promoMatch[3], 10) : null;

      try {
        await supabaseRequest(`promo_codes`, {
          method: "POST",
          body: JSON.stringify({ code, amount, max_uses: maxUses, uses_count: 0 }),
        });
        await sendTelegramMessage(
          chatId,
          `✅ Промокод создан: ${code}\nНачисляет: ${amount} $\nЛимит использований: ${maxUses ?? "без ограничений"}`
        );
      } catch (err) {
        await sendTelegramMessage(chatId, `Не получилось создать промокод (возможно, такой код уже существует): ${err.message}`);
      }
      return;
    }
  }

  if (text === "/start") {
    await sendTelegramMessageHTML(chatId, WELCOME_TEXT);
    return;
  }

  if (text === "/help") {
    await sendTelegramMessageHTML(chatId, HELP_COMMANDS_TEXT);
    return;
  }

  const createMatch = text.match(/^\/(create|generate)\s+([\s\S]+)$/i);
  if (createMatch) {
    if (await isAccountBanned(fromId)) {
      await sendTelegramMessage(chatId, "Access to this bot has been restricted by its owner.");
      return;
    }
    const description = createMatch[2].trim();
    if (description.length > 4000) {
      await sendTelegramMessage(chatId, "Please shorten the description to 4000 characters.");
      return;
    }
    const sub = await getOrCreateSubscription(fromId);
    const cfg = tierConfig(sub);
    const CHAT_GEN_COUNT = 4;
    const costPerImage = cfg ? GEN_COST_PER_IMAGE - cfg.discountPerImage : GEN_COST_PER_IMAGE;
    const limitedFreeUser = !cfg && !isOwnerUser(fromId);
    const reservedSlots = limitedFreeUser ? await reserveFreeDailyImageSlots(fromId, CHAT_GEN_COUNT) : [];
    const requestedImages = limitedFreeUser ? reservedSlots.length : CHAT_GEN_COUNT;
    if (requestedImages === 0) {
      await sendTelegramMessage(chatId, `На сегодня достигнут лимит: ${FREE_DAILY_IMAGE_LIMIT} стикеров для бесплатного аккаунта. Лимит общий для бота и приложения и обновляется в 00:00 UTC.`);
      return;
    }
    const cost = requestedImages * costPerImage;

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(fromId, -cost, {
        type: "generation",
        description: "Sticker generation",
        metadata: { count: requestedImages, costPerImage, source: "telegram_chat" },
      });
    } catch (err) {
      if (limitedFreeUser) await releaseFreeDailyImageSlots(fromId, reservedSlots);
      if (err.code === "INSUFFICIENT_BALANCE") {
        await sendTelegramMessage(
          chatId,
          `Не хватает $ на генерацию (нужно ${cost} $). Пополни баланс через кнопку меню — в приложении можно ` +
            `купить $ за Telegram Stars.`
        );
        return;
      }
      throw err;
    }

    let images;
    try {
      await sendTelegramMessage(chatId, `Генерирую ${requestedImages} стикера по описанию «${description}»… это может занять около минуты ✨`);
      images = await generateStickerSet(description, requestedImages, undefined, { cfg, userId: fromId });
    } catch (err) {
      await adjustBalance(fromId, cost, {
        type: "refund",
        description: "Generation failed — coins refunded",
        metadata: { count: requestedImages, source: "telegram_chat" },
      });
      if (limitedFreeUser) await releaseFreeDailyImageSlots(fromId, reservedSlots);
      throw err;
    }
    if (limitedFreeUser && images.length < reservedSlots.length) {
      await releaseFreeDailyImageSlots(fromId, reservedSlots.slice(images.length));
    }
    const refund = (requestedImages - images.length) * costPerImage;
    if (refund > 0) {
      balanceAfterCharge = await adjustBalance(fromId, refund, {
        type: "refund",
        description: "Uncreated stickers — coins refunded",
        metadata: { count: requestedImages - images.length, source: "telegram_chat" },
      });
    }

    if (images.length === 0) {
      await sendTelegramMessage(chatId, `Не получилось сгенерировать ни одной картинки — вернул ${cost} $ на баланс (сейчас ${balanceAfterCharge} $). Попробуй ещё раз.`);
      return;
    }

    lastGenerationByUser.set(fromId, { ids: images.map((i) => i.id), ts: Date.now() });
    for (const img of images) {
      const buf = await creator.getAsset(img.id, fromId);
      if (buf) await sendTelegramPhoto(chatId, buf);
    }

    await sendTelegramMessage(
      chatId,
      `Готово! Списано ${images.length * costPerImage} $ (осталось ${balanceAfterCharge} $).\n\n` +
        `Чтобы сохранить всё это в стикерпак — напиши:\n/save Название пака`
    );
    return;
  }

  const saveMatch = text.match(/^\/save\s+([\s\S]+)$/i);
  if (saveMatch) {
    const packName = saveMatch[1].trim();
    const pending = lastGenerationByUser.get(fromId);
    if (!pending || Date.now() - pending.ts > 30 * 60 * 1000) {
      await sendTelegramMessage(chatId, "Не нашёл недавно сгенерированных стикеров. Сначала используй /create <описание>.");
      return;
    }

    const packLink = await buildStickerPack(fromId, packName, pending.ids);
    if (!packLink) {
      await sendTelegramMessage(chatId, "Не получилось сохранить стикерпак. Попробуй ещё раз.");
      return;
    }

    lastGenerationByUser.delete(fromId);
    await sendTelegramMessage(
      chatId,
      `✅ Стикерпак сохранён!\n${packLink}\n\nУправлять паками (переименовать, удалить, посмотреть все) можно через официального бота @Stickers.`
    );
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });

    const fullPrompt = `${SYSTEM_CONTEXT}\n\nВопрос пользователя: ${text}`;
    const keyParam = process.env.POLLINATIONS_KEY ? `?key=${process.env.POLLINATIONS_KEY}` : "";
    const aiResponse = await fetch(
      `https://gen.pollinations.ai/text/${encodeURIComponent(fullPrompt)}${keyParam}`
    );

    if (aiResponse.status === 402) {
      await sendTelegramMessage(chatId, FALLBACK_HELP_TEXT);
      return;
    }

    const answer = (await aiResponse.text()).trim();

    await sendTelegramMessage(
      chatId,
      answer || "Не получилось сформулировать ответ, попробуй переспросить."
    );
  } catch (err) {
    console.error("Chat AI error:", err.message);
    await sendTelegramMessage(chatId, FALLBACK_HELP_TEXT);
  }
}

const FALLBACK_HELP_TEXT =
  "Сейчас не могу ответить через ИИ (сервис временно недоступен), но вот основное:\n\n" +
  "• Генерация: открой меню внизу чата или напиши «/create описание»\n" +
  "• Сохранить: выбери стикеры в приложении, или напиши «/save название» после /create\n" +
  "• Найти сохранённое: иконка стикеров в поле ввода → «Мои наборы», или бот @Stickers\n" +
  "• Не хватает $: купи за Stars или спроси про промокод";

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendTelegramMessageHTML(chatId, html) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
  });
}

async function sendTelegramPhoto(chatId, pngBuffer) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([pngBuffer], { type: "image/png" }), "sticker.png");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    body: form,
  });
}

app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(PORT, async () => {
  creator.start();
  console.log(`✅ Server running on port ${PORT}`);
  if (!BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    console.warn("Telegram webhook registration skipped: required server secrets are missing");
    return;
  }

  const publicUrl = process.env.RENDER_EXTERNAL_URL || "https://stickerbot-backend.onrender.com";
  try {
    await telegramApi("setWebhook", {
      url: new URL("/telegram-webhook", publicUrl).toString(),
      secret_token: TELEGRAM_WEBHOOK_SECRET,
    });
    console.log("Telegram webhook registered with secret validation");
  } catch (error) {
    console.error("Telegram webhook registration failed:", error.message);
  }
});
