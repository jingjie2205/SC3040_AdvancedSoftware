-- Gamification, fourth step: pending XP (G-2 exception flow).
--
-- Run after 20261010000000_gamification_merge_checkins.sql. Safe to run again.
--
-- Before a workout or meal earns XP it is checked. If the check fails, or the award itself errors,
-- the XP is held in pending_xp with a reason instead of being lost. The user sees the held XP on the
-- Leaderboard page and can re-sync: resync_gamification_xp checks each held item again, pays the ones
-- that now pass, and drops the ones whose workout or meal was deleted.
--
-- Checks (gamification_xp_problem):
--   workout  dated after today in Singapore (the training API takes "today" from the user's device)
--   meal     no calorie estimate (total_calories missing or 0)
--
-- While an item is held, award_gamification_xp ignores it, so a direct award from another feature
-- (training also calls award_xp after logging) can't bypass the hold.
BEGIN;

CREATE TABLE IF NOT EXISTS public.pending_xp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('workout', 'meal')),
    source_id UUID NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, source, source_id)
);

ALTER TABLE public.pending_xp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own pending XP" ON public.pending_xp;
CREATE POLICY "Users can view own pending XP"
    ON public.pending_xp FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- NULL when the activity may earn XP, 'missing' when it no longer exists, otherwise a message for the user.
CREATE OR REPLACE FUNCTION public.gamification_xp_problem(p_source text, p_source_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    workout_date date;
    calories numeric;
BEGIN
    IF p_source = 'workout' THEN
        SELECT date INTO workout_date FROM public.training_workout_logs WHERE id = p_source_id;
        IF NOT FOUND THEN
            RETURN 'missing';
        END IF;
        IF workout_date > (now() AT TIME ZONE 'Asia/Singapore')::date THEN
            RETURN 'This workout is dated in the future. It can earn XP from that day on.';
        END IF;
    ELSIF p_source = 'meal' THEN
        SELECT total_calories INTO calories FROM public.meal_plans WHERE log_id = p_source_id;
        IF NOT FOUND THEN
            RETURN 'missing';
        END IF;
        IF coalesce(calories, 0) <= 0 THEN
            RETURN 'This meal has no calorie estimate. Add its ingredients and re-sync.';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- As in 20261009120000, plus: an item held in pending_xp is not awarded.
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
    IF p_source_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.pending_xp
        WHERE user_id = p_user_id AND source = p_source AND source_id = p_source_id
    ) THEN
        SELECT total_xp INTO new_total FROM public.gamification_user_stats WHERE user_id = p_user_id;
        RETURN coalesce(new_total, 0);
    END IF;

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

-- XP amounts must match XP_REWARDS in backend/app/services/gamification.py.
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

-- Returns {awardedXp, released, stillPending, removed}.
CREATE OR REPLACE FUNCTION public.resync_gamification_xp(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
    item record;
    problem text;
    awarded_xp integer := 0;
    released integer := 0;
    still_pending integer := 0;
    removed integer := 0;
BEGIN
    FOR item IN
        SELECT * FROM public.pending_xp WHERE user_id = p_user_id ORDER BY created_at FOR UPDATE
    LOOP
        problem := public.gamification_xp_problem(item.source, item.source_id);
        IF problem = 'missing' THEN
            DELETE FROM public.pending_xp WHERE id = item.id;
            removed := removed + 1;
        ELSIF problem IS NULL THEN
            DELETE FROM public.pending_xp WHERE id = item.id;
            PERFORM public.award_gamification_xp(item.user_id, item.source, item.source_id, item.amount);
            awarded_xp := awarded_xp + item.amount;
            released := released + 1;
        ELSE
            UPDATE public.pending_xp SET reason = problem, checked_at = now() WHERE id = item.id;
            still_pending := still_pending + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'awardedXp', awarded_xp, 'released', released,
        'stillPending', still_pending, 'removed', removed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.gamification_xp_problem(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.award_gamification_xp(uuid, text, uuid, integer, timestamptz)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resync_gamification_xp(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gamification_award_logged_activity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_gamification_xp(uuid, text, uuid, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.resync_gamification_xp(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.gamification_xp_problem(text, uuid) TO service_role;

COMMIT;
