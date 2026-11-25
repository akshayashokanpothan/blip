-- Blip v2: cross-device sync schema for Supabase (Postgres).
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; every statement checks before it creates.
--
-- Model: every row belongs to one signed-in user (auth.users.id). Row Level
-- Security makes sure a user can only ever see and change their own rows.
-- Deletes are soft (deleted = true) so other devices learn about them.

-- ---------------------------------------------------------------------------
-- Shared helper: stamp server time on every write. Devices pull "everything
-- changed since my last pull" using this column, so device clocks don't matter
-- for finding changes. (Conflicts use updated_at, the device's edit time.)
-- ---------------------------------------------------------------------------
create or replace function public.blip_touch()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id                text        not null,           -- generated on the device
  text              text        not null default '',
  notes             text        not null default '',
  date              date,
  time              text        not null default '', -- 'HH:MM' or ''
  end_time          text        not null default '',
  slot              text        not null default '', -- legacy part-of-day
  priority          text        not null default 'medium' check (priority in ('high', 'medium', 'low')),
  done              boolean     not null default false,
  reminder          boolean     not null default false,
  repeat            text        not null default 'none' check (repeat in ('none', 'daily', 'weekly')),
  created_at        bigint      not null default 0,  -- device ms timestamp
  updated_at        bigint      not null default 0,  -- device ms timestamp of the last edit
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists tasks_user_server_updated on public.tasks (user_id, server_updated_at);

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before insert or update on public.tasks
  for each row execute function public.blip_touch();

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id                text        not null,
  title             text        not null default '',
  body              text        not null default '',
  created_at        bigint      not null default 0,
  edited_at         bigint      not null default 0,  -- the note's own "last edited" shown in the list
  updated_at        bigint      not null default 0,  -- sync edit time (includes deletes)
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists notes_user_server_updated on public.notes (user_id, server_updated_at);

drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before insert or update on public.notes
  for each row execute function public.blip_touch();

-- ---------------------------------------------------------------------------
-- Per-user settings that should follow the account (name, work, theme).
-- The Anthropic API key is deliberately NOT here: it stays on each device.
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id           uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name      text        not null default '',
  role              text        not null default '',
  role_other        text        not null default '',
  theme             text        not null default 'light',
  updated_at        bigint      not null default 0,
  server_updated_at timestamptz not null default now()
);

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before insert or update on public.user_settings
  for each row execute function public.blip_touch();

-- ---------------------------------------------------------------------------
-- Row Level Security: each user sees only their own rows.
-- ---------------------------------------------------------------------------
alter table public.tasks         enable row level security;
alter table public.notes         enable row level security;
alter table public.user_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tasks', 'notes', 'user_settings'] loop
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('create policy "own rows: insert" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: update" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end;
$$;
-- No delete policy on purpose: devices soft-delete with deleted = true.

-- ---------------------------------------------------------------------------
-- Realtime: push row changes to the user's other open devices.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tasks', 'notes', 'user_settings'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
