import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import sharp from "sharp";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEN_COST_PER_IMAGE = 5;
const DEFAULT_BALANCE = 15;

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — добавление в стикерпак не будет работать");
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️  SUPABASE_URL/SUPABASE_KEY не заданы — баланс работать не будет");

// In-memory хранилище последних сгенерированных картинок (для демо; на проде лучше в БД/S3)
const generatedCache = new Map();
// Последняя генерация каждого пользователя через чат (для команды /save) — user_id -> { ids, ts }
const lastGenerationByUser = new Map();

// ---------- Баланс пользователя: хранится в Supabase, привязан к Telegram user_id ----------

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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getOrCreateBalance(userId) {
  const rows = await supabaseRequest(`balances?user_id=eq.${userId}&select=balance`);
  if (rows && rows.length > 0) return rows[0].balance;

  const created = await supabaseRequest(`balances`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, balance: DEFAULT_BALANCE }),
  });
  return created[0].balance;
}

/**
 * Атомарно (насколько возможно без транзакций) меняет баланс на delta (может быть отрицательным).
 * Возвращает новый баланс. Бросает ошибку, если средств не хватает (delta < 0 и итог был бы < 0).
 */
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

/**
 * GET/POST /api/balance
 * body: { initData }
 * Возвращает текущий баланс пользователя (создаёт запись с 15 $, если это первый визит).
 */
app.post("/api/balance", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const balance = await getOrCreateBalance(userId);
    res.json({ balance });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
});

/**
 * POST /api/balance/adjust
 * body: { initData, delta }
 * Меняет баланс пользователя на delta (например -5 за генерацию, +3 за игру, +50 за покупку).
 */
app.post("/api/balance/adjust", async (req, res) => {
  try {
    const userId = extractUserId(req.body.initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });
    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "delta must be a non-zero number" });
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

/**
 * POST /api/generate
 * body: { prompt, style: "static"|"animated", initData }
 * Генерирует несколько картинок через Hugging Face Inference API.
 */
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, count, initData } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const userId = extractUserId(initData);
    if (!userId) return res.status(400).json({ error: "cannot determine telegram user id" });

    const NUM_IMAGES = Math.min(Math.max(parseInt(count, 10) || 4, 1), 4);
    const cost = NUM_IMAGES * GEN_COST_PER_IMAGE; // 1=5$, 2=10$, 3=15$, 4=20$

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(userId, -cost);
    } catch (err) {
      if (err.code === "INSUFFICIENT_BALANCE") {
        return res.status(400).json({ error: "insufficient balance", code: "INSUFFICIENT_BALANCE" });
      }
      throw err;
    }

    const images = await generateStickerSet(prompt, NUM_IMAGES, (id) => `${req.protocol}://${req.get("host")}/api/image/${id}`);

    if (images.length === 0) {
      // Ни одна картинка не получилась — возвращаем деньги на баланс
      const refunded = await adjustBalance(userId, cost);
      return res.status(502).json({
        error: "Не удалось сгенерировать ни одной картинки. Попробуй ещё раз.",
        balance: refunded,
      });
    }

    res.json({ images, balance: balanceAfterCharge, cost });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

/**
 * Генерирует набор стикеров (общая логика для мини-приложения и генерации через чат).
 * urlBuilder — необязательная функция (id) => url, если нужны публичные ссылки на картинки.
 * Возвращает массив { id, url?, animated }.
 */
async function generateStickerSet(prompt, numImages, urlBuilder) {
  const stickerPrompt =
    `sticker, ${prompt.trim()}, cute cartoon vector style, thick outline, ` +
    `simple flat colors, white background, centered, high contrast`;

  const images = [];

  // Генерируем последовательно с паузой — у Pollinations.ai лимит для анонимных
  // запросов примерно 1 запрос в 15 секунд
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
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return images;
}

/**
 * Отдаёт закешированную картинку по id
 */
app.get("/api/image/:id", (req, res) => {
  const buf = generatedCache.get(req.params.id);
  if (!buf) return res.status(404).send("not found");
  res.set("Content-Type", "image/png");
  res.send(buf);
});

/**
 * POST /api/add-to-pack
 * body: { packName, stickers: [{id}], initData }
 * Создаёт (или дополняет) стикерпак пользователя через Telegram Bot API.
 */
app.post("/api/add-to-pack", async (req, res) => {
  try {
    const { packName, stickers, initData } = req.body;
    if (!packName || !stickers?.length) {
      return res.status(400).json({ error: "packName and stickers are required" });
    }

    const userId = extractUserId(initData);
    if (!userId) {
      return res.status(400).json({ error: "cannot determine telegram user id" });
    }

    const ids = stickers.map((s) => s.id);
    const packLink = await buildStickerPack(userId, packName, ids);
    if (!packLink) {
      return res.status(400).json({ error: "no valid stickers found" });
    }

    res.json({ ok: true, packLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

/**
 * Общая логика создания стикерпака из массива id закешированных картинок.
 * Используется и мини-приложением, и генерацией прямо в чате с ботом.
 * Возвращает ссылку на пак, либо null, если не нашлось ни одной валидной картинки.
 */
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
  return `https://t.me/addstickers/${shortName}`;
}

// ---------- Helpers ----------

async function generateOneImage(prompt, retries = 2, attempt = 0) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const keyParam = process.env.POLLINATIONS_KEY ? `&key=${process.env.POLLINATIONS_KEY}` : "";
  // Используем авторизованный endpoint — быстрее и без общей очереди с чужими IP
  const url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true${keyParam}`;

  const response = await fetch(url);

  if (response.status === 429 && retries > 0) {
    const wait = 5000 + attempt * 5000;
    await new Promise((r) => setTimeout(r, wait));
    return generateOneImage(prompt, retries - 1, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pollinations API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function processToSticker(buffer) {
  // Приводим к требованиям Telegram: PNG, одна сторона = 512px
  return sharp(buffer)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
}

function slugify(str) {
  // Telegram требует: short_name состоит ТОЛЬКО из латинских букв, цифр и подчёркиваний,
  // и обязательно начинается с буквы. Кириллица и любые другие символы сюда не годятся —
  // название на русском, которое видит пользователь, никак не страдает,
  // это чисто техническое имя "под капотом".
  let slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!slug) slug = "pack";
  if (!/^[a-z]/.test(slug)) slug = "s" + slug; // должно начинаться с буквы

  return slug;
}

function extractUserId(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get("user");
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    return user.id;
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
/**
 * Курс обмена: сколько $ начисляется за 1 Telegram Star.
 * Сейчас: 1 звезда = 10 $. Пакеты ниже — просто готовые варианты для быстрого выбора,
 * а /api/create-invoice поддерживает и произвольную сумму (10–10000 $).
 */
const DOLLARS_PER_STAR = 10;
const MIN_AMOUNT = 10;
const MAX_AMOUNT = 10000;

const STAR_PACKAGES = [
  { id: "small", amount: 50 },   // 5 ⭐
  { id: "large", amount: 500 },  // 50 ⭐
];

function amountToStars(amount) {
  return Math.max(1, Math.round(amount / DOLLARS_PER_STAR));
}

/**
 * POST /api/create-invoice
 * body: { packageId?, customAmount?, initData }
 * Создаёт ссылку на оплату через Telegram Stars.
 * Либо передай packageId (готовый пакет), либо customAmount (своя сумма 10–10000).
 */
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

    const payload = JSON.stringify({ userId, amount, ts: Date.now() });
    const title = `${amount} $`;

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: `Пополнение баланса на ${amount} $`,
        payload,
        currency: "XTR", // код валюты для Telegram Stars
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

/**
 * POST /telegram-webhook
 * Обязательный endpoint для приёма событий от Telegram: подтверждение оплаты
 * (pre_checkout_query) и уведомление об успешной оплате (successful_payment).
 */
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.pre_checkout_query) {
      // Telegram спрашивает разрешения провести платёж — подтверждаем
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
        const newBalance = await adjustBalance(payload.userId, payload.amount);
        console.log(`✅ Оплата зачислена: user ${payload.userId}, +${payload.amount} $ → баланс ${newBalance}`);
        await sendTelegramMessage(
          update.message.chat.id,
          `Оплата прошла успешно! Начислено +${payload.amount} $. Текущий баланс: ${newBalance} $`
        );
      } catch (err) {
        console.error("Ошибка зачисления оплаты:", err.message);
      }
    }

    // Обычные текстовые сообщения в чате с ботом (не в мини-аппе)
    if (update.message?.text && !update.message.successful_payment) {
      await handleChatMessage(update.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200); // Telegram не любит, когда webhook отвечает ошибкой
  }
});

const MINI_APP_URL = process.env.MINI_APP_URL || "";

const SYSTEM_CONTEXT = `Ты — дружелюбный помощник Telegram-бота для генерации стикеров нейросетью.
Есть два способа создать стикеры: 1) через мини-приложение (кнопка меню внизу чата) —
там можно выбрать количество картинок (1-4), играть в мини-игру за $, покупать $ за Stars;
2) прямо в чате с ботом текстовыми командами: "/create описание" (например "/create гиппопотам
в очках") генерирует 4 картинки и присылает их в чат, а дальше команда "/save название пака"
сохраняет их как стикерпак. Стоимость генерации — 5 $ за одну картинку (то есть 4 картинки = 20 $).
Новым пользователям выдаётся 15 $ бесплатно. Если $ не хватает — можно сыграть в мини-игру
"Найди пары" в приложении (тап по баланс) или купить $ за Telegram Stars прямо в приложении.
После сохранения стикеры сразу появляются в личном списке стикерпаков в Telegram: их можно найти
через встроенный поиск стикеров в любом чате (иконка стикеров в поле ввода сообщения → раздел
"Мои наборы"), а управлять своими сохранёнными наборами (переименовать, удалить, посмотреть все)
можно через официального Telegram-бота @Stickers — это встроенный сервис самого
Telegram для администрирования стикерпаков, не наш бот, но он показывает все паки
пользователя, включая созданные через нас. Если генерация не удалась — можно просто попробовать ещё раз,
это бесплатный сервис и иногда он перегружен. Отвечай кратко, по-дружески,
на языке вопроса пользователя (русский или английский). Если вопрос не связан
с ботом и стикерами — вежливо верни разговор к теме бота.`;

async function handleChatMessage(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text = message.text.trim();

  // Секретные админ-команды — работают только для владельца (по Telegram ID),
  // никому больше не видны и не доступны, не упоминаются в подсказках/справке.
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
        // записи ещё нет — создаём
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
  }

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "Привет! 👋 Я помогаю создавать стикеры с помощью нейросети.\n\n" +
        "Два способа:\n" +
        "• Открой кнопку меню внизу чата — там удобное приложение с выбором количества картинок, играми и покупкой $\n" +
        "• Или прямо тут в чате: напиши «/create описание», например «/create гиппопотам в очках», а потом «/save название» чтобы сохранить\n\n" +
        "Если что-то не понятно — просто напиши мне вопрос прямо тут, отвечу."
    );
    return;
  }

  const createMatch = text.match(/^\/(create|generate)\s+([\s\S]+)$/i);
  if (createMatch) {
    const description = createMatch[2].trim();
    const CHAT_GEN_COUNT = 4;
    const cost = CHAT_GEN_COUNT * GEN_COST_PER_IMAGE;

    let balanceAfterCharge;
    try {
      balanceAfterCharge = await adjustBalance(fromId, -cost);
    } catch (err) {
      if (err.code === "INSUFFICIENT_BALANCE") {
        await sendTelegramMessage(
          chatId,
          `Не хватает $ на генерацию (нужно ${cost} $). Пополни баланс через кнопку меню — в приложении можно ` +
            `сыграть в мини-игру или купить $ за Telegram Stars.`
        );
        return;
      }
      throw err;
    }

    await sendTelegramMessage(chatId, `Генерирую ${CHAT_GEN_COUNT} стикера по описанию «${description}»… это может занять около минуты ✨`);

    const images = await generateStickerSet(description, CHAT_GEN_COUNT);

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
    const answer = (await aiResponse.text()).trim();

    await sendTelegramMessage(
      chatId,
      answer || "Не получилось сформулировать ответ, попробуй переспросить."
    );
  } catch (err) {
    console.error("Chat AI error:", err.message);
    await sendTelegramMessage(
      chatId,
      "Что-то пошло не так с ответом. Попробуй ещё раз чуть позже 🙏"
    );
  }
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
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

// Простой health-check адрес — для внешнего "будильника" (UptimeRobot и т.п.),
// чтобы бесплатный сервер на Render не засыпал от бездействия
app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
