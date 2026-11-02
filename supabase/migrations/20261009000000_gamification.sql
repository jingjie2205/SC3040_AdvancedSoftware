-- Gamification (G-1 to G-4): XP, daily check-in questionnaire, leaderboard and shared challenges.
--
-- Depends only on auth.users. The live database already has an older, unused gamification_stats
-- table with different columns, so the stats table here is gamification_user_stats instead.
-- daily_checkins (questionnaire) is separate from daily_check_ins (calendar dates, /checkin API).
--
-- Access model: the FastAPI backend uses the service-role key for every write, so clients cannot
-- award themselves XP. RLS only grants users SELECT on their own rows.
--
-- Safe to re-run: tables and indexes are created if missing and policies are recreated.
BEGIN;

-- Running totals per user; rank is derived from total_xp, not stored.
CREATE TABLE IF NOT EXISTS public.gamification_user_stats (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
    current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
    last_check_in_date DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Interactive daily check-in questionnaire (1 = low, 5 = high).
CREATE TABLE IF NOT EXISTS public.daily_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    date DATE NOT NULL,
    muscle_fatigue SMALLINT NOT NULL CHECK (muscle_fatigue BETWEEN 1 AND 5),
    mood SMALLINT NOT NULL CHECK (mood BETWEEN 1 AND 5),
    diet_adherence SMALLINT NOT NULL CHECK (diet_adherence BETWEEN 1 AND 5),
    xp_awarded INTEGER NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, date)
);

-- Append-only XP ledger; total_xp in gamification_user_stats is the sum of these.
CREATE TABLE IF NOT EXISTS public.xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('checkin', 'workout', 'meal', 'challenge')),
    source_id UUID,
    amount INTEGER NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared fitness challenges. Progress is not stored: it is computed from xp_events and
-- daily_checkins within [start_date, end_date] when read.
CREATE TABLE IF NOT EXISTS public.challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    metric TEXT NOT NULL CHECK (metric IN ('sessions', 'checkin_streak', 'xp')),
    target_value INTEGER NOT NULL CHECK (target_value > 0),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS public.challenge_participants (
    challenge_id UUID REFERENCES public.challenges(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'declined')),
    joined_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (challenge_id, user_id)
);

-- Prevents the same workout/meal/check-in from being awarded XP twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_events_source_unique
    ON public.xp_events(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xp_events_user_date ON public.xp_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gamification_user_stats_xp ON public.gamification_user_stats(total_xp DESC);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user ON public.challenge_participants(user_id);

ALTER TABLE public.gamification_user_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own gamification stats" ON public.gamification_user_stats;
CREATE POLICY "Users can view own gamification stats"
    ON public.gamification_user_stats FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own check-ins" ON public.daily_checkins;
CREATE POLICY "Users can view own check-ins"
    ON public.daily_checkins FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own XP events" ON public.xp_events;
CREATE POLICY "Users can view own XP events"
    ON public.xp_events FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view challenges they created or joined" ON public.challenges;
CREATE POLICY "Users can view challenges they created or joined"
    ON public.challenges FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = creator_id
        OR EXISTS (
            SELECT 1 FROM public.challenge_participants cp
            WHERE cp.challenge_id = challenges.id AND cp.user_id = (SELECT auth.uid())
        )
    );

DROP POLICY IF EXISTS "Users can view own challenge participation" ON public.challenge_participants;
CREATE POLICY "Users can view own challenge participation"
    ON public.challenge_participants FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

COMMIT;
