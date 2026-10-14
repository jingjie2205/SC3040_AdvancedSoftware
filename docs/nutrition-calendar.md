# Nutrition calendar

Apply `supabase/migrations/20261011_nutrition_calorie_targets.sql` to the shared team database before using the calendar.

Select a calendar day, enter its total calorie budget in **Daily target (kcal)**, and choose **Save day's target**. This changes only that date, for example to allow more calories for a planned workout. Workout scheduling does not automatically change targets yet; the future planner can use the API below. No additional migration is needed for manual editing.

`GET /api/nutrition/calendar?start_date=2026-10-11&end_date=2026-10-17&offset_minutes=480`
returns up to 31 inclusive dates with logged intake, meal count, daily target and target source.
No meals means zero logged calories; an unknown meal total remains null. Profile estimates use the same calculation as Settings and are not historical snapshots.

The future AI planner can call `PUT /api/nutrition/targets` with the user's bearer token:

```json
{"targets":[{"date":"2026-10-11","target_calories":2200},{"date":"2026-10-12","target_calories":2400}]}
```

This atomically upserts 1–31 distinct dates for the authenticated user. Omitted dates and meal intake remain unchanged. Repeated writes replace that day's target. Targets must be positive integers up to 100000. The frontend helper is `saveCalorieTargets`; backend planners can use `save_calorie_targets` with the authenticated user's ID. Saved targets override profile estimates. A missing or incomplete profile leaves unsaved targets unset.
