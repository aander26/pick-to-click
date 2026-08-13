-- ============================================================================
-- Pick to Click 2026 — Supabase schema
-- Run this ONCE in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- It is safe to re-run: everything is guarded with "if not exists" / "on conflict".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SETTINGS  (single row, id = 1)
--   submissions_locked : false while picks are open, true once the admin locks.
--   k                  : smoothing constant in the Improvement formula (default 150).
--   lock_at            : optional display-only deadline shown to entrants.
--   locked_at          : timestamp of the actual admin lock (null until locked).
-- ----------------------------------------------------------------------------
create table if not exists public.settings (
  id                 int primary key default 1,
  submissions_locked boolean     not null default false,
  k                  numeric     not null default 150,
  lock_at            timestamptz,
  locked_at          timestamptz,
  constraint settings_singleton check (id = 1)
);

insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- ENTRIES  (one row per entrant: their name + one offense pick + one defense pick)
--   player ids are the stable slugs from the pool embedded in index.html
--   (jersey numbers are NOT unique across offense/defense, so we key on slug).
--   We store the display name too, so an entry is still readable even if the
--   pool is ever edited.
-- ----------------------------------------------------------------------------
create table if not exists public.entries (
  id                    uuid primary key default gen_random_uuid(),
  entrant_name          text not null,
  offense_player_id     text not null,
  offense_player_name   text not null,
  defense_player_id     text not null,
  defense_player_name   text not null,
  created_at            timestamptz not null default now()
);

-- One entry per name (blocks accidental double-submits). Case-insensitive.
create unique index if not exists entries_name_unique
  on public.entries (lower(entrant_name));

-- ----------------------------------------------------------------------------
-- LIVE_STATS  (the 2026 cumulative stat line per player, updated through the season)
--   Same raw columns as the baseline. The app computes the P1 production index
--   from these using the same position formula it uses for P0.
--   Only the admin function (service key) ever writes here.
-- ----------------------------------------------------------------------------
create table if not exists public.live_stats (
  player_id   text primary key,
  rush_att    numeric not null default 0,
  rush_yds    numeric not null default 0,
  rush_td     numeric not null default 0,
  pass_att    numeric not null default 0,
  pass_yds    numeric not null default 0,
  pass_td     numeric not null default 0,
  pass_int    numeric not null default 0,
  rec         numeric not null default 0,
  rec_yds     numeric not null default 0,
  rec_td      numeric not null default 0,
  tackles     numeric not null default 0,
  tfl         numeric not null default 0,
  sacks       numeric not null default 0,
  int         numeric not null default 0,
  pbu         numeric not null default 0,
  updated_at  timestamptz not null default now()
);

-- ============================================================================
-- ROW-LEVEL SECURITY
-- The browser uses the public "anon" key. These policies are what make that safe:
-- a friend poking at the API with the anon key can read the leaderboard data but
-- can only ADD their own entry, and can never touch stats or settings.
-- All privileged writes go through the serverless admin function, which uses the
-- service key and bypasses RLS entirely.
-- ============================================================================

alter table public.settings   enable row level security;
alter table public.entries    enable row level security;
alter table public.live_stats enable row level security;

-- SETTINGS: anyone may read (the app needs k + the locked flag). Nobody writes via anon.
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings
  for select to anon, authenticated using (true);

-- LIVE_STATS: anyone may read (needed to compute the leaderboard). Nobody writes via anon.
drop policy if exists live_stats_read on public.live_stats;
create policy live_stats_read on public.live_stats
  for select to anon, authenticated using (true);

-- ENTRIES: anon may INSERT a new entry, but ONLY while submissions are open.
-- There is deliberately no anon SELECT/UPDATE/DELETE policy, so with RLS on:
--   * anon cannot read the raw entries table directly (picks stay hidden — see view below)
--   * anon cannot edit or delete anyone's entry (including their own)
drop policy if exists entries_insert_while_open on public.entries;
create policy entries_insert_while_open on public.entries
  for insert to anon, authenticated
  with check (
    (select s.submissions_locked from public.settings s where s.id = 1) = false
  );

-- ----------------------------------------------------------------------------
-- HIDE-UNTIL-LOCK VIEW
-- The app reads entrants through this view instead of the raw table.
-- While picks are OPEN it returns names only (the "who's entered" roster) and
-- nulls out the actual picks. Once the admin locks, the picks are revealed.
-- The view is owned by the table owner and runs with its privileges, so it can
-- read the entries table even though the anon role cannot read it directly.
-- ----------------------------------------------------------------------------
create or replace view public.entrants_public
with (security_invoker = false) as
  select
    e.id,
    e.entrant_name,
    e.created_at,
    case when s.submissions_locked then e.offense_player_id   end as offense_player_id,
    case when s.submissions_locked then e.offense_player_name end as offense_player_name,
    case when s.submissions_locked then e.defense_player_id   end as defense_player_id,
    case when s.submissions_locked then e.defense_player_name end as defense_player_name,
    s.submissions_locked as revealed
  from public.entries e
  cross join public.settings s
  where s.id = 1;

grant select on public.entrants_public to anon, authenticated;

-- Done. The app: reads settings + live_stats + entrants_public (anon key),
-- inserts into entries (anon key, only while open), and everything privileged
-- (lock, k, stat updates, deleting an entry) goes through api/admin.js.
