-- Legacy scaffold: not the shared team database schema.
-- Meal analysis now uses migrations/20261008_team_meal_tables.sql on the existing team tables.
CREATE TABLE IF NOT EXISTS public.meals (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    meal_name TEXT NOT NULL CHECK (length(trim(meal_name)) BETWEEN 1 AND 160),
    meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    total_calories NUMERIC NOT NULL CHECK (total_calories >= 0),
    protein_g NUMERIC NOT NULL CHECK (protein_g >= 0),
    carbs_g NUMERIC NOT NULL CHECK (carbs_g >= 0),
    fat_g NUMERIC NOT NULL CHECK (fat_g >= 0),
    confidence_score REAL NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    training_context_note TEXT NOT NULL DEFAULT '',
    breakdown JSONB NOT NULL CHECK (jsonb_typeof(breakdown) = 'array'),
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meals_user_logged ON public.meals(user_id, logged_at DESC);
ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own meals" ON public.meals;
CREATE POLICY "Users can view own meals" ON public.meals FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own meals" ON public.meals;
CREATE POLICY "Users can insert own meals" ON public.meals FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own meals" ON public.meals;
CREATE POLICY "Users can update own meals" ON public.meals FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own meals" ON public.meals;
CREATE POLICY "Users can delete own meals" ON public.meals FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- NULL means calorie burn has not been imported, rather than no energy expended.
ALTER TABLE public.activities ADD COLUMN IF NOT EXISTS calories NUMERIC CHECK (calories >= 0);
