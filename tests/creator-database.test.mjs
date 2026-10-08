import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Reproducible local setup, outside the backend's production dependencies:
//   pnpm --dir <workspace>/work/pglite-fixture add --save-exact @electric-sql/pglite@0.5.8
// PowerShell (PGLITE_MODULE must point to the package's absolute JS entry file):
//   $env:PGLITE_MODULE = '<workspace>\work\pglite-fixture\node_modules\@electric-sql\pglite\dist\index.js'
//   node --test stickerbot-local/tests/creator-database.test.mjs
// If PGlite is already resolvable from this file, PGLITE_MODULE is optional.
// This runner always creates a new in-memory DB; it accepts no connection URL.

async function loadPGlite() {
  const modulePath = process.env.PGLITE_MODULE;
  if (modulePath && !isAbsolute(modulePath)) throw new Error('PGLITE_MODULE must be an absolute path to PGlite dist/index.js');
  try {
    return await import(modulePath ? pathToFileURL(modulePath).href : '@electric-sql/pglite');
  } catch (error) {
    throw new Error('Install @electric-sql/pglite@0.5.8 outside the backend and set PGLITE_MODULE; see setup comments in creator-database.test.mjs', { cause: error });
  }
}

// Only the base columns and invariants exercised by creator migrations are
// modeled here. This is not a copy of every production table or constraint.
// The balance remains nullable; quota claims and ledger operation keys are
// unique, matching the accounting semantics that these fixtures verify.
const baseSchema = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon,authenticated,service_role;
  create table public.balances (
    user_id bigint primary key,
    balance integer default 15
  );
  create table public.subscriptions (
    user_id bigint primary key,
    active boolean not null default false,
    tier text,
    expires_at timestamptz,
    first_purchase_done boolean not null default false,
    last_bonus_date date,
    last_coin_purchase_at timestamptz
  );
  create table public.promo_redemptions (
    user_id bigint not null,
    code text not null,
    redeemed_at timestamptz not null default now(),
    primary key(user_id,code)
  );
  create table public.app_user_moderation (
    user_id bigint primary key,
    banned boolean not null default false,
    reason text not null default '',
    updated_at timestamptz not null default now()
  );
  create table public.sticker_packs (
    short_name text primary key,
    user_id bigint not null,
    title text not null,
    created_at timestamptz not null default now()
  );
  alter table public.balances enable row level security;
  alter table public.subscriptions enable row level security;
  alter table public.promo_redemptions enable row level security;
  alter table public.app_user_moderation enable row level security;
  alter table public.sticker_packs enable row level security;
  revoke all on public.balances,public.subscriptions,public.promo_redemptions,public.app_user_moderation,public.sticker_packs from public,anon,authenticated;
  grant all on public.balances,public.subscriptions,public.promo_redemptions,public.app_user_moderation,public.sticker_packs to service_role;
`;

const ledgerOperationInvariant = `
  alter table public.account_activity add column operation_key text;
  create unique index account_activity_operation_key_uidx
    on public.account_activity(operation_key) where operation_key is not null;
  revoke all on public.account_activity from public,anon,authenticated;
`;

test('actual creator migrations and rollback fixtures pass in isolated in-memory PostgreSQL', { timeout: 60_000 }, async () => {
  const { PGlite } = await loadPGlite();
  const db = new PGlite();
  try {
    await db.exec(baseSchema);
    for (const file of [
      '../supabase/migrations/20261004120000_account_activity.sql',
    ]) await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
    await db.exec(ledgerOperationInvariant);
    for (const file of [
      '../supabase/migrations/20261007160925_collaborative_creator.sql',
      '../supabase/migrations/20261008085653_creator_emotion_updates.sql',
      './creator-database.test.sql',
    ]) await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));

    const tables = ['balances','subscriptions','promo_redemptions','account_activity','app_user_moderation','sticker_packs','sticker_pack_members','sticker_pack_invites','creator_assets','creator_jobs','creator_pack_operations'];
    for (const table of tables) {
      const result = await db.query(`select count(*)::integer as remaining from public.${table}`);
      assert.equal(result.rows[0].remaining, 0, `${table} retained rows after fixture ROLLBACK`);
    }
    const columns = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='creator_jobs' and column_name in ('total','unit_price','quota_day','reserved_slots')");
    assert.equal(columns.rows.length, 4, 'creator migration schema did not persist outside fixture transaction');
  } finally {
    await db.close();
  }
});
