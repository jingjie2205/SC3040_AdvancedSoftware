BEGIN;

CREATE TABLE public.nutrition_calorie_targets (
    user_id uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
    date date NOT NULL,
    target_calories integer NOT NULL CHECK (target_calories > 0 AND target_calories <= 100000),
    PRIMARY KEY (user_id, date)
);

ALTER TABLE public.nutrition_calorie_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nutrition_calorie_targets FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nutrition_calorie_targets TO authenticated, service_role;
CREATE POLICY nutrition_target_owner ON public.nutrition_calorie_targets
    FOR ALL TO authenticated
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMIT;
