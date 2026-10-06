-- Supabase PostgreSQL Schema for AI-Driven Endurance Platform

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Athlete profiles & Strava tokens
CREATE TABLE IF NOT EXISTS public.athlete_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    strava_athlete_id BIGINT UNIQUE,
    strava_access_token TEXT,
    strava_refresh_token TEXT,
    strava_token_expires_at BIGINT,
    rest_hr INTEGER NOT NULL DEFAULT 60,
    max_hr INTEGER NOT NULL DEFAULT 190,
    gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
    weight_kg NUMERIC(5,2) DEFAULT 70.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activities & TRIMP telemetry
CREATE TABLE IF NOT EXISTS public.activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    strava_activity_id BIGINT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    elapsed_time INTEGER NOT NULL,
    moving_time INTEGER NOT NULL,
    distance NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_elevation_gain NUMERIC(8,2) NOT NULL DEFAULT 0,
    average_heartrate NUMERIC(5,2),
    max_heartrate NUMERIC(5,2),
    trimp_score NUMERIC(8,2) NOT NULL DEFAULT 0,
    streams_summary JSONB,
    raw_streams JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily aggregated training loads & ACWR
CREATE TABLE IF NOT EXISTS public.daily_training_loads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    date DATE NOT NULL,
    daily_trimp NUMERIC(8,2) NOT NULL DEFAULT 0,
    acute_load_7d NUMERIC(8,2) NOT NULL DEFAULT 0,
    chronic_load_28d NUMERIC(8,2) NOT NULL DEFAULT 0,
    acwr NUMERIC(5,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, date)
);

-- AI Recovery & Workout Recommendations
CREATE TABLE IF NOT EXISTS public.ai_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    date DATE NOT NULL,
    readiness_score INTEGER NOT NULL,
    injury_risk_level TEXT NOT NULL,
    recovery_status TEXT NOT NULL,
    recommended_workout JSONB NOT NULL,
    coaching_rationale TEXT NOT NULL,
    raw_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_activities_user_date ON public.activities(user_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_loads_user_date ON public.daily_training_loads(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_athlete_strava_id ON public.athlete_profiles(strava_athlete_id);

-- Row Level Security (RLS)
ALTER TABLE public.athlete_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_training_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_recommendations ENABLE ROW LEVEL SECURITY;

-- Athlete Profiles Policies
CREATE POLICY "Users can view own profile"
    ON public.athlete_profiles FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
    ON public.athlete_profiles FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
    ON public.athlete_profiles FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Activities Policies
CREATE POLICY "Users can view own activities"
    ON public.activities FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own activities"
    ON public.activities FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Daily Training Loads Policies
CREATE POLICY "Users can view own loads"
    ON public.daily_training_loads FOR SELECT
    USING (auth.uid() = user_id);

-- AI Recommendations Policies
CREATE POLICY "Users can view own recommendations"
    ON public.ai_recommendations FOR SELECT
    USING (auth.uid() = user_id);

-- ============================================================================
-- Gamification (G-1 to G-4)
-- XP, streaks and check-ins are written only by the backend (service role) so
-- clients cannot award themselves XP; RLS therefore grants SELECT only.
-- ============================================================================

-- Running totals per user; rank is derived from total_xp, not stored
CREATE TABLE IF NOT EXISTS public.gamification_stats (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
    current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
    last_check_in_date DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Interactive daily check-in questionnaire (1 = low, 5 = high)
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

-- Append-only XP ledger; total_xp in gamification_stats is the sum of these
CREATE TABLE IF NOT EXISTS public.xp_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('checkin', 'workout', 'meal', 'challenge')),
    source_id UUID,
    amount INTEGER NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared fitness challenges between friends. Progress is not stored: it is computed
-- from xp_events and daily_checkins within [start_date, end_date] when read.
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

-- Prevents the same workout/meal/check-in from being awarded XP twice
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_events_source_unique
    ON public.xp_events(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xp_events_user_date ON public.xp_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gamification_stats_xp ON public.gamification_stats(total_xp DESC);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user ON public.challenge_participants(user_id);

ALTER TABLE public.gamification_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own gamification stats"
    ON public.gamification_stats FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view own check-ins"
    ON public.daily_checkins FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view own XP events"
    ON public.xp_events FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view challenges they created or joined"
    ON public.challenges FOR SELECT
    USING (
        auth.uid() = creator_id
        OR EXISTS (
            SELECT 1 FROM public.challenge_participants cp
            WHERE cp.challenge_id = challenges.id AND cp.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view own challenge participation"
    ON public.challenge_participants FOR SELECT
    USING (auth.uid() = user_id);
