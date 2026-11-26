-- Blip: daily limit for AI title polish (tidy-titles function).
-- Run once in Supabase → SQL Editor. Safe to run again.
-- Each signed-in person gets a number of AI calls per day (UTC). The function
-- asks use_ai_quota() before calling Claude; when it says no, Blip keeps the
-- offline titles, so nothing breaks and the bill stays predictable.

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  calls int not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
-- No policies: people can't read or change counts directly, only through the function below.

-- Counts one call for the signed-in person and says whether it's allowed.
-- Atomic, so two devices at once can't go over the limit.
create or replace function public.use_ai_quota(p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then return false; end if;
  insert into ai_usage (user_id, day, calls)
  values (uid, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set calls = ai_usage.calls + 1
    where ai_usage.calls < greatest(p_limit, 0)
  returning calls into n;
  return n is not null;
end;
$$;

revoke all on function public.use_ai_quota(int) from public, anon;
grant execute on function public.use_ai_quota(int) to authenticated;

-- Old rows are tiny, but you can clear anything older than 30 days with:
-- delete from public.ai_usage where day < current_date - 30;
