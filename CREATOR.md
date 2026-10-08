# Sticker Bot creator update — 8 October 2026

## Installation

Apply the migrations in order, including `supabase/migrations/20261008085653_creator_emotion_updates.sql`, before deploying the server. Keep `server.js`, `creator-features.js`, `emotion-catalog.js` and `sticker-background.js` together at the repository root. Existing dependencies already include Express, node-fetch, sharp and dotenv. No new paid service or infrastructure is required.

The frontend remains a single `frontend/index.html` for Netlify. Voice recognition uses the browser speech service where supported, with explicit start and review before insertion. It does not send audio to this backend. Unsupported Telegram webviews show keyboard dictation guidance.

## Shared packs

In the Library, expand a pack's contributor menu and create an invitation. Links open the bot, which sends an inline Mini App button. The recipient joins explicitly in the Mini App. Each link lasts seven days and admits up to 20 new members; creating another link preserves previous active links. Explicit rotation or revocation invalidates them. At most 20 active links and 50 contributors are allowed per pack. Previously revoked links remain revoked. Owners can remove members. A removed member needs a link created after removal to rejoin.

Participants can view and add their own generated/uploaded images. Only the recorded owner can rename, edit emoji, remove stickers or delete the pack. Access is checked against signed Telegram initData and current database membership; roles are not taken from the browser. Tokens are random and stored only as hashes. Private database tables/RPCs are inaccessible to anon/authenticated clients.

## Automatic emotion packs and daily quota

Mode, quantity, daily remaining and total price are visible on the main creation screen. Emotion collections start at two images. Free accounts can generate up to eight successful stickers per UTC day and start one successful emotion collection per day within that quota. Standard permits up to six emotions, Luxury ten and Ultimate thirty-six. Ordinary generation caps remain eight/six/ten/twelve. Each image costs five/four/three/two coins respectively; free account access does not waive coin charges. Existing subscription Stars and coin prices are unchanged by this release.

The displayed maximum is charged atomically with queue insertion and free quota reservation. Missing images are refunded once, and their reserved daily slots are released. If no image is created, the daily emotion allowance is also released. Partial success consumes the one daily collection allowance. Refunds use the reservation's original UTC date even when a job crosses midnight. Queue admission rejects stale quotes; the browser must refresh and ask for confirmation again.

Expressions come from the shared 36-entry canonical catalogue with matching Telegram emoji. The selected art style and background remain part of the generation prompt. Available images are saved as a Telegram pack automatically. If Telegram saving fails, images remain available for manual saving.

Jobs persist in the database and status polling resumes after reopening the page. The worker runs sequentially inside the existing Render process. This is not a separate persistent worker service: a suspended/restarted Render instance interrupts processing. Expired leases refund uncreated images; uncertain paid attempts are never automatically repeated. A full pack can take several minutes. Independent image generation cannot guarantee perfectly identical character details.

Assets are private in the database, capped at 512 KB after normalization, and expire after 24 hours. Preview/download endpoints use unguessable 192-bit asset URLs as bearer access. Save requests check asset ownership and retain an idempotency key. Completed jobs/save operation records are retained for 30 days. The canonical sticker pack remains in Telegram after preview assets expire.

## Backgrounds and interface

White is the default. Black, custom colour and transparent are available. Transparent provider results retain alpha; opaque white responses use border-connected white matting. Unsupported separation fails the image and refunds its generation cost. This fallback is not a general photographic background-removal model; review the cutout before saving.

Uploads accept static PNG/JPEG/WebP under 4 MB and preserve existing alpha. They are resized to Telegram's 512-pixel canvas without charging generation coins. Only one Random idea button remains; text tools and generation settings are grouped in disclosure panels.

Ultimate adds Obsidian Observatory and Origami Atelier layouts. Prism Studio replaces Editorial with a different arrangement; saved Editorial preferences migrate to Prism. Existing saved Aurora preferences migrate to Obsidian. All tiers have zero daily subscription coin gifts. Current Stars/coin subscription purchase prices are unchanged.

Saving into an existing pack awaits pack loading and preserves its selection. Empty or unavailable targets are rejected rather than creating a new pack. Completed save retries return the recorded result even after source previews expire. A single save supports up to 36 images.

The channel reward requires the bot to be an administrator of @Lordeuso. Telegram membership must be verified before the atomic reward RPC runs. Missing bot permissions, temporary Telegram failures and database failures produce distinct safe diagnostics; no reward is granted from an unverified click.

## Verification limits

The Node mocked suites cover signed account access, generation/quota behaviour, semantic errors, job progress, invitations and save retries. `tests/creator-database.test.mjs` runs the actual migrations and `tests/creator-database.test.sql` in a new in-memory PGlite database, with a minimal base schema modeling the relevant nullable balance and unique quota/ledger invariants. All synthetic data rolls back. PGlite is a test-only dependency installed outside the production repository; setup is documented in the runner. This fixture does not model every production constraint or real simultaneous PostgreSQL sessions.

`frontend/tests/creator-controls.cjs` uses about:blank with in-memory HTML and every request intercepted. It checks interface behaviour with fixtures; it does not access the production site or localhost. The Codex Browser security check could not verify saved localhost permissions, so no live browser visual verification is claimed. No real Stars purchase, paid image generation, microphone recording, contributor join or real sticker mutation is performed as a check. Production verification checks migration/RPC permissions, Render deployment health and the served frontend source.
