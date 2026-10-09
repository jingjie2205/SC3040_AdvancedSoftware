# Training routine backend

The API behind the Training page (`frontend/app/(app)/dashboard/training`). It runs inside the existing
FastAPI service; `app/main.py` mounts it with `install_training_routes(app)`.

## Endpoints

All under `/api/v1`, all need `Authorization: Bearer <Supabase access token>`. Send the user's
local date as `X-Client-Date: YYYY-MM-DD` so "today" matches theirs (the server has no timezone data).

| Method | Path | Purpose |
|---|---|---|
| GET / PUT | `/training/preferences` | T-1 read / save preferences |
| GET | `/training/plan` | Active plan, or `null` |
| POST | `/training/plan` | T-2 generate `{weeks, confirmReplace}`; replacing needs `confirmReplace: true` |
| POST | `/training/plan/recalculate` | T-8 adapt from what was completed |
| POST | `/training/plan/adaptation/acknowledge` | Dismiss the "your plan was adapted" notice |
| GET | `/training/schedule?from=&to=` | T-6 sessions and workouts in a range (max 200 days) |
| PATCH | `/training/sessions/{id}` | T-7 reschedule `{date}` |
| DELETE | `/training/sessions/{id}` | T-7 remove; spreads its volume over the rest of the week |
| GET | `/training/today` | T-3/T-4 readiness plus today's reconciled workout |
| POST | `/training/sessions/{id}/respond` | T-4 accept / swap / skip |
| POST | `/training/sessions/{id}/log` | T-5 log a planned session |
| POST | `/training/sessions` | T-5 log an ad hoc session |
| POST | `/readiness/score` | Features in, score + classification + factors out. Stateless |
| GET | `/readiness/model` | Which scorer is live (trained model or rules), what it was trained on, and why if it fell back. No user data |

Errors are `{"detail": {"code", "message", "fieldErrors"?, "suggestedDate"?}}`. Validation
failures use the same shape (status 422), including request-body validation on these paths.

## Layout

| File | Role |
|---|---|
| `config.py` | Every tunable rule (thresholds, intervals, triggers). Change numbers here only |
| `models.py` | Pydantic models, camelCase on the wire, no user id inside any of them |
| `planner.py` | Baseline, periodisation, session placement. Pure functions |
| `rules.py` | Can a session move? Readiness vs plan reconciliation. Pure functions |
| `readiness.py` | Feature builder and the `ReadinessScorer` interface with the rule-based scorer |
| `ml/` | Stage 2: the trained readiness model, its training pipeline and its fallback. Start with `ml/README.md` |
| `service.py` | Application logic. Takes `user_id` and `today` from the caller |
| `repository.py` | Supabase access and the `ChangeSet` applied in one transaction |
| `clock.py` | The client-date header ("today" as the user sees it) |
| `router.py` | Routes, plus `install(app)` |

## Turning it on against a real Supabase project

1. **Apply the migration.** Run `supabase/migrations/20260930000000_training_routine.sql` in the
   Supabase SQL editor (or `supabase db push`). It needs only `auth.users`; it does not touch the
   dashboard tables in `schema.sql`.
2. **Check it landed.** In the SQL editor:
   ```sql
   select tablename, rowsecurity from pg_tables
   where schemaname = 'public'
     and tablename in ('training_preferences','training_plans','planned_sessions','workout_sessions','readiness_scores');
   -- expect 5 rows, all rowsecurity = true

   select has_function_privilege('anon', 'public.training_apply_changes(uuid, jsonb)', 'execute') as anon,
          has_function_privilege('authenticated', 'public.training_apply_changes(uuid, jsonb)', 'execute') as authenticated,
          has_function_privilege('service_role', 'public.training_apply_changes(uuid, jsonb)', 'execute') as service_role;
   -- expect false, false, true
   ```
3. **Backend environment** (`backend/.env`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only; never a `NEXT_PUBLIC_` variable)
   Who the caller is comes from the team's shared `get_current_user_id`
   (`app/commons/auth/deps.py`): it asks Supabase Auth to resolve the bearer token, so no JWT secret is
   needed here. A missing, malformed or unrecognised token is a 401.
4. **Frontend**: set `NEXT_PUBLIC_TRAINING_API=http` (and `NEXT_PUBLIC_BACKEND_URL` if it isn't
   `http://localhost:8000`). Without the flag the page runs on in-memory fixtures.
5. **Smoke test** with a real access token:
   ```
   curl -H "Authorization: Bearer <access token>" -H "X-Client-Date: <today>" http://localhost:8000/api/v1/training/preferences
   ```
   Expect `null` for a new user, and 401 without the header.

## Tests

```
cd backend
python -m pytest
```

The database is replaced by a fake that enforces the same constraints (one session per user per day,
one active plan per user, all-or-nothing writes, no writing over another user's rows). The SQL itself
was also replayed against a real Postgres (PGlite) with the payloads the service produces; that
harness isn't part of the repo.

## How the hard rules are enforced

| Rule | Where | Test |
|---|---|---|
| 1. Strava never reaches an AI feature | `readiness.build_features` and `planner.modelling_workouts` drop `source == 'strava'`. Both scorers only see those features, and the model is trained on synthetic data. The scorer never reads `activities` | `test_training_readiness.py`, `test_training_planner.py`, `test_training_service.py`, `test_training_model.py` (the trained model) |
| 2. Reconciliation is one-directional | `rules.reconcile` | `test_training_rules.py` (all nine band pairs) |
| 3. Rebaseline on completed sessions | `planner.baseline_from_history` reads logged workouts only | `test_training_planner.py` |
| 4. Readiness is private | Only `GET /today` and the stateless `/readiness/score` can return it; selects are scoped to the user | `test_training_api.py` walks the OpenAPI schema; `test_training_repository.py` |
| 5. Not-medical-advice notice | `config.PLAN_NOTICE`, stored on every plan | `test_training_service.py` |

## Behaviour worth knowing

- **Missed sessions and auto-adaptation happen on read.** When the plan, schedule or today is
  requested, sessions whose day has passed unlogged become `missed`, and if that (or persistently
  low readiness) crosses a trigger the plan is adapted. It is idempotent and needs no scheduler.
- **The readiness cache is keyed on its inputs and the scorer.** A cached score is reused only while
  its feature fingerprint and the scorer's version are unchanged, so new history, a new check-in or a
  switch between the model and the rules recomputes it without explicit invalidation.
- **Baselines use the last 4 complete calendar weeks**, so no week is cut in half.
- **One planned session per user per day**, enforced in the database.
- **The profile sets the starting volume, never overrides history.** With under
  `min_history_weeks_for_baseline` weeks of logged training, the baseline starts from the user's
  `activity_level` (`config.default_baseline_by_activity_level`), so a sedentary beginner isn't given
  the same first week as an athlete. With enough history the logged volume is used and the profile is
  ignored. The plan's adaptation note says when the activity level set the default.
- **Only `users.activity_level` is read from the profile table**, because that table also holds the
  Strava tokens. If the table or column isn't there yet, a warning is logged and the plain default is
  used; any other database error still fails the request.

## Not built yet, and who it depends on

- **Check-ins and sleep.** `daily_checkins` (Home page) doesn't exist, so readiness runs without
  those signals. `SupabaseTrainingRepository.get_latest_checkin` is the one place to wire it in.
  `load_rating` is treated as perceived load from 1 to 5, higher meaning worse. Confirm with the owner.
- **Fitness goal.** T-2 lists it as an input, but `users.fitness_goal` is free text, so nothing
  interprets it. It needs a fixed list of goals from the Settings page before it can shape a plan.
- **`activities.source`.** The dashboard's `activities` table is Strava-only and has no `source`
  column, so it is deliberately not read.
- **Exam load.** `ReadinessFeatures.days_until_exam` is supported by the scorer but nothing supplies it
  until the Settings page ships exam dates.
- **A model trained on real data.** Stage 2 exists (`ml/`), but it is trained on a synthetic cohort
  labelled by the rules, so it reproduces them and is no more accurate. It needs real labelled
  readiness data to be anything more; `ml/README.md` says how to retrain on it.
