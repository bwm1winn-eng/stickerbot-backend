import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import cors from "cors";
import fetch from "node-fetch";
import sharp from "sharp";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEN_COST_PER_IMAGE = 5;
const DEFAULT_BALANCE = 15;
const FREE_DAILY_IMAGE_LIMIT = 4;

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
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${raw.slice(0, 300)}`);
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

async function adjustBalance(userId, delta) {
  const current = await getOrCreateBalance(userId);
  const next = current + delta;
  if (next < 0) {
    const err = new Error("insufficient balance");
    err.code = "INSUFFICIENT_BALANCE";
    throw err;
  }
  const updated = await supabaseRequest(`balances?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ balance: next }),
  });
  return updated[0].balance;
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

// Claims use the unique (user_id, code) key to serialize simultaneous requests.
async function reserveFreeDailyImageSlots(userId, count, day = utcDateKey()) {
  const reserved = [];
  for (let slot = 1; slot <= FREE_DAILY_IMAGE_LIMIT && reserved.length < count; slot++) {
    const code = freeImageClaimCode(day, slot);
    const rows = await supabaseRequest("promo_redemptions?on_conflict=user_id,code", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ user_id: userId, code }),
    });
    if (rows?.length) reserved.push(code);
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
    const row = await getOrCreateUserRow(userId);
    const isOwner = isOwnerUser(userId);

    const sub = await getOrCreateSubscription(userId);
    const bonusApplied = await maybeApplyDailyBonus(userId, sub);
    const balance = bonusApplied > 0 ? await getOrCreateBalance(userId) : row.balance;
    const freeDaily = !tierConfig(sub) && !isOwner
      ? await getFreeDailyImageUsage(userId)
      : null;

    res.json({
      balance,
      isOwner,
      premium: {
        active: isSubActive(sub),
        tier: isSubActive(sub) ? sub.tier : null,
        expiresAt: sub.expires_at,
      },
      ...(freeDaily ? { freeDaily: { ...freeDaily, remaining: Math.max(0, freeDaily.limit - freeDaily.used) } } : {}),
    });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    res.status(500).json({ error: "internal error" });
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
      balance = await adjustBalance(userId, delta);
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
  const ownerId = process.env.OWNER_TELEGRAM_ID ? Number(process.env.OWNER_TELEGRAM_ID) : null;
  return ownerId !== null && Number(userId) === ownerId;
}

// ---------- Premium-подписка через Telegram Stars: Standard, Luxury и Ultimate ----------
const SUBSCRIPTION_DURATION_DAYS = 30;

const LUXURY_PROMPT_SUFFIX =
  ", premium glossy sticker finish, subtle gold rim light, extra detailed shading, polished professional look";
const STANDARD_PROMPT_SUFFIX =
  ", clean crisp sticker finish, soft shading, polished look";

// Introductory prices are about 35% below renewal. Daily credits are budgeted
// at about 30% of the nominal Star price (10 balance credits = 1 Star); this is
// a benefit budget, not a profit guarantee because provider costs and net Stars vary.
const TIERS = {
  standard: {
    label: "Standard",
    firstStars: 19,
    renewStars: 29,
    discountPerImage: 1,
    maxImages: 6,
    dailyBonus: 3,
    generationPauseMs: 700,
    promptSuffix: STANDARD_PROMPT_SUFFIX,
  },
  luxury: {
    label: "Luxury",
    firstStars: 52,
    renewStars: 79,
    discountPerImage: 2,
    maxImages: 10,
    dailyBonus: 8,
    generationPauseMs: 0,
    promptSuffix: LUXURY_PROMPT_SUFFIX,
  },
  ultimate: {
    label: "Ultimate",
    firstStars: 229,
    renewStars: 350,
    discountPerImage: 3,
    maxImages: 12,
    dailyBonus: 35,
    generationPauseMs: 0,
    promptSuffix: ", exclusive Ultimate sticker art, vivid jewel-tone colors, cinematic rim lighting, crisp die-cut outline, premium collectible finish",
  },
};

async function getOrCreateSubscription(userId) {
  const rows = await supabaseRequest(
    `subscriptions?user_id=eq.${userId}&select=user_id,active,expires_at,first_purchase_done,last_bonus_date,tier`
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
    `subscriptions?user_id=eq.${userId}&select=user_id,active,expires_at,first_purchase_done,last_bonus_date,tier`
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

async function maybeApplyDailyBonus(userId, sub) {
  const cfg = tierConfig(sub);
  if (!cfg) return 0;
  const today = new Date().toISOString().slice(0, 10);
  if (sub.last_bonus_date === today) return 0;

  await adjustBalance(userId, cfg.dailyBonus);
  await supabaseRequest(`subscriptions?user_id=eq.${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ last_bonus_date: today }),
  });
  return cfg.dailyBonus;
}

app.post("/api/subscription/status", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const sub = await getOrCreateSubscription(userId);
    const bonusApplied = await maybeApplyDailyBonus(userId, sub);
    const balance = bonusApplied > 0 ? await getOrCreateBalance(userId) : undefined;
    const active = isSubActive(sub);
    const cfg = tierConfig(sub);

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
      bonusApplied,
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

app.post("/api/subscription/create-invoice", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const tier = req.body.tier;
    if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
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
    const payload = JSON.stringify({ type: "subscription", tier, userId, ts: Date.now() });

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: `${cfg.label}: ${priceTerms} Приоритет генерации, ${GEN_COST_PER_IMAGE - cfg.discountPerImage} $ за картинку, до ${cfg.maxImages} картинок за раз, +${cfg.dailyBonus} $ в день.`,
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

    const balance = await adjustBalance(userId, promo.amount);
    res.json({ balance, amount: promo.amount });
  } catch (err) {
    console.error("Promo redeem error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, count, initData } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const userId = extractUserId(initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const sub = await getOrCreateSubscription(userId);
    const cfg = tierConfig(sub);
    const premium = !!cfg;
    const maxImages = cfg ? cfg.maxImages : 4;
    const costPerImage = cfg ? GEN_COST_PER_IMAGE - cfg.discountPerImage : GEN_COST_PER_IMAGE;

    const NUM_IMAGES = Math.min(Math.max(parseInt(count, 10) || 4, 1), maxImages);
    const limitedFreeUser = !premium && !isOwnerUser(userId);
    const reservedSlots = limitedFreeUser
      ? await reserveFreeDailyImageSlots(userId, NUM_IMAGES)
      : [];
    const requestedImages = limitedFreeUser ? reservedSlots.length : NUM_IMAGES;
    if (requestedImages === 0) {
      const usage = await getFreeDailyImageUsage(userId);
      return res.status(429).json({
        error: "daily free image limit reached",
        code: "DAILY_FREE_LIMIT",
        freeDaily: { ...usage, remaining: 0 },
      });
    }
    const cost = requestedImages * costPerImage;

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(userId, -cost);
    } catch (err) {
      if (limitedFreeUser) await releaseFreeDailyImageSlots(userId, reservedSlots);
      if (err.code === "INSUFFICIENT_BALANCE") {
        return res.status(400).json({ error: "insufficient balance", code: "INSUFFICIENT_BALANCE" });
      }
      throw err;
    }

    let images;
    try {
      images = await generateStickerSet(
        prompt,
        requestedImages,
        (id) => `${req.protocol}://${req.get("host")}/api/image/${id}`,
        { cfg }
      );
    } catch (err) {
      await adjustBalance(userId, cost);
      if (limitedFreeUser) await releaseFreeDailyImageSlots(userId, reservedSlots);
      throw err;
    }

    if (limitedFreeUser && images.length < reservedSlots.length) {
      await releaseFreeDailyImageSlots(userId, reservedSlots.slice(images.length));
    }
    if (images.length < requestedImages) {
      balanceAfterCharge = await adjustBalance(userId, (requestedImages - images.length) * costPerImage);
    }

    if (images.length === 0) {
      const usage = limitedFreeUser ? await getFreeDailyImageUsage(userId) : null;
      return res.status(502).json({
        error: "Не удалось сгенерировать ни одной картинки. Попробуй ещё раз.",
        balance: balanceAfterCharge,
        ...(usage ? { freeDaily: { ...usage, remaining: Math.max(0, usage.limit - usage.used) } } : {}),
      });
    }

    const freeDaily = limitedFreeUser ? await getFreeDailyImageUsage(userId) : null;
    res.json({
      images,
      balance: balanceAfterCharge,
      cost: images.length * costPerImage,
      premium,
      ...(freeDaily ? { freeDaily: { ...freeDaily, remaining: Math.max(0, freeDaily.limit - freeDaily.used) } } : {}),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

async function generateStickerSet(prompt, numImages, urlBuilder, options = {}) {
  const { cfg = null } = options;
  const stickerPrompt =
    `sticker, ${prompt.trim()}, cute cartoon vector style, thick outline, ` +
    `simple flat colors, white background, centered, high contrast` +
    (cfg ? cfg.promptSuffix : "");

  const images = [];

  for (let i = 0; i < numImages; i++) {
    try {
      const buffer = await generateOneImage(stickerPrompt);
      const processed = await processToSticker(buffer);
      const id = `${Date.now()}_${i}`;
      generatedCache.set(id, processed);
      images.push({
        id,
        url: urlBuilder ? urlBuilder(id) : undefined,
        animated: false,
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

app.get("/api/image/:id", (req, res) => {
  const buf = generatedCache.get(req.params.id);
  if (!buf) return res.status(404).send("not found");
  res.set("Content-Type", "image/png");
  if (req.query.download) {
    res.set("Content-Disposition", `attachment; filename="sticker_${req.params.id}.png"`);
  }
  res.send(buf);
});

app.post("/api/my-packs", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const packs = await supabaseRequest(`sticker_packs?user_id=eq.${userId}&select=short_name,title`);
    res.json({ packs: packs || [] });
  } catch (err) {
    console.error("My-packs error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

async function getOwnedStickerPack(userId, shortName) {
  if (typeof shortName !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(shortName)) return null;
  const rows = await supabaseRequest(
    `sticker_packs?user_id=eq.${userId}&short_name=eq.${encodeURIComponent(shortName)}&select=short_name,title`
  );
  return rows?.[0] || null;
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
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
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
    if (!pack) return res.status(404).json({ error: "pack not found" });
    const stickerSet = await getCachedStickerSet(pack.short_name);
    res.json({
      pack: { shortName: pack.short_name, title: stickerSet.title || pack.title },
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
    const pack = await getOwnedStickerPack(userId, req.body.shortName);
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

app.post("/api/add-to-pack", async (req, res) => {
  try {
    const { packName, targetPackShortName, stickers, initData } = req.body;
    if (!stickers?.length || (!packName && !targetPackShortName)) {
      return res.status(400).json({ error: "stickers and (packName or targetPackShortName) are required" });
    }

    const userId = extractUserId(initData);
    if (!userId) {
      return res.status(400).json({ error: "cannot determine telegram user id" });
    }

    const ids = stickers.map((s) => s.id);
    let packLink;

    if (targetPackShortName) {
      const owned = await supabaseRequest(
        `sticker_packs?user_id=eq.${userId}&short_name=eq.${encodeURIComponent(targetPackShortName)}&select=short_name`
      );
      if (!owned || owned.length === 0) {
        return res.status(403).json({ error: "pack not found or not yours" });
      }
      let addedAny = false;
      for (const id of ids) {
        const buf = generatedCache.get(id);
        if (!buf) continue;
        await addStickerToSet(userId, targetPackShortName, buf);
        addedAny = true;
      }
      if (!addedAny) return res.status(400).json({ error: "no valid stickers found" });
      invalidateStickerSetCache(targetPackShortName);
      packLink = `https://t.me/addstickers/${targetPackShortName}`;
    } else {
      packLink = await buildStickerPack(userId, packName, ids);
      if (!packLink) {
        return res.status(400).json({ error: "no valid stickers found" });
      }
    }

    res.json({ ok: true, packLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

async function buildStickerPack(userId, packName, ids) {
  const botUsername = await getBotUsername();
  const shortName = `${slugify(packName)}_${Date.now()}`.slice(0, 50) + `_by_${botUsername}`;

  let firstSticker = true;
  for (const id of ids) {
    const buf = generatedCache.get(id);
    if (!buf) continue;

    if (firstSticker) {
      await createStickerSet(userId, shortName, packName, buf);
      firstSticker = false;
    } else {
      await addStickerToSet(userId, shortName, buf);
    }
  }

  if (firstSticker) return null;

  try {
    await supabaseRequest(`sticker_packs`, {
      method: "POST",
      body: JSON.stringify({ short_name: shortName, user_id: userId, title: packName }),
    });
  } catch (err) {
    console.error("Failed to record pack in sticker_packs:", err.message);
  }

  return `https://t.me/addstickers/${shortName}`;
}

async function generateOneImage(prompt) {
  if (process.env.POLLINATIONS_KEY) {
    try {
      return await generateViaPaidEndpoint(prompt);
    } catch (err) {
      console.warn(`Платный способ не сработал (${err.message}), переключаюсь на бесплатный`);
    }
  }
  return generateViaFreeEndpoint(prompt);
}

async function generateViaPaidEndpoint(prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true&key=${process.env.POLLINATIONS_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`paid endpoint ${response.status}: ${text.slice(0, 150)}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function generateViaFreeEndpoint(prompt, retries = 3, attempt = 0) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true`;

  const response = await fetch(url);

  if ((response.status === 429 || response.status === 402) && retries > 0) {
    const wait = 12000 + attempt * 8000;
    await new Promise((r) => setTimeout(r, wait));
    return generateViaFreeEndpoint(prompt, retries - 1, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pollinations API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
  const data = await res.json();
  cachedBotUsername = data.result.username;
  return cachedBotUsername;
}

async function createStickerSet(userId, shortName, title, pngBuffer) {
  const form = new FormData();
  form.append("user_id", String(userId));
  form.append("name", shortName);
  form.append("title", title.slice(0, 64));
  form.append("sticker_format", "static");
  form.append(
    "stickers",
    JSON.stringify([{ sticker: "attach://sticker0", emoji_list: ["😀"] }])
  );
  form.append("sticker0", new Blob([pngBuffer], { type: "image/png" }), "sticker0.png");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createNewStickerSet`, {
    method: "POST",
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
    JSON.stringify({ sticker: "attach://sticker0", emoji_list: ["😀"] })
  );
  form.append("sticker0", new Blob([pngBuffer], { type: "image/png" }), "sticker0.png");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/addStickerToSet`, {
    method: "POST",
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

    const payload = JSON.stringify({ type: "balance", userId, amount, ts: Date.now() });
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
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true,
        }),
      });
    }

    if (update.message?.successful_payment) {
      const payload = JSON.parse(update.message.successful_payment.invoice_payload);
      try {
        if (payload.type === "subscription") {
          const tier = Object.prototype.hasOwnProperty.call(TIERS, payload.tier) ? payload.tier : "standard";
          const cfg = TIERS[tier];
          const sub = await getOrCreateSubscription(payload.userId);
          const sameTierStillActive = isSubActive(sub) && sub.tier === tier;
          const base = sameTierStillActive && sub.expires_at ? new Date(sub.expires_at) : new Date();
          const expiresAt = new Date(base.getTime() + SUBSCRIPTION_DURATION_DAYS * 24 * 60 * 60 * 1000);

          await supabaseRequest(`subscriptions?user_id=eq.${payload.userId}`, {
            method: "PATCH",
            body: JSON.stringify({
              active: true,
              expires_at: expiresAt.toISOString(),
              first_purchase_done: true,
              tier,
            }),
          });

          console.log(`✅ ${cfg.label} активирован: user ${payload.userId}, до ${expiresAt.toISOString()}`);
          await sendTelegramMessage(
            update.message.chat.id,
            `🔴 ${cfg.label} активирован! Действует до ${expiresAt.toLocaleDateString("ru-RU")}.\n` +
              `Плюшки: ${GEN_COST_PER_IMAGE - cfg.discountPerImage} $/картинка, до ${cfg.maxImages} за раз, +${cfg.dailyBonus} $ в день.\n` +
              `Продление вручную: ${cfg.renewStars} ⭐ за следующие 30 дней.`
          );
        } else {
          const newBalance = await adjustBalance(payload.userId, payload.amount);
          console.log(`✅ Оплата зачислена: user ${payload.userId}, +${payload.amount} $ → баланс ${newBalance}`);
          await sendTelegramMessage(
            update.message.chat.id,
            `Оплата прошла успешно! Начислено +${payload.amount} $. Текущий баланс: ${newBalance} $`
          );
        }
      } catch (err) {
        console.error("Ошибка зачисления оплаты:", err.message);
      }
    }

    if (update.message?.text && !update.message.successful_payment) {
      await handleChatMessage(update.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200);
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
  "<code>/create описание</code> — сгенерировать 4 стикера (20 $)\n" +
  "<code>/save название пака</code> — сохранить последнюю генерацию\n\n" +
  "💰 <b>Баланс</b>\n" +
  "У новых — 15 $ бесплатно. Не хватает? Купи $ за Telegram Stars в приложении, либо спроси про промокод.\n\n" +
  "🔴 <b>Premium (Standard / Luxury / Ultimate)</b>\n" +
  "Приоритет генерации, скидки, бонусы на баланс и больше картинок за раз. Первый месяц: Standard 19⭐, Luxury 52⭐, Ultimate 229⭐; продление вручную: 29⭐, 79⭐ и 350⭐ соответственно. Кнопка Premium — в приложении.\n\n" +
  "🔍 <b>Где сохранённые стикеры</b>\n" +
  "Иконка стикеров в поле ввода сообщения → «Мои наборы». Управлять паками (переименовать, удалить) — через официального бота @Stickers.\n\n" +
  "❓Любой другой вопрос — просто напиши текстом, отвечу.";

const SYSTEM_CONTEXT = `Ты — дружелюбный помощник Telegram-бота для генерации стикеров нейросетью.
Есть два способа создать стикеры: 1) через мини-приложение (кнопка меню внизу чата) —
там можно выбрать количество картинок, купить $ за Stars, оформить Premium-подписку (Standard, Luxury или Ultimate);
2) прямо в чате с ботом текстовыми командами: "/create описание" генерирует 4 картинки, а
"/save название пака" сохраняет их как стикерпак. Стоимость генерации — 5 $ за картинку по умолчанию.
Новым пользователям выдаётся 15 $ бесплатно. Есть три уровня Premium-подписки через Telegram Stars:
Standard (19⭐ первый месяц, затем 29⭐) даёт 4 $ за картинку, до 6 картинок за раз и +3 $ в день;
Luxury (52⭐ первый месяц, затем 79⭐) даёт 3 $ за картинку, до 10 картинок за раз и +8 $ в день;
Ultimate (229⭐ первый месяц, затем 350⭐) даёт 2 $ за картинку, до 12 картинок за раз,
+35 $ в день, максимальный приоритет и эксклюзивный стиль стикеров. Подписки вручную продлеваются раз в 30 дней.
После сохранения стикеры сразу появляются в личном списке стикерпаков в
Telegram: их можно найти через встроенный поиск стикеров в любом чате (иконка стикеров в поле ввода
сообщения → раздел "Мои наборы"), а управлять своими сохранёнными наборами можно через официального
Telegram-бота @Stickers. Если генерация не удалась — можно просто попробовать ещё раз, это бесплатный
сервис и иногда он перегружен. Отвечай кратко, по-дружески, на языке вопроса пользователя (русский
или английский). Если вопрос не связан с ботом и стикерами — вежливо верни разговор к теме бота.`;

async function handleChatMessage(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text = message.text.trim();

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
      const newBalance = await adjustBalance(fromId, delta);
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
    const description = createMatch[2].trim();
    const sub = await getOrCreateSubscription(fromId);
    const cfg = tierConfig(sub);
    const CHAT_GEN_COUNT = 4;
    const costPerImage = cfg ? GEN_COST_PER_IMAGE - cfg.discountPerImage : GEN_COST_PER_IMAGE;
    const cost = CHAT_GEN_COUNT * costPerImage;

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(fromId, -cost);
    } catch (err) {
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

    await sendTelegramMessage(chatId, `Генерирую ${CHAT_GEN_COUNT} стикера по описанию «${description}»… это может занять около минуты ✨`);

    const images = await generateStickerSet(description, CHAT_GEN_COUNT, undefined, { cfg });

    if (images.length === 0) {
      const refunded = await adjustBalance(fromId, cost);
      await sendTelegramMessage(chatId, `Не получилось сгенерировать ни одной картинки — вернул ${cost} $ на баланс (сейчас ${refunded} $). Попробуй ещё раз.`);
      return;
    }

    for (const img of images) {
      const buf = generatedCache.get(img.id);
      if (buf) await sendTelegramPhoto(chatId, buf);
    }

    lastGenerationByUser.set(fromId, { ids: images.map((i) => i.id), ts: Date.now() });

    await sendTelegramMessage(
      chatId,
      `Готово! Списано ${cost} $ (осталось ${balanceAfterCharge} $).\n\n` +
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
    body: form,
  });
}

app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(PORT, async () => {
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
