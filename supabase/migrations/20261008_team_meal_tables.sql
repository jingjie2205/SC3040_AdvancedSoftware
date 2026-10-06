-- Run against the team's existing users, meal_plans and food_items schema.
-- Do not run the older scaffold schema or 20261007_nutrition.sql for this project.
BEGIN;

ALTER TABLE public.meal_plans
    ADD COLUMN IF NOT EXISTS meal_name text,
    ADD COLUMN IF NOT EXISTS meal_type text,
    ADD COLUMN IF NOT EXISTS training_context_note text;

CREATE INDEX IF NOT EXISTS meal_plans_user_timestamp_idx
    ON public.meal_plans (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS food_items_log_idx ON public.food_items (log_id);

ALTER TABLE public.meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meal_plans, public.food_items FROM anon;

-- Restrictive policies also constrain any existing permissive team policies.
DROP POLICY IF EXISTS nutrition_meal_owner_guard ON public.meal_plans;
CREATE POLICY nutrition_meal_owner_guard ON public.meal_plans
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS nutrition_meal_owner_read ON public.meal_plans;
CREATE POLICY nutrition_meal_owner_read ON public.meal_plans
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS nutrition_food_owner_guard ON public.food_items;
CREATE POLICY nutrition_food_owner_guard ON public.food_items
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.meal_plans AS meal
        WHERE meal.log_id = food_items.log_id AND meal.user_id = (SELECT auth.uid())))
    WITH CHECK (EXISTS (SELECT 1 FROM public.meal_plans AS meal
        WHERE meal.log_id = food_items.log_id AND meal.user_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS nutrition_food_owner_read ON public.food_items;
CREATE POLICY nutrition_food_owner_read ON public.food_items
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.meal_plans AS meal
        WHERE meal.log_id = food_items.log_id AND meal.user_id = (SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.save_nutrition_meal(p_user_id uuid, p_meal jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
    meal_id uuid := (p_meal->>'id')::uuid;
    inserted_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE user_id = p_user_id) THEN
        RAISE EXCEPTION 'Profile required' USING ERRCODE = '23503';
    END IF;
    IF jsonb_typeof(p_meal->'items') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_meal->'items') NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'Meal ingredients required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.meal_plans
        (log_id, user_id, timestamp, meal_name, meal_type, training_context_note,
         confidence_score, total_calories)
    VALUES
        (meal_id, p_user_id, (p_meal->>'logged_at')::timestamptz,
         p_meal->>'meal_name', p_meal->>'meal_type', p_meal->>'training_context_note',
         (p_meal->>'confidence_score')::numeric,
         (SELECT round(sum((item->>'calories')::numeric), 1)
          FROM jsonb_array_elements(p_meal->'items') AS item))
    ON CONFLICT (log_id) DO NOTHING
    RETURNING log_id INTO inserted_id;

    IF inserted_id IS NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.meal_plans
                       WHERE log_id = meal_id AND user_id = p_user_id) THEN
            RAISE EXCEPTION 'Meal ID unavailable' USING ERRCODE = '23505';
        END IF;
        RETURN meal_id;
    END IF;

    INSERT INTO public.food_items
        (log_id, name, estimated_weight, calories, protein, carbs, fats)
    SELECT meal_id, item->>'name', (item->>'estimated_weight_g')::numeric,
           (item->>'calories')::numeric, (item->>'protein_g')::numeric,
           (item->>'carbs_g')::numeric, (item->>'fat_g')::numeric
    FROM jsonb_array_elements(p_meal->'items') AS item;
    RETURN meal_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_nutrition_meal(p_user_id uuid, p_log_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
    PERFORM 1 FROM public.meal_plans
        WHERE log_id = p_log_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    DELETE FROM public.food_items WHERE log_id = p_log_id;
    DELETE FROM public.meal_plans WHERE log_id = p_log_id AND user_id = p_user_id;
    RETURN true;
END;
$$;

-- Ownership comes from the verified bearer token in FastAPI, never browser input.
REVOKE ALL ON FUNCTION public.save_nutrition_meal(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_nutrition_meal(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_nutrition_meal(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_nutrition_meal(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
