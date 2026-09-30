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

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — добавление в стикерпак не будет работать");
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️  SUPABASE_URL/SUPABASE_KEY не заданы — баланс работать не будет");

const generatedCache = new Map();
const lastGenerationByUser = new Map();

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

app.post("/api/balance", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const row = await getOrCreateUserRow(userId);
    const isOwner = isOwnerUser(userId);

    const sub = await getOrCreateSubscription(userId);
    const bonusApplied = await maybeApplyDailyBonus(userId, sub);
    const balance = bonusApplied > 0 ? await getOrCreateBalance(userId) : row.balance;

    res.json({
      balance,
      isOwner,
      premium: {
        active: isSubActive(sub),
        tier: isSubActive(sub) ? sub.tier : null,
        expiresAt: sub.expires_at,
      },
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
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "delta must be a non-zero number" });
    }
    if (delta > 0 && !isOwnerUser(userId)) {
      return res.status(403).json({ error: "forbidden" });
    }
    const balance = await adjustBalance(userId, delta);
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

// ---------- Premium-подписка через Telegram Stars: два уровня, Standard и Luxury ----------
const SUBSCRIPTION_FIRST_PRICE_STARS = 1;
const SUBSCRIPTION_DURATION_DAYS = 30;

const LUXURY_PROMPT_SUFFIX =
  ", premium glossy sticker finish, subtle gold rim light, extra detailed shading, polished professional look";
const STANDARD_PROMPT_SUFFIX =
  ", clean crisp sticker finish, soft shading, polished look";

const TIERS = {
  standard: {
    label: "Standard",
    renewStars: 30,
    discountPerImage: 1,
    maxImages: 6,
    dailyBonus: 10,
    generationPauseMs: 700,
    promptSuffix: STANDARD_PROMPT_SUFFIX,
  },
  luxury: {
    label: "Luxury",
    renewStars: 75,
    discountPerImage: 3,
    maxImages: 10,
    dailyBonus: 30,
    generationPauseMs: 0,
    promptSuffix: LUXURY_PROMPT_SUFFIX,
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
        standard: { firstStars: SUBSCRIPTION_FIRST_PRICE_STARS, renewStars: TIERS.standard.renewStars },
        luxury: { firstStars: SUBSCRIPTION_FIRST_PRICE_STARS, renewStars: TIERS.luxury.renewStars },
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

app.post("/api/subscription/create-invoice", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const tier = req.body.tier === "luxury" ? "luxury" : "standard";
    const cfg = TIERS[tier];

    const sub = await getOrCreateSubscription(userId);
    const stars = sub.first_purchase_done ? cfg.renewStars : SUBSCRIPTION_FIRST_PRICE_STARS;
    const title = sub.first_purchase_done ? `${cfg.label} — продление` : `${cfg.label} — первый месяц`;
    const payload = JSON.stringify({ type: "subscription", tier, userId, ts: Date.now() });

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: `${cfg.label}-подписка на ${SUBSCRIPTION_DURATION_DAYS} дней: приоритет генерации, ${GEN_COST_PER_IMAGE - cfg.discountPerImage} $ за картинку, до ${cfg.maxImages} картинок за раз, +${cfg.dailyBonus} $ в день.`,
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
    const cost = NUM_IMAGES * costPerImage;

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(userId, -cost);
    } catch (err) {
      if (err.code === "INSUFFICIENT_BALANCE") {
        return res.status(400).json({ error: "insufficient balance", code: "INSUFFICIENT_BALANCE" });
      }
      throw err;
    }

    const images = await generateStickerSet(
      prompt,
      NUM_IMAGES,
      (id) => `${req.protocol}://${req.get("host")}/api/image/${id}`,
      { cfg }
    );

    if (images.length === 0) {
      const refunded = await adjustBalance(userId, cost);
      return res.status(502).json({
        error: "Не удалось сгенерировать ни одной картинки. Попробуй ещё раз.",
        balance: refunded,
      });
    }

    res.json({ images, balance: balanceAfterCharge, cost, premium });
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

const DOLLARS_PER_STAR = 10;
const MIN_AMOUNT = 10;
const MAX_AMOUNT = 10000;

const DISCOUNT_TIERS = [
  { amount: 50, discount: 0 },
  { amount: 500, discount: 0.08 },
  { amount: 5000, discount: 0.15 },
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
          const tier = payload.tier === "luxury" ? "luxury" : "standard";
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
              `Плюшки: ${GEN_COST_PER_IMAGE - cfg.discountPerImage} $/картинка, до ${cfg.maxImages} за раз, +${cfg.dailyBonus} $ в день.`
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
  "1️⃣ Кнопка меню внизу чата — там удобное приложение: выбор количества картинок, покупка $, Standard/Luxury подписка\n" +
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
  "🔴 <b>Premium (Standard / Luxury)</b>\n" +
  "Приоритет генерации, скидка на картинки, больше картинок за раз, ежедневный бонус $, уникальный стиль. " +
  "Первый месяц любого уровня — 1⭐. Кнопка Premium — в приложении.\n\n" +
  "🔍 <b>Где сохранённые стикеры</b>\n" +
  "Иконка стикеров в поле ввода сообщения → «Мои наборы». Управлять паками (переименовать, удалить) — через официального бота @Stickers.\n\n" +
  "❓Любой другой вопрос — просто напиши текстом, отвечу.";

const SYSTEM_CONTEXT = `Ты — дружелюбный помощник Telegram-бота для генерации стикеров нейросетью.
Есть два способа создать стикеры: 1) через мини-приложение (кнопка меню внизу чата) —
там можно выбрать количество картинок, купить $ за Stars, оформить Premium-подписку (Standard или Luxury);
2) прямо в чате с ботом текстовыми командами: "/create описание" генерирует 4 картинки, а
"/save название пака" сохраняет их как стикерпак. Стоимость генерации — 5 $ за картинку по умолчанию.
Новым пользователям выдаётся 15 $ бесплатно. Есть два уровня Premium-подписки через Telegram Stars,
у обоих первый месяц стоит всего 1 звезду: Standard (продление 30⭐) даёт 4 $ за картинку, до 6 картинок
за раз, +10 $ в день и приоритет генерации; Luxury (продление 75⭐) даёт 2 $ за картинку, до 10 картинок
за раз, +30 $ в день, максимальный приоритет без пауз и эксклюзивный премиум-стиль стикеров (глянцевая
отделка, золотой контур). После сохранения стикеры сразу появляются в личном списке стикерпаков в
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

    const grantMatch = text.match(/^\/grantpremium\s+(standard|luxury)(?:\s+(\d+))?$/i);
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

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
