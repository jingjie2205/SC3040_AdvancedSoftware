# Meal analysis: shared Supabase setup

The nutrition page at `/dashboard/nutrition` uses the team's existing `public.meal_plans` and `public.food_items` tables. Local SQLite storage, sample photo analysis, and the authentication bypass have been removed. Automated tests still use isolated fixtures; they do not write to the shared project.

## What you need to do

1. In the existing Supabase project's SQL Editor, run `supabase/migrations/20261008_team_meal_tables.sql`. Do **not** run `supabase/schema.sql` or the older `20261007_nutrition.sql`: those describe a different scaffold.
2. Keep the frontend and backend configured for the same Supabase project, using the variables below.
3. Ensure your Supabase Auth account has a matching `public.users` profile: `users.user_id` must equal the Auth user ID. The team's Settings endpoint updates existing profiles; it does not create missing profiles. Use the team's account provisioning flow or ask the database owner to create the matching profile.
4. Stop any previously running demo backend. Start the normal backend and restart the frontend with the commands below.
5. Sign in, open Nutrition, add a manual meal, refresh, and check that it persists. Delete the test meal afterwards. Test photo analysis after adding a Gemini key.

The migration adds nullable `meal_name`, `meal_type`, and `training_context_note` columns without rewriting existing records. It adds indexes, owner-only row access guards, and server-only save/delete functions. Existing policies remain, but the restrictive guards prevent access to another user's meals. Anonymous access to these two tables is revoked. The migration does not touch other feature tables or move old local test meals.

## Environment configuration

| File | Variable | Value |
| --- | --- | --- |
| `backend/.env` | `SUPABASE_URL` | Existing shared project URL |
| `backend/.env` | `SUPABASE_SERVICE_ROLE_KEY` | Server-only service-role key |
| `backend/.env` | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API key for photo analysis |
| `backend/.env` | `GEMINI_NUTRITION_MODEL` | Defaults to `gemini-2.5-flash` |
| `backend/.env` | `FRONTEND_URL` | `http://localhost:3000` for local development |
| `frontend/.env.local` | `NEXT_PUBLIC_SUPABASE_URL` | Same project URL as the backend |
| `frontend/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon/publishable key, never the service-role key |
| `frontend/.env.local` | `NEXT_PUBLIC_BACKEND_URL` | `http://localhost:8000` |

Manual meal entry requires Supabase only. Photo analysis additionally requires Gemini. The implementation reads `GOOGLE_GENERATIVE_AI_API_KEY`, not `GEMINI_API_KEY`. Environment files are ignored by Git. Restart services after changing keys and rebuild deployed frontend assets after changing public variables.

Backend, from `backend/` (the existing virtual environment is already installed):

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Frontend, from `frontend/`:

```powershell
npm run dev
```

Open `http://localhost:3000/login`, then `/dashboard/nutrition`. The current login page uses the team's hardcoded development account. That account must exist in this Supabase project's Auth service; a row in `public.users` alone does not provide authentication.

## Storage and behavior

- Meal IDs map to `meal_plans.log_id`, logged time to `timestamp`, and the authenticated account to `user_id`.
- Ingredients are separate `food_items` rows linked by `log_id`; API weights/macros map to `estimated_weight`, `protein`, `carbs`, and `fats`.
- `save_nutrition_meal` saves the parent and all ingredients in one transaction. Client-generated IDs make retries idempotent. A reused ID belonging to another user is rejected.
- `delete_nutrition_meal` checks ownership and deletes ingredients and the parent together, without depending on the existing foreign key's cascade setting.
- Both functions are executable only by the service role. FastAPI verifies the Supabase bearer token and supplies the user ID; the request cannot override it.
- Historical meals with missing nutrient values remain readable. Unknown totals display a dash rather than a misleading zero.
- Photos are normalized in memory, sent with notes to Gemini, and never saved in the database. Manual review and confirmation are required before any meal is stored.

## BMR and exercise burn

BMR uses the team's existing `users` fields (`age`, `weight`, `height`, and `biological_sex`) and matches the Settings formula. Incomplete profiles leave BMR unavailable.

The inspected shared database has no `activities` table. Exercise burn and net energy therefore remain unavailable; this does not prevent saving meals or calculating food totals. The existing Strava connection stores tokens in `users`, but connecting an account does not itself supply imported calorie records. The current worker is not started by `main.py` and has existing integration issues. Activity ingestion is a separate team integration task.

Where imported activity calories are available, the confirmed calculation is **intake - BMR - exercise burn**. Missing burn is never assumed to be zero.

## API

Every route requires a valid Supabase bearer token.

| Route | Result |
| --- | --- |
| `POST /api/nutrition/analyze` | Analyze multipart photo and optional notes; no database write |
| `POST /api/nutrition/meals` | Validate and atomically save the reviewed meal and ingredients |
| `GET /api/nutrition/daily?day=YYYY-MM-DD&offset_minutes=480` | Local-day meals, totals, BMR and available activity calories |
| `DELETE /api/nutrition/meals/{id}` | Delete an owned meal and its ingredients; 404 if absent/not owned |

Portion edits scale nutrients, while ingredient additions and removals recalculate totals. Feedback remains based on the original photo and notes. Meal timestamps reflect draft creation; the date picker browses history. Date boundaries use the browser's noon UTC offset for the selected day, rather than a full daylight-saving timezone interval.

## Validation and remaining checks

```powershell
# From backend/
.\.venv\Scripts\python.exe -m pytest tests/test_nutrition.py tests/test_strava_integration.py tests/test_gamification.py -q
.\.venv\Scripts\python.exe -m ruff check app/controllers/nutrition.py app/services/nutrition.py tests/test_nutrition.py

# From frontend/
node --test tests/nutrition.test.cjs
node tests/nutrition.browser.cjs
npm run typecheck
```

The browser suite requires an available Playwright installation and Chrome; `PLAYWRIGHT_MODULE` can point to an existing installation. It uses authentication/API fixtures, not live Supabase or Gemini.

Migration preparation passed 82 backend tests, 6 frontend tests, backend lint, and the nutrition/Settings browser regression suite. Read-only live checks confirmed the public Auth key and meal/ingredient relationship work; the save/delete functions are still absent. The project-wide typecheck still reports the pre-existing `app/api/checkin/route` handler error. Remote save/delete, transaction rollback, and RLS behavior must be checked after the SQL migration is applied. Local fixture tests do not execute the PostgreSQL functions.


## Files changed for this migration

- `backend/app/controllers/nutrition.py`: transactional delete function.
- `backend/app/services/nutrition.py`: shared table mapping, transactional save, nullable historical nutrients, and missing activity-table handling.
- `backend/tests/test_nutrition.py`: shared schema and error-path tests.
- `frontend/app/(app)/dashboard/nutrition/page.tsx`: always require login.
- `frontend/app/(app)/dashboard/nutrition/meal-analysis.tsx`: remove demo condition and display unknown historical values accurately.
- `frontend/lib/nutrition.ts`: always send authentication and represent incomplete historical meals.
- `frontend/tests/nutrition.test.cjs`: authentication regression coverage.
- `frontend/tests/nutrition.browser.cjs`: remove retired environment switch.
- `frontend/.env.example`: remove retired environment switch.
- `supabase/migrations/20261008_team_meal_tables.sql`: shared database migration.
- `supabase/migrations/20261007_nutrition.sql` and `supabase/schema.sql`: flag legacy scaffold as unsuitable for the shared project.
- `docs/meal-analysis-setup.md`: revised setup and handoff instructions.
- Removed `backend/app/nutrition_demo.py`, `backend/tests/test_nutrition_demo.py`, and `frontend/tests/nutrition-demo.browser.cjs`.
- Removed the ignored local SQLite test file and the demo flag in ignored `frontend/.env.local`.

The home page and other feature implementations were not changed.
