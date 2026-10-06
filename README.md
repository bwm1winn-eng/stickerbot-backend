# Stickerbot Backend

Бэкенд для Telegram Mini App: принимает промпт, генерирует картинки через
Pollinations API, обрабатывает под формат стикера и добавляет их в стикерпак
пользователя через Telegram Bot API.

## Локальный запуск (необязательно, можно сразу деплоить)

```bash
npm install
cp .env.example .env
# впиши в .env свои токены
npm start
```

## Деплой на Render (бесплатно)

1. Залей эту папку к себе на GitHub (создай новый репозиторий, загрузи файлы).
2. Зайди на **render.com**, зарегистрируйся (можно через GitHub).
3. **New +** → **Web Service** → выбери свой репозиторий.
4. Настройки:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. В разделе **Environment** добавь переменные:
   - `BOT_TOKEN` — токен бота из BotFather
   - `SUPABASE_URL` — URL проекта Supabase
   - `SUPABASE_KEY` — серверный service role key Supabase; не добавляй его во фронтенд
   - `TELEGRAM_WEBHOOK_SECRET` — случайная строка из букв, цифр, `_` и `-`; используй её при регистрации webhook
   - `OWNER_TELEGRAM_ID` — Telegram ID владельца для административных команд
   - `POLLINATIONS_KEY` — необязательный ключ платного API генерации
   - `CHANNEL_TASK_CHAT` — публичный канал для задания подписки, по умолчанию `@Lordeuso`
6. Нажми **Create Web Service** — Render соберёт и задеплоит.
7. Получишь URL вида `https://stickerbot-backend.onrender.com`.
8. Зарегистрируй адрес `https://ТВОЙ-АДРЕС.onrender.com/telegram-webhook` в Telegram Bot API методом `setWebhook`, передав `TELEGRAM_WEBHOOK_SECRET` в параметре `secret_token`. Совпадение секрета обязательно: сервер отклоняет запросы без правильного заголовка.

## История и задание за подписку

- Миграция `supabase/migrations/20261004120000_account_activity.sql` создаёт закрытый журнал событий. Клиенты не получают прямого доступа к таблице; сервер отдаёт только историю пользователя с валидной подписью Telegram.
- `POST /api/history` возвращает последние 100 операций. История начинает накапливаться после установки этой версии и не может восстановить старые события, которых раньше не записывали.
- `CHANNEL_TASK_CHAT` задаёт канал для задания. Бот должен быть администратором канала, чтобы Telegram позволил надёжно проверить подписку.
- `POST /api/tasks/channel/status` сообщает статус, а `POST /api/tasks/channel/claim` выдаёт 10 монет один раз на аккаунт после проверки подписки. Повторные запросы не начисляют награду второй раз.
- В интерфейсе оставлена спокойная область для будущих партнёрских и рекламных заданий. Рекламная сеть и оплачиваемая реклама пока не подключены.

## Подключение к фронтенду

В файле `index.html` (тот, что на Netlify) замени в двух местах:
- `fetch('/api/generate', ...)` → `fetch('https://ТВОЙ-АДРЕС.onrender.com/api/generate', ...)`
- `fetch('/api/add-to-pack', ...)` → `fetch('https://ТВОЙ-АДРЕС.onrender.com/api/add-to-pack', ...)`

Перезалей обновлённый `index.html` на Netlify (можно снова через netlify.com/drop
или через привязанный аккаунт).

## Важные ограничения

- **Free-тир Render "засыпает"** после ~15 минут бездействия — первый запрос после
  паузы может идти 30-50 секунд, это нормально.
- **Бесплатный Pollinations API** может ограничивать частоту запросов. При наличии
  `POLLINATIONS_KEY` backend сначала пробует платный endpoint, затем переключается
  на бесплатный вариант.
- **Анимированные стикеры** (WEBM) в этой версии не реализованы — сейчас style
  "animated" всё равно создаёт статичные стикеры. Это отдельная, более сложная
  фича (нужен video-рендеринг), можно добавить следующим шагом.
- Хранилище картинок — **in-memory** (`Map` в оперативной памяти). Это ок для
  MVP, но при перезапуске сервера (или через долгое время) старые картинки
  станут недоступны. Для продакшена стоит перейти на S3-совместимое хранилище.

## Надёжность баланса и платежей

Перед обновлением сервера примените миграции из `supabase/migrations` по порядку. Миграция `atomic_accounting` добавляет закрытые RPC для изменения баланса, ежедневного бонуса и обработки платежей. Их может вызывать только сервер с ключом `service_role`; клиентам прямой доступ запрещён.

Баланс и запись истории теперь сохраняются одной транзакцией. Ежедневный бонус начисляется один раз по UTC, а повторное уведомление Telegram с тем же идентификатором платежа не начисляет монеты и не продлевает подписку повторно. Ошибка базы при обработке оплаты возвращает Telegram статус 500 для повторной доставки; ошибочная платёжная ссылка отклоняется до списания Stars.

Бесплатный лимит четырёх успешных стикеров в сутки общий для мини-приложения и команды `/create`. Несозданные стикеры освобождают лимит и возвращают монеты, включая частично успешную генерацию.

Изолированные проверки: `node scripts/verify-chat-generation.cjs` и `node scripts/verify-atomic-accounting.cjs`. Проверка функций базы находится в `supabase/tests/atomic_accounting.sql`; её тестовые записи откатываются транзакцией. Реальные платежи и запросы генерации при этих проверках не выполняются.

## Premium Studio — 6 October 2026

| Plan | First 30 days / manual renewal | Coins per image | Batch limit | Daily coins | Studio |
| --- | --- | --- | --- | --- | --- |
| Standard | 19 / 29 Stars | 4 | 6 | 3 | Existing benefits |
| Luxury | 52 / 79 Stars | 3 | 10 | 5 | Gold Atelier, 8 saved recipes, favorite packs |
| Ultimate | 229 / 350 Stars | 2 | 12 | 12 | Luxury features, 24 recipes, Aurora Studio, art/mood prompt builder |

Recipes save ideas and batch sizes. Recipes and favorites are device/browser-local and are lost if browser storage is cleared; they do not sync. The builder edits prompt text without automatically generating images. Premium Studio requires an active, unexpired Luxury or Ultimate subscription; the Aurora theme and builder require Ultimate. All six public themes remain available, with Original the default.

Coin subscriptions keep their prices: Standard 580, Luxury 1580, Ultimate 7000, for 30 days, with one purchase per account every three calendar months. Stars prices, discounts, batch sizes, and transactional accounting remain unchanged. Luxury daily coins fall from 8 to 5, Ultimate from 35 to 12; Standard stays at 3. The matching frontend update exposes these controls; the server handles subscription status and accounting, not local Studio preferences.
