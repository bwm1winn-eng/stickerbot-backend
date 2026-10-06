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
- Для текущего одноразового задания используется `@Lordeuso`; `CHANNEL_TASK_CHAT` должен указывать этот канал. Бот должен быть администратором канала, чтобы Telegram позволил надёжно проверить подписку. Для переноса задания на другой канал нужна согласованная серверная миграция его идентификатора, а не только замена переменной.
- `POST /api/tasks/channel/status` сообщает статус, а `POST /api/tasks/channel/claim` выдаёт 10 монет один раз на аккаунт после проверки подписки. Повторные запросы не начисляют награду второй раз.
- Перед выпуском этой версии примените `20261006161936_atomic_channel_task_reward.sql`. RPC `account_claim_channel_task` сохраняет подтверждение, баланс и историю одной транзакцией; потеря HTTP-ответа не удаляет уже выполненную операцию. Ранее сохранённые подтверждения остаются авторитетными.
- Проверка Telegram имеет общий предел 10 секунд, ограниченные повторы при временном сбое и один короткий повтор после ещё не отобразившегося вступления. Недоступная проверка возвращает `CHANNEL_CHECK_UNAVAILABLE`, неверная настройка/отсутствие прав администратора — `CHANNEL_TASK_CONFIGURATION`, подтверждённое отсутствие подписки — `CHANNEL_NOT_JOINED`. Незнакомый статус или ошибка API не дают награду.
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
- **Анимированные стикеры** (WEBM) в этой версии не реализованы. Все доступные
  стили создают статичные стикеры; значение `style: "animated"` не поддерживается.
  Для анимированных стикеров нужен отдельный video-рендеринг.
- Хранилище картинок — **in-memory** (`Map` в оперативной памяти). Это ок для
  MVP, но при перезапуске сервера (или через долгое время) старые картинки
  станут недоступны. Для продакшена стоит перейти на S3-совместимое хранилище.

## Надёжность баланса и платежей

Перед обновлением сервера примените миграции из `supabase/migrations` по порядку. Миграция `atomic_accounting` добавляет закрытые RPC для изменения баланса, ежедневного бонуса и обработки платежей. Их может вызывать только сервер с ключом `service_role`; клиентам прямой доступ запрещён.

Баланс и запись истории теперь сохраняются одной транзакцией. Ежедневный бонус начисляется один раз по UTC, а повторное уведомление Telegram с тем же идентификатором платежа не начисляет монеты и не продлевает подписку повторно. Ошибка базы при обработке оплаты возвращает Telegram статус 500 для повторной доставки; ошибочная платёжная ссылка отклоняется до списания Stars.

Бесплатный лимит четырёх успешных стикеров в сутки общий для мини-приложения и команды `/create`. Несозданные стикеры освобождают лимит и возвращают монеты, включая частично успешную генерацию.

Изолированные проверки: `node scripts/verify-chat-generation.cjs` и `node scripts/verify-atomic-accounting.cjs`. Проверка функций базы находится в `supabase/tests/atomic_accounting.sql`; её тестовые записи откатываются транзакцией. Реальные платежи и запросы генерации при этих проверках не выполняются.

## Premium Studio — revised 6 October 2026

| Plan | First 30 days / manual renewal | Coins per image | Batch limit | Daily coins | Studio |
| --- | --- | --- | --- | --- | --- |
| Standard | 21 / 32 Stars | 4 | 6 | 3 | Existing benefits |
| Luxury | 65 / 99 Stars | 3 | 10 | 0 | Gold Atelier, quick generation styles |
| Ultimate | 287 / 438 Stars | 2 | 12 | 0 | Luxury features, Aurora Studio, six-expression emotion set |

Prices are rounded upward after Standard's requested 10% increase and Luxury/Ultimate's 25% increase. They apply to newly created invoices. Already issued invoices that carry an explicit quoted Stars amount continue to validate at that amount. Luxury and Ultimate no longer grant daily coins; Standard stays at 3. Discounts, batch sizes, and transactional accounting are unchanged.

Coin subscriptions are Standard 640, Luxury 1980, Ultimate 8760 for 30 days, with one purchase per account every three calendar months. Each price is its regular renewal price × 8 coins per Star × 2.5. Apply the additive `account_buy_coin_subscription_v2` RPC migration before publishing the new server/client prices so database debits and visible quotes agree. After both deployments are live, apply the separate cutoff migration that rejects legacy RPC purchases.

`POST /api/subscription/buy-coins` requires an integer `expectedPrice` alongside `initData` and `tier`. A missing or stale quote returns 409 with `code: "COIN_SUBSCRIPTION_PRICE_CHANGED"` and the current `cost`, without any debit. The frontend must refresh the quote and ask for confirmation again; it must not automatically retry a purchase. The v2 RPC also validates `p_expected_price` atomically.

Saved recipes and favorite-pack controls are removed from the frontend. Premium themes require an active, unexpired Luxury/Ultimate subscription; Aurora requires Ultimate. Themes are interface preferences and do not grant server privileges.

### Generation payload

`POST /api/generate` continues to accept `initData`, `prompt`, and `count`. It additionally accepts:

- `style`: `vector` (default), `clay3d`, `paper`, or `anime`. Non-vector styles require active Luxury or Ultimate. The server uses one exclusive art-style suffix, avoiding the previous forced vector clause overriding a 3D-look request.
- `preset`: `none` (default) or `emotions`. Emotions require active Ultimate and exactly `count: 6`. Six normal paid image generations use one idea with happy, sad, wow, love, angry, and wink variations. Successful response images contain the corresponding `emotion` key. Six successes cost 12 coins; partial/total failures use the existing refund rules. The preset adds no extra sticker generations beyond the selected six; normal provider retries/fallback can still occur.

Unknown values return 400; insufficient tiers return 403; preset-count mismatch returns 400 before any quota reservation or debit. Invalid/non-string prompts also return 400. Chat `/create` keeps its existing four-image vector generation flow and subscription discount.

Run `node scripts/verify-premium-express.cjs` for isolated pricing/quote, entitlement, art-prompt, emotion-set/refund, and old invoice checks. It makes no real external requests. Existing `verify-atomic-accounting.cjs` and `verify-chat-generation.cjs` cover payment retry and shared chat quota/refunds.

Run `node scripts/verify-taskcheck.cjs` for isolated channel membership, admin configuration, retry, duplicate/ambiguous claim and reserved-promo checks. `node scripts/verify-image-provider.cjs` checks a shared 45-second budget per sticker, safe diagnostics, no retries on HTTP 402, and at most one short retry on HTTP 429/5xx. Long `Retry-After` values fail promptly and use normal refunds; the server does not retry before the provider's specified time. All checks use fixtures, without Telegram claims, AI usage, or real payments.

These produce static raster stickers, including a 3D-render look rather than actual 3D geometry or animation. Independent image generations can vary character details; an emotion set is not a guarantee of exact visual identity.
