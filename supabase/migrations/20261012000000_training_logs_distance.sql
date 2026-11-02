-- Training routine, seventh step: a distance on a hand-logged run or ride.
--
-- Run after 20261011200000_training_logs_calories.sql (whose write function this replaces) and
-- 20261011200000_training_strava_distance.sql (which adds the distance_m column). Safe to run again.
--
-- The Log workout form takes an optional distance for a run or a ride. It is kept in training_workout_logs.distance_m
-- (metres), the same column a saved Strava activity fills, so the leaderboard's running mileage counts runs logged by
-- hand as well as runs saved from Strava. No training calculation reads it.
--
-- The write function is the body from 20261011200000_training_logs_calories.sql plus distance_m in the workout
-- insert. A payload without distance_m (an older backend) still works: the column is left empty.
-- training_schema_features() now also answers {"distance": true}, so the backend refuses a distance rather than
-- dropping it on a database that hasn't had this migration.

alter table public.training_workout_logs
    add column if not exists distance_m numeric(9, 1)
        check (distance_m >= 0);

create or replace function public.training_schema_features()
returns jsonb
language sql
stable
set search_path = public
as $$
    select jsonb_build_object('calories', true, 'distance', true);
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
