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
    const { prompt, style } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const stickerPrompt =
      `sticker, ${prompt.trim()}, cute cartoon vector style, thick outline, ` +
      `simple flat colors, white background, centered, high contrast`;

    const NUM_IMAGES = 4;
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
      // Пауза перед следующим запросом — у Pollinations строгий лимит
      // для анонимных запросов (~1 запрос за раз, минимум 15+ сек)
      if (i < NUM_IMAGES - 1) {
        await new Promise((r) => setTimeout(r, 13000));
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

async function generateOneImage(prompt, retries = 4, attempt = 0) {
  const encodedPrompt = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&seed=${seed}&nologo=true`;

  const response = await fetch(url);

  if (response.status === 429 && retries > 0) {
    // Очередь занята (общий IP на бесплатном хостинге) — ждём дольше с каждой попыткой
    const wait = 15000 + attempt * 10000;
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
  return str
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "_")
    .replace(/^_+|_+$/g, "") || "pack";
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
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
