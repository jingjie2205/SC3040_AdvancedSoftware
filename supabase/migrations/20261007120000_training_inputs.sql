-- Training routine, second step: inputs that had nowhere to live, and tighter table privileges.
--
-- Run after 20260930000000_training_routine.sql. Safe to run again: every statement is guarded or
-- replaces what it created last time. Everything here belongs to the training routine; it touches no
-- other feature's table.
--
-- Adds
--   training_preferences.exam_dates   upcoming exam dates. Readiness drops a little in the week before one.
--   training_routine_plans.goal       the profile goal a plan was built for (lose_weight, maintain, build_muscle)
--   training_sleep_logs               last night's sleep, entered on the Today card, one row per user and day
--
-- Hard Rule 4: like readiness scores, exam dates and sleep are private to the owning user. Their only
-- read policies are "select own", and nothing friend-facing may ever read them.

alter table public.training_preferences
    add column if not exists exam_dates date[] not null default '{}'
        check (cardinality(exam_dates) <= 10);

alter table public.training_routine_plans
    add column if not exists goal text
        check (goal in ('lose_weight', 'maintain', 'build_muscle'));

create table if not exists public.training_sleep_logs (
    user_id uuid not null references auth.users(id) on delete cascade,
    date date not null,
    hours numeric(4, 2) not null check (hours >= 0 and hours <= 16),
    primary key (user_id, date)
);

alter table public.training_sleep_logs enable row level security;

drop policy if exists "Users can view own sleep logs" on public.training_sleep_logs;
create policy "Users can view own sleep logs"
    on public.training_sleep_logs for select using (auth.uid() = user_id);

-- The same function as before, with plans now carrying their goal. A payload without a goal (an older
-- backend) still works: the goal is simply left empty.
create or replace function public.training_apply_changes(p_user_id uuid, p_changes jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
    if coalesce((p_changes ->> 'supersede_active_plan')::boolean, false) then
        update training_routine_plans set status = 'superseded'
        where user_id = p_user_id and status = 'active';
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'delete_session_ids', '[]'::jsonb)) > 0 then
        delete from planned_sessions
        where user_id = p_user_id
          and id in (select jsonb_array_elements_text(p_changes -> 'delete_session_ids')::uuid);
    end if;

    if jsonb_array_length(coalesce(p_changes -> 'upsert_plans', '[]'::jsonb)) > 0 then
        insert into training_routine_plans
            (id, user_id, start_date, end_date, weeks, status, baseline_volume, notice,
             goal, last_adaptation, created_at)
        select r.id, p_user_id, r.start_date, r.end_date, r.weeks, r.status, r.baseline_volume,
               r.notice, r.goal, r.last_adaptation, r.created_at
        from jsonb_to_recordset(p_changes -> 'upsert_plans') as r(
            id uuid, start_date date, end_date date, weeks smallint, status text,
            baseline_volume numeric, notice text, goal text, last_adaptation jsonb,
            created_at timestamptz)
        on conflict (id) do update
            set status = excluded.status,
                baseline_volume = excluded.baseline_volume,
                goal = excluded.goal,
                last_adaptation = excluded.last_adaptation
            where training_routine_plans.user_id = p_user_id;
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
        insert into training_workout_logs
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

-- Privileges. Every write to these tables comes from the backend's service role, so nobody else needs
-- the right to write. Row-level security already refuses a signed-in user's writes (there is no write
-- policy); taking the privileges away as well means a policy added or loosened by mistake later can't
-- open the tables up. Signed-in users keep SELECT, limited by RLS to their own rows. Signed-out
-- visitors get nothing.
revoke all on
    public.training_preferences,
    public.training_routine_plans,
    public.planned_sessions,
    public.training_workout_logs,
    public.readiness_scores,
    public.training_sleep_logs
    from anon;

revoke insert, update, delete, truncate, references, trigger on
    public.training_preferences,
    public.training_routine_plans,
    public.planned_sessions,
    public.training_workout_logs,
    public.readiness_scores,
    public.training_sleep_logs
    from authenticated;
