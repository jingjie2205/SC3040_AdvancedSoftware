-- Training routine, fourth step: keep the distance of activities saved from Strava.
--
-- Run after 20261010100000_training_strava_logs.sql. Safe to run again. It adds one nullable column to
-- training_workout_logs and changes nothing else.
--
-- The Strava tab already shows each activity's distance on its card. Saving it now keeps that distance too,
-- so the leaderboard can rank friends by running mileage (SRS 2.1.8.2 / G-3). Manual logs have no distance
-- (NULL). Hard Rule 1 is amended to allow exactly this: the leaderboard may sum distance_m of saved runs;
-- every training calculation (readiness, plan, summary, coach) still drops Strava logs and never reads it.

alter table public.training_workout_logs
    add column if not exists distance_m numeric(9, 1)
        check (distance_m >= 0);

comment on column public.training_workout_logs.distance_m is
    'Metres, from Strava for logs saved from it; NULL for manual logs. Read only by the leaderboard mileage view.';
