-- Gamification, second step: XP from workouts and meals, atomic XP awards, per-user challenge rewards.
--
-- Run after 20261009000000_gamification.sql and the training and meal migrations. Safe to run again.
--
-- award_gamification_xp records an XP event and bumps the running total in one statement pair inside
-- the caller's transaction, so concurrent awards can't lose an increment. Awarding the same
-- (user, source, source_id) twice is a no-op.
--
-- Workout and meal XP come from triggers on training_workout_logs and meal_plans, so the training and
-- nutrition code doesn't have to call into gamification. A failing award never blocks the workout or
-- meal insert: it is logged as a warning instead.
BEGIN;

-- Challenge rewards share the challenge id across participants, so uniqueness must include the user.
DROP INDEX IF EXISTS public.idx_xp_events_source_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_events_user_source_unique
    ON public.xp_events(user_id, source, source_id) WHERE source_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.award_gamification_xp(
    p_user_id uuid,
    p_source text,
    p_source_id uuid,
    p_amount integer,
    p_occurred_at timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
    new_total integer;
BEGIN
    INSERT INTO public.xp_events (user_id, source, source_id, amount, created_at)
    VALUES (p_user_id, p_source, p_source_id, p_amount, p_occurred_at)
    ON CONFLICT (user_id, source, source_id) WHERE source_id IS NOT NULL DO NOTHING;

    IF NOT FOUND THEN
        SELECT total_xp INTO new_total FROM public.gamification_user_stats WHERE user_id = p_user_id;
        RETURN coalesce(new_total, 0);
    END IF;

    INSERT INTO public.gamification_user_stats AS s (user_id, total_xp, updated_at)
    VALUES (p_user_id, p_amount, now())
    ON CONFLICT (user_id) DO UPDATE
        SET total_xp = s.total_xp + excluded.total_xp, updated_at = now()
    RETURNING s.total_xp INTO new_total;
    RETURN new_total;
END;
$$;

-- Only the backend (service role) may award XP; clients must not be able to call this over the API.
REVOKE ALL ON FUNCTION public.award_gamification_xp(uuid, text, uuid, integer, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_gamification_xp(uuid, text, uuid, integer, timestamptz)
    TO service_role;

-- XP amounts must match XP_REWARDS in backend/app/services/gamification.py.
CREATE OR REPLACE FUNCTION public.gamification_award_logged_activity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    BEGIN
        IF TG_TABLE_NAME = 'training_workout_logs' THEN
            PERFORM public.award_gamification_xp(NEW.user_id, 'workout', NEW.id, 50);
        ELSIF TG_TABLE_NAME = 'meal_plans' THEN
            PERFORM public.award_gamification_xp(NEW.user_id, 'meal', NEW.log_id, 10);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'gamification XP not awarded for % row: %', TG_TABLE_NAME, SQLERRM;
    END;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gamification_award_logged_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS gamification_workout_xp ON public.training_workout_logs;
CREATE TRIGGER gamification_workout_xp
    AFTER INSERT ON public.training_workout_logs
    FOR EACH ROW EXECUTE FUNCTION public.gamification_award_logged_activity();

DROP TRIGGER IF EXISTS gamification_meal_xp ON public.meal_plans;
CREATE TRIGGER gamification_meal_xp
    AFTER INSERT ON public.meal_plans
    FOR EACH ROW EXECUTE FUNCTION public.gamification_award_logged_activity();

-- Credit workouts and meals logged before this migration, dated when they were logged.
SELECT public.award_gamification_xp(user_id, 'workout', id, 50, created_at)
FROM public.training_workout_logs;
SELECT public.award_gamification_xp(user_id, 'meal', log_id, 10, created_at)
FROM public.meal_plans;

COMMIT;
