-- Training routine, eighth step: the weekly progression a plan was built with.
--
-- Run after 20261012000000_training_logs_distance.sql (which defines the write function). Safe to run again. If that
-- migration is applied after this one it replaces the write function with its own body, which has no progression_pct:
-- training_schema_features() then stops saying "progression" and the backend goes back to the standard rate, so nothing
-- is lost, but run this one again to bring the rate back.
--
-- A plan's weekly load used to rise by a fixed 5% for everyone. It now rises by a rate estimated from the athlete's own
-- logged training (backend/app/training/forecast.py), so the plan has to remember which rate it was built with: the
-- targets for each week (including the cap a hand-planned session is shared out under) are worked out from the plan's
-- baseline and this rate. NULL means the standard rate, which is what every plan made before this migration has.
--
-- training_schema_features() is how the backend asks whether this migration has been applied: it now answers
-- {"calories": true, "progression": true}. The column alone doesn't prove the write function stores the rate, so until
-- the backend sees "progression" it builds plans at the standard rate and writes nothing it could lose.
--
-- The write function is replaced with the body from 20261012000000 plus the rate in the plan upsert. A payload without
-- it (an older backend) leaves a stored rate as it was. Existing plans and every other table are untouched.

alter table public.training_routine_plans
    add column if not exists progression_pct numeric(5, 2);

-- There is no "add constraint if not exists", hence the guard.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.training_routine_plans'::regclass
          and conname = 'training_routine_plans_progression_range'
    ) then
        alter table public.training_routine_plans
            add constraint training_routine_plans_progression_range
            check (progression_pct is null or (progression_pct >= 0 and progression_pct <= 20));
    end if;
end
$$;

create or replace function public.training_schema_features()
returns jsonb
language sql
stable
set search_path = public
as $$
    select jsonb_build_object('calories', true, 'distance', true, 'progression', true);
$$;

revoke all on function public.training_schema_features() from public, anon, authenticated;
grant execute on function public.training_schema_features() to service_role;

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
             goal, last_adaptation, progression_pct, created_at)
        select r.id, p_user_id, r.start_date, r.end_date, r.weeks, r.status, r.baseline_volume,
               r.notice, r.goal, r.last_adaptation, r.progression_pct, r.created_at
        from jsonb_to_recordset(p_changes -> 'upsert_plans') as r(
            id uuid, start_date date, end_date date, weeks smallint, status text,
            baseline_volume numeric, notice text, goal text, last_adaptation jsonb,
            progression_pct numeric, created_at timestamptz)
        on conflict (id) do update
            set status = excluded.status,
                baseline_volume = excluded.baseline_volume,
                goal = excluded.goal,
                last_adaptation = excluded.last_adaptation,
                -- a payload that doesn't mention it (an older backend) leaves the stored rate alone
                progression_pct = coalesce(excluded.progression_pct, training_routine_plans.progression_pct)
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
             actual_duration_min, rpe, avg_hr, calories, distance_m, source, created_at)
        select r.id, p_user_id, r.planned_session_id, r.date, r.activity_type, r.actual_volume,
               r.actual_duration_min, r.rpe, r.avg_hr, r.calories, r.distance_m, r.source, r.created_at
        from jsonb_to_recordset(p_changes -> 'insert_workouts') as r(
            id uuid, planned_session_id uuid, date date, activity_type text, actual_volume numeric,
            actual_duration_min integer, rpe smallint, avg_hr smallint, calories integer, distance_m numeric,
            source text, created_at timestamptz);
    end if;
end;
$$;

revoke all on function public.training_apply_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.training_apply_changes(uuid, jsonb) to service_role;
