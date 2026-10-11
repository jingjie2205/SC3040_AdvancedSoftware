-- Training routine, sixth step: calories on a training log.
--
-- Run after 20261007120000_training_inputs.sql (which defines the write function) and
-- 20261010100000_training_strava_logs.sql. Safe to run again.
--
-- The athlete can enter the calories a workout burned when they log it. The Home page's training card reads
-- calories from the logged workouts; until now the API accepted them and nothing kept them, so it showed 0 kcal.
--
-- The live project already had a calories column on training_workout_logs (bigint, nullable), added by hand, with a
-- few values typed in and nothing in this repo that created or wrote it. So the column is only added where it is
-- missing (an existing one is left exactly as it is, type and values), a range check is added either way, and the
-- write function is replaced with the body from 20261007120000 plus calories in the workout insert. A payload
-- without calories (an older backend) still works: the column is left empty. Existing logs are unchanged, and a
-- saved Strava activity has none (Strava's activity list doesn't carry calories).
--
-- training_schema_features() is how the backend asks whether this migration has been applied: it answers
-- {"calories": true} only once the write function stores calories. The column alone doesn't prove that, and a log
-- saved without its calories would look fine while the number the athlete typed vanished.

alter table public.training_workout_logs
    add column if not exists calories integer;

-- There is no "add constraint if not exists", hence the guard.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.training_workout_logs'::regclass
          and conname = 'training_workout_logs_calories_range'
    ) then
        alter table public.training_workout_logs
            add constraint training_workout_logs_calories_range
            check (calories is null or (calories >= 0 and calories <= 100000));
    end if;
end
$$;

create or replace function public.training_schema_features()
returns jsonb
language sql
stable
set search_path = public
as $$
    select jsonb_build_object('calories', true);
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
             actual_duration_min, rpe, avg_hr, calories, source, created_at)
        select r.id, p_user_id, r.planned_session_id, r.date, r.activity_type, r.actual_volume,
               r.actual_duration_min, r.rpe, r.avg_hr, r.calories, r.source, r.created_at
        from jsonb_to_recordset(p_changes -> 'insert_workouts') as r(
            id uuid, planned_session_id uuid, date date, activity_type text, actual_volume numeric,
            actual_duration_min integer, rpe smallint, avg_hr smallint, calories integer, source text,
            created_at timestamptz);
    end if;
end;
$$;

revoke all on function public.training_apply_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.training_apply_changes(uuid, jsonb) to service_role;
