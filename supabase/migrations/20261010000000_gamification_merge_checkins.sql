-- Gamification, third step: one check-in table.
--
-- Run after 20261009120000_gamification_xp_sources.sql. Safe to run again.
--
-- The home-page calendar used to record check-ins in daily_check_ins (one row per user holding an array
-- of dates, no answers). daily_checkins (one row per user and day, with the questionnaire answers) is now
-- the only check-in table: the calendar reads its dates from there, and checking in always goes through
-- the questionnaire.
--
-- Dates from daily_check_ins are copied across without answers, so the three answer columns allow NULL
-- for those rows only; the API still requires all three for new check-ins. Each copied day earns the
-- base check-in XP and streaks are recalculated from the merged dates.
--
-- daily_check_ins is left in place and no longer read or written. Drop it once the team agrees.
BEGIN;

ALTER TABLE public.daily_checkins
    ALTER COLUMN muscle_fatigue DROP NOT NULL,
    ALTER COLUMN mood DROP NOT NULL,
    ALTER COLUMN diet_adherence DROP NOT NULL;

COMMENT ON COLUMN public.daily_checkins.muscle_fatigue IS
    'NULL only for check-ins copied from the old daily_check_ins calendar table';

DO $$
DECLARE
    imported_count integer;
BEGIN
    IF to_regclass('public.daily_check_ins') IS NULL THEN
        RETURN;
    END IF;

    WITH imported AS (
        INSERT INTO public.daily_checkins (user_id, date, xp_awarded, created_at)
        SELECT legacy.user_id, day::date, 10,
               (day::date + time '12:00') AT TIME ZONE 'Asia/Singapore'
        FROM public.daily_check_ins AS legacy, unnest(legacy.dates) AS day
        ON CONFLICT (user_id, date) DO NOTHING
        RETURNING id, user_id, created_at
    )
    SELECT count(public.award_gamification_xp(user_id, 'checkin', id, 10, created_at))
    INTO imported_count
    FROM imported;

    RAISE NOTICE 'Copied % check-ins from daily_check_ins', imported_count;
END;
$$;

-- current_streak is the length of the most recent run of consecutive days; the backend treats it as
-- broken if that run ended before yesterday.
WITH numbered AS (
    SELECT user_id, date,
           date - (row_number() OVER (PARTITION BY user_id ORDER BY date))::integer AS run_key
    FROM public.daily_checkins
),
runs AS (
    SELECT user_id, count(*)::integer AS length, max(date) AS last_day
    FROM numbered
    GROUP BY user_id, run_key
),
latest AS (
    SELECT DISTINCT ON (user_id) user_id, length, last_day
    FROM runs
    ORDER BY user_id, last_day DESC
),
longest AS (
    SELECT user_id, max(length) AS length FROM runs GROUP BY user_id
)
INSERT INTO public.gamification_user_stats AS s
    (user_id, current_streak, longest_streak, last_check_in_date, updated_at)
SELECT latest.user_id, latest.length, longest.length, latest.last_day, now()
FROM latest JOIN longest USING (user_id)
ON CONFLICT (user_id) DO UPDATE SET
    current_streak = excluded.current_streak,
    longest_streak = greatest(s.longest_streak, excluded.longest_streak),
    last_check_in_date = excluded.last_check_in_date,
    updated_at = now();

COMMIT;
