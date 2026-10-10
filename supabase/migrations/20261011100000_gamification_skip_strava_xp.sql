-- Gamification, fifth step: an activity saved from Strava earns no XP.
--
-- Run after 20261011000000_gamification_pending_xp.sql. Safe to run again.
--
-- The trigger gamification_workout_xp pays 50 XP for every row inserted into training_workout_logs. Since the
-- Training page's Strava tab saves chosen Strava activities into that table (source = 'strava', see
-- 20261010100000_training_strava_logs.sql), each saved activity would earn 50 XP, "Save all" could pay up to
-- 5,000, removing and saving again would pay again (every save makes new rows), and challenge progress, which is
-- worked out from xp_events, would grow with them. A Strava activity is shown on the schedule and is not a workout
-- the athlete logged, so it earns nothing.
--
-- This replaces gamification_award_logged_activity() with exactly the body from 20261011000000, plus one early
-- return for source = 'strava'. Nothing else changes: workouts and meals earn what they did, the pending-XP hold
-- and re-sync behave as before, and the function keeps its privileges. If the function is changed again later, the
-- change must keep the guard: test_training_strava_isolation.py checks that the newest definition has it.
--
-- Rows already in xp_events are not touched. (If Strava logs were saved before this ran, their XP stays until
-- someone removes it on purpose.)

CREATE OR REPLACE FUNCTION public.gamification_award_logged_activity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    item_source text;
    item_id uuid;
    item_amount integer;
    problem text;
BEGIN
    IF TG_TABLE_NAME = 'training_workout_logs' THEN
        IF NEW.source = 'strava' THEN
            RETURN NEW;
        END IF;
        item_source := 'workout'; item_id := NEW.id; item_amount := 50;
    ELSE
        item_source := 'meal'; item_id := NEW.log_id; item_amount := 10;
    END IF;

    BEGIN
        problem := public.gamification_xp_problem(item_source, item_id);
        IF problem IS NULL THEN
            PERFORM public.award_gamification_xp(NEW.user_id, item_source, item_id, item_amount);
            RETURN NEW;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        problem := 'Your XP for this couldn''t be recorded. Re-sync to try again.';
        RAISE WARNING 'gamification XP not awarded for % %: %', item_source, item_id, SQLERRM;
    END;

    -- Holding the XP must never block the workout or meal from saving.
    BEGIN
        INSERT INTO public.pending_xp (user_id, source, source_id, amount, reason)
        VALUES (NEW.user_id, item_source, item_id, item_amount, problem)
        ON CONFLICT (user_id, source, source_id) DO UPDATE
            SET reason = excluded.reason, checked_at = now();
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'gamification XP not held for % %: %', item_source, item_id, SQLERRM;
    END;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gamification_award_logged_activity() FROM PUBLIC, anon, authenticated;
