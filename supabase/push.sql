-- Blip background reminders (Web Push). Run once in Supabase: SQL Editor -> New query -> Run.
-- Safe to run again. See docs/push-setup.md for the full setup, in order.
--
-- push_subscriptions: one row per device that allowed notifications.
-- reminders: each upcoming reminder, written by the user's devices with the
--   exact moment to send it. A server job sends due ones every minute.

create table if not exists public.push_subscriptions (
  endpoint    text        primary key,
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh      text        not null,
  auth        text        not null,
  user_agent  text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

create table if not exists public.reminders (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  task_id     text        not null,
  fire_at     timestamptz not null,
  offset_min  integer     not null default 0,
  title       text        not null default '',
  body        text        not null default '',
  sent        boolean     not null default false,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  primary key (user_id, task_id, fire_at)
);
create index if not exists reminders_due on public.reminders (fire_at) where not sent;

alter table public.push_subscriptions enable row level security;
alter table public.reminders          enable row level security;

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'reminders'] loop
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('create policy "own rows: insert" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: update" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('create policy "own rows: delete" on public.%I for delete to authenticated using (user_id = auth.uid())', t);
  end loop;
end;
$$;

-- Clean out sent reminders after a week so the table stays small.
create or replace function public.blip_prune_reminders()
returns void language sql as $$
  delete from public.reminders where sent and sent_at < now() - interval '7 days';
  delete from public.reminders where not sent and fire_at < now() - interval '1 day';
$$;

-- ---------------------------------------------------------------------------
-- Every minute, ask the send-reminders function to send what's due.
-- Needs the pg_cron and pg_net extensions (Database -> Extensions) and two
-- Vault secrets created in docs/push-setup.md step 4: blip_project_url and blip_cron_secret.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('blip-send-reminders')
where exists (select 1 from cron.job where jobname = 'blip-send-reminders');

select cron.schedule(
  'blip-send-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'blip_project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'blip_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

select cron.unschedule('blip-prune-reminders')
where exists (select 1 from cron.job where jobname = 'blip-prune-reminders');
select cron.schedule('blip-prune-reminders', '17 3 * * *', $$ select public.blip_prune_reminders(); $$);
