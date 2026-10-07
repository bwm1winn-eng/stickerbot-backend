# Sticker Bot creator update — 7 October 2026

## Installation

Apply `supabase/migrations/20261007160925_collaborative_creator.sql` before deploying the server. Keep `server.js`, `creator-features.js` and `sticker-background.js` together at the repository root. Existing dependencies already include Express, node-fetch, sharp and dotenv. No new paid service or infrastructure is required.

The frontend remains a single `frontend/index.html` for Netlify. Voice recognition uses the browser speech service where supported, with explicit start and review before insertion. It does not send audio to this backend. Unsupported Telegram webviews show keyboard dictation guidance.

## Shared packs

In the Library, expand a pack's contributor menu and create an invitation. Links open the bot, which sends an inline Mini App button. The recipient joins explicitly in the Mini App. The link lasts seven days and admits up to 20 new members; rotating or revoking it invalidates the previous link. Owners can remove members. A removed member needs a link created after removal to rejoin.

Participants can view and add their own generated/uploaded images. Only the recorded owner can rename, edit emoji, remove stickers or delete the pack. Access is checked against signed Telegram initData and current database membership; roles are not taken from the browser. Tokens are random and stored only as hashes. Private database tables/RPCs are inaccessible to anon/authenticated clients.

## Automatic 24-emotion pack

Active Ultimate users choose this mode under Creation settings and enter a title and description. A quoted 48-coin maximum is charged atomically with queue insertion. Each successfully persisted image costs two coins; missing images are refunded atomically once. Every expression has a matching Telegram emoji. Available images are saved as a Telegram pack automatically. If Telegram saving fails, images remain available for manual saving.

Jobs persist in the database and status polling resumes after reopening the page. The worker runs sequentially inside the existing Render process. This is not a separate persistent worker service: a suspended/restarted Render instance interrupts processing. Expired leases refund uncreated images; uncertain paid attempts are never automatically repeated. A full pack can take several minutes. Independent image generation cannot guarantee perfectly identical character details.

Assets are private in the database, capped at 512 KB after normalization, and expire after 24 hours. Preview/download endpoints use unguessable 192-bit asset URLs as bearer access. Save requests check asset ownership and retain an idempotency key. Completed jobs/save operation records are retained for 30 days. The canonical sticker pack remains in Telegram after preview assets expire.

## Backgrounds and interface

White is the default. Black, custom colour and transparent are available. Transparent provider results retain alpha; opaque white responses use border-connected white matting. Unsupported separation fails the image and refunds its generation cost. This fallback is not a general photographic background-removal model; review the cutout before saving.

Uploads accept static PNG/JPEG/WebP under 4 MB and preserve existing alpha. They are resized to Telegram's 512-pixel canvas without charging generation coins. Only one Random idea button remains; text tools and generation settings are grouped in disclosure panels.

Ultimate adds Obsidian Observatory and Origami Atelier layouts. Existing saved Aurora preferences migrate to Obsidian. All tiers now have zero daily subscription coin gifts. Current Stars/coin subscription purchase prices are unchanged.

## Verification limits

JavaScript syntax and SQL installation/ACL metadata were checked. The Codex Browser security check could not verify saved localhost permissions, so this stage has no browser visual verification. No real Stars purchase, paid image generation, microphone recording, contributor join or real sticker mutation was performed as a check.
