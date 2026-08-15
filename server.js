import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import sharp from "sharp";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — добавление в стикерпак не будет работать");

// In-memory хранилище последних сгенерированных картинок (для демо; на проде лучше в БД/S3)
const generatedCache = new Map();

/**
 * POST /api/generate
 * body: { prompt, style: "static"|"animated", initData }
 * Генерирует несколько картинок через Hugging Face Inference API.
 */
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, count } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const stickerPrompt =
      `sticker, ${prompt.trim()}, cute cartoon vector style, thick outline, ` +
      `simple flat colors, white background, centered, high contrast`;

    const NUM_IMAGES = Math.min(Math.max(parseInt(count, 10) || 4, 1), 4);
    const images = [];

    // Генерируем последовательно с паузой — у Pollinations.ai лимит для анонимных
    // запросов примерно 1 запрос в 15 секунд
    for (let i = 0; i < NUM_IMAGES; i++) {
      try {
        const buffer = await generateOneImage(stickerPrompt);
        const processed = await processToSticker(buffer);
        const id = `${Date.now()}_${i}`;
        generatedCache.set(id, processed);
        images.push({
          id,
          url: `${req.protocol}://${req.get("host")}/api/image/${id}`,
          animated: false, // анимация — отдельная фича, см. заметку в README
        });
      } catch (err) {
        console.error(`Ошибка генерации картинки #${i}:`, err.message);
        // Продолжаем, даже если одна картинка не получилась
      }
      // Небольшая пауза для стабильности (авторизованный ключ снимает жёсткий лимит)
      if (i < NUM_IMAGES - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (images.length === 0) {
      return res.status(502).json({ error: "Не удалось сгенерировать ни одной картинки. Попробуй ещё раз." });
    }

    res.json({ images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

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

    // Извлекаем user_id из initData (Telegram подписывает эти данные)
    const userId = extractUserId(initData);
    if (!userId) {
      return res.status(400).json({ error: "cannot determine telegram user id" });
    }

    const botUsername = await getBotUsername();
    // short_name должен быть уникальным глобально и заканчиваться на _by_<botusername>
    const shortName = `${slugify(packName)}_${Date.now()}`.slice(0, 50) + `_by_${botUsername}`;

    let firstSticker = true;
    for (const s of stickers) {
      const buf = generatedCache.get(s.id);
      if (!buf) continue;

      if (firstSticker) {
        await createStickerSet(userId, shortName, packName, buf);
        firstSticker = false;
      } else {
        await addStickerToSet(userId, shortName, buf);
      }
    }

    if (firstSticker) {
      return res.status(400).json({ error: "no valid stickers found" });
    }

    res.json({
      ok: true,
      packLink: `https://t.me/addstickers/${shortName}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

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
      console.log(`✅ Оплата получена: user ${payload.userId}, +${payload.amount} $`);
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
Как устроен бот: пользователь открывает кнопку меню внизу чата (мини-приложение),
описывает идею текстом (например "гиппопотам в очках"), нажимает "Сгенерировать" —
и получает несколько картинок. Генерация одной партии картинок стоит 5 внутренних
долларов ($). Новым пользователям выдаётся 100 $ бесплатно. Если $ не хватает —
можно сыграть в мини-игру "собери жетоны" (тап по монеткам 15 секунд) или купить
$ за Telegram Stars прямо в приложении. Выбрав понравившиеся картинки, пользователь
нажимает "Добавить в стикерпак", придумывает название — и стикеры сразу появляются
в его личном списке стикерпаков в Telegram: их можно найти через встроенный поиск
стикеров в любом чате (иконка стикеров в поле ввода сообщения → раздел "Мои наборы"),
а управлять своими сохранёнными наборами (переименовать, удалить, посмотреть все)
можно через официального Telegram-бота @Stickers — это встроенный сервис самого
Telegram для администрирования стикерпаков, не наш бот, но он показывает все паки
пользователя, включая созданные через нас. Если генерация не удалась — можно просто попробовать ещё раз,
это бесплатный сервис и иногда он перегружен. Отвечай кратко, по-дружески,
на языке вопроса пользователя (русский или английский). Если вопрос не связан
с ботом и стикерами — вежливо верни разговор к теме бота.`;

async function handleChatMessage(message) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      "Привет! 👋 Я помогаю создавать стикеры с помощью нейросети.\n\n" +
        "Нажми на кнопку меню внизу чата, чтобы открыть приложение, опиши идею — и получишь готовые стикеры.\n\n" +
        "Если что-то не понятно — просто напиши мне вопрос прямо тут, отвечу."
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

// Простой health-check адрес — для внешнего "будильника" (UptimeRobot и т.п.),
// чтобы бесплатный сервер на Render не засыпал от бездействия
app.get("/", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
