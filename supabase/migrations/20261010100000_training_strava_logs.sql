-- Training routine, third step: activities saved from Strava into the training log.
--
-- Run after 20261007120000_training_inputs.sql. Safe to run again: every statement is guarded. It changes one
-- table, training_workout_logs, and adds nothing else.
--
-- A saved Strava activity is an ordinary training log with source = 'strava'. It needs one thing a manual log
-- doesn't: the id of the Strava activity it came from, so saving the same activity twice is a no-op (the
-- unique index below) and the training page can link back to it.
--
-- Hard Rule 1: Strava data never reaches an AI feature. These rows are flagged source = 'strava', and every
-- calculation in the training backend (the readiness features, the plan baseline, the summary, the coach) drops
-- them before it counts anything. They are shown on the schedule and nowhere else. They are never linked to a
-- planned session, and saving one awards no XP.

alter table public.training_workout_logs
    add column if not exists external_id text
        check (char_length(external_id) between 1 and 40);

-- One log per Strava activity per person. A manual log has no external_id, and Postgres treats nulls as
-- distinct, so any number of manual logs coexist.
create unique index if not exists training_workout_logs_external_id_unique
    on public.training_workout_logs (user_id, source, external_id);

-- A Strava log always names its activity. (There is no "add constraint if not exists", hence the guard.)
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.training_workout_logs'::regclass
          and conname = 'training_workout_logs_strava_names_its_activity'
    ) then
        alter table public.training_workout_logs
            add constraint training_workout_logs_strava_names_its_activity
            check (source <> 'strava' or external_id is not null);
    end if;
end
$$;
