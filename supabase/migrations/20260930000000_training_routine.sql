-- Training routine: preferences, plans, planned sessions, logged workouts, readiness scores.
--
-- Depends only on auth.users; it doesn't touch the dashboard tables in schema.sql.
--
-- Access model: the FastAPI backend uses the service-role key and applies every write through
-- training_apply_changes (one transaction). Clients only get SELECT on their own rows, so business
-- rules can't be bypassed by writing to these tables directly.
--
-- Hard Rule 4: readiness scores are private to the owning user. The only policy on
-- readiness_scores is "select own"; nothing friend-facing may ever read them.

create table if not exists public.training_preferences (
    user_id uuid primary key references auth.users(id) on delete cascade,
    days_per_week smallint not null check (days_per_week between 1 and 7),
    session_duration_min smallint not null check (session_duration_min > 0),
    activity_types text[] not null
        check (cardinality(activity_types) >= 1
               and activity_types <@ array['run', 'gym', 'cycling', 'bodyweight']),
    rest_days text[] not null default '{}'
        check (rest_days <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    updated_at timestamptz not null default now(),
    check (7 - cardinality(rest_days) >= days_per_week)
);

create table if not exists public.training_plans (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    start_date date not null,
    end_date date not null,
    weeks smallint not null check (weeks > 0),
    status text not null check (status in ('active', 'superseded')),
    baseline_volume numeric(8, 2) not null check (baseline_volume >= 0),
    notice text not null,
    last_adaptation jsonb,
    created_at timestamptz not null default now(),
    check (end_date >= start_date)
);

-- At most one active plan per user.
create unique index if not exists training_plans_one_active_per_user
    on public.training_plans (user_id) where status = 'active';

create table if not exists public.planned_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    plan_id uuid not null references public.training_plans(id) on delete cascade,
    date date not null,
    activity_type text not null check (activity_type in ('run', 'gym', 'cycling', 'bodyweight')),
    target_volume numeric(8, 2) not null check (target_volume >= 0),
    target_duration_min integer not null check (target_duration_min > 0),
    intensity_band text not null check (intensity_band in ('deload', 'light', 'push')),
    status text not null default 'planned'
        check (status in ('planned', 'accepted', 'completed', 'partial', 'missed', 'moved')),
    -- One planned session per day.
    unique (user_id, date)
);

create index if not exists planned_sessions_user_date on public.planned_sessions (user_id, date);

create table if not exists public.workout_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    planned_session_id uuid references public.planned_sessions(id) on delete set null,
    date date not null,
    activity_type text not null check (activity_type in ('run', 'gym', 'cycling', 'bodyweight')),
    actual_volume numeric(8, 2) not null check (actual_volume > 0),
    actual_duration_min integer not null check (actual_duration_min > 0),
    rpe smallint check (rpe between 1 and 10),
    avg_hr smallint check (avg_hr > 0),
    -- Hard Rule 1: readiness and plan calculations exclude source = 'strava'.
    source text not null default 'manual' check (source in ('manual', 'import', 'strava')),
    created_at timestamptz not null default now()
);

create index if not exists workout_sessions_user_date on public.workout_sessions (user_id, date);

create table if not exists public.readiness_scores (
    user_id uuid not null references auth.users(id) on delete cascade,
    date date not null,
    score smallint not null check (score between 0 and 100),
    classification text not null check (classification in ('deload', 'light', 'push')),
    factors jsonb not null,
    explanation text not null default '',
    -- The cached score is valid only while the inputs are unchanged.
    feature_hash text not null,
    computed_at timestamptz not null default now(),
    primary key (user_id, date)
);

-- Row level security: read your own rows, nothing else. Writes go through the backend.
alter table public.training_preferences enable row level security;
alter table public.training_plans enable row level security;
alter table public.planned_sessions enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.readiness_scores enable row level security;

create policy "Users can view own training preferences"
    on public.training_preferences for select using (auth.uid() = user_id);
create policy "Users can view own training plans"
    on public.training_plans for select using (auth.uid() = user_id);
create policy "Users can view own planned sessions"
    on public.planned_sessions for select using (auth.uid() = user_id);
create policy "Users can view own workout sessions"
    on public.workout_sessions for select using (auth.uid() = user_id);
create policy "Users can view own readiness scores"
    on public.readiness_scores for select using (auth.uid() = user_id);

-- Applies one operation's writes atomically. Every statement is scoped to p_user_id, and the rows in
-- p_changes carry no user id of their own, so a payload can't write to another user's data.
--
-- p_changes: {
--   supersede_active_plan: boolean,
--   delete_session_ids:    [uuid],
--   upsert_plans:          [plan row],
--   upsert_sessions:       [planned session row],
--   insert_workouts:       [workout row]
-- }
create or replace function public.training_apply_changes(p_user_id uuid, p_changes jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
    if coalesce((p_changes ->> 'supersede_active_plan')::boolean, false) then
        update training_plans set status = 'superseded'
        where user_id = p_user_id and status = 'active';
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'delete_session_ids', '[]'::jsonb)) > 0 then
        delete from planned_sessions
        where user_id = p_user_id
          and id in (select jsonb_array_elements_text(p_changes -> 'delete_session_ids')::uuid);
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'upsert_plans', '[]'::jsonb)) > 0 then
        insert into training_plans
            (id, user_id, start_date, end_date, weeks, status, baseline_volume, notice,
             last_adaptation, created_at)
        select r.id, p_user_id, r.start_date, r.end_date, r.weeks, r.status, r.baseline_volume,
               r.notice, r.last_adaptation, r.created_at
        from jsonb_to_recordset(p_changes -> 'upsert_plans') as r(
            id uuid, start_date date, end_date date, weeks smallint, status text,
            baseline_volume numeric, notice text, last_adaptation jsonb, created_at timestamptz)
        on conflict (id) do update
            set status = excluded.status,
                baseline_volume = excluded.baseline_volume,
                last_adaptation = excluded.last_adaptation
            where training_plans.user_id = p_user_id;
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'upsert_sessions', '[]'::jsonb)) > 0 then
        insert into planned_sessions
            (id, user_id, plan_id, date, activity_type, target_volume, target_duration_min,
             intensity_band, status)
        select r.id, p_user_id, r.plan_id, r.date, r.activity_type, r.target_volume,
               r.target_duration_min, r.intensity_band, r.status
        from jsonb_to_recordset(p_changes -> 'upsert_sessions') as r(
            id uuid, plan_id uuid, date date, activity_type text, target_volume numeric,
            target_duration_min integer, intensity_band text, status text)
        on conflict (id) do update
            set date = excluded.date,
                activity_type = excluded.activity_type,
                target_volume = excluded.target_volume,
                target_duration_min = excluded.target_duration_min,
                intensity_band = excluded.intensity_band,
                status = excluded.status
            where planned_sessions.user_id = p_user_id;
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'insert_workouts', '[]'::jsonb)) > 0 then
        insert into workout_sessions
            (id, user_id, planned_session_id, date, activity_type, actual_volume,
             actual_duration_min, rpe, avg_hr, source, created_at)
        select r.id, p_user_id, r.planned_session_id, r.date, r.activity_type, r.actual_volume,
               r.actual_duration_min, r.rpe, r.avg_hr, r.source, r.created_at
        from jsonb_to_recordset(p_changes -> 'insert_workouts') as r(
            id uuid, planned_session_id uuid, date date, activity_type text, actual_volume numeric,
            actual_duration_min integer, rpe smallint, avg_hr smallint, source text,
            created_at timestamptz);
    end if;
end;
$$;

revoke all on function public.training_apply_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.training_apply_changes(uuid, jsonb) to service_role;
