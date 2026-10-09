# Training routine backend

The API behind the Training page (`frontend/app/(app)/dashboard/training`). It runs inside the existing
FastAPI service; `app/main.py` mounts it with `install_training_routes(app)`.

## Endpoints

All under `/api/v1`, all need `Authorization: Bearer <Supabase access token>`. Send the user's
local date as `X-Client-Date: YYYY-MM-DD` so "today" matches theirs (the server has no timezone data).

| Method | Path | Purpose |
|---|---|---|
| GET / PUT | `/training/preferences` | T-1 read / save preferences, including optional upcoming exam dates |
| GET | `/training/plan` | Active plan, or `null` |
| POST | `/training/plan` | T-2 generate `{weeks, confirmReplace}`; replacing needs `confirmReplace: true` |
| POST | `/training/plan/recalculate` | T-8 adapt from what was completed |
| POST | `/training/plan/adaptation/acknowledge` | Dismiss the "your plan was adapted" notice |
| GET | `/training/schedule?from=&to=` | T-6 sessions and workouts in a range (max 200 days) |
| PATCH | `/training/sessions/{id}` | T-7 reschedule `{date}` |
| DELETE | `/training/sessions/{id}` | T-7 remove; spreads its volume over the rest of the week |
| GET | `/training/today` | T-3/T-4 readiness plus today's reconciled workout |
| PUT / DELETE | `/training/sleep` | Last night's sleep `{hours}` (0 to 16), filed under the user's today; it feeds today's readiness. DELETE removes it |
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

1. **Look for collisions first.** `create table if not exists` silently skips a table that already
   exists, and the migration would then fail on columns that aren't there. When the live project was
   checked (2026-10-07) it held the original ERD schema, including empty `training_plans`,
   `workout_sessions` and `exercises` tables. That is why this migration's plan and workout tables are
   named `training_routine_plans` and `training_workout_logs`. Before running it anywhere, in the SQL editor:
   ```sql
   select table_name from information_schema.tables
   where table_schema = 'public'
     and table_name in ('training_preferences','training_routine_plans','planned_sessions','training_workout_logs','readiness_scores');
   -- expect no rows

   select proname from pg_proc where proname = 'training_apply_changes';
   -- expect no rows
   ```
2. **Apply the two migrations, in order**, in the Supabase SQL editor (or `supabase db push`). They need
   only `auth.users` and touch no other feature's table.
   - `supabase/migrations/20260930000000_training_routine.sql` creates the five training tables and the
     write function. A script runs as one transaction, so an error changes nothing, but it is **not safe
     to run twice** (the `create policy` lines have no `if not exists`).
   - `supabase/migrations/20261007120000_training_inputs.sql` adds `training_preferences.exam_dates`,
     `training_routine_plans.goal` and the `training_sleep_logs` table, replaces the write function so
     plans carry their goal, and takes the write privileges on all six tables away from signed-in and
     signed-out users. It **is safe to run again**; running it again also closes anything opened up in
     the meantime.

   The backend copes with a database that hasn't had the second one yet (preferences save without exam
   dates, sleep reads as missing, plans save without a goal), but logging sleep then answers 503 with a
   message saying to apply it.
3. **Check it landed.** In the SQL editor:
   ```sql
   select tablename, rowsecurity from pg_tables
   where schemaname = 'public'
     and tablename in ('training_preferences','training_routine_plans','planned_sessions','training_workout_logs','readiness_scores','training_sleep_logs');
   -- expect 6 rows, all rowsecurity = true

   select has_function_privilege('anon', 'public.training_apply_changes(uuid, jsonb)', 'execute') as anon,
          has_function_privilege('authenticated', 'public.training_apply_changes(uuid, jsonb)', 'execute') as authenticated,
          has_function_privilege('service_role', 'public.training_apply_changes(uuid, jsonb)', 'execute') as service_role;
   -- expect false, false, true

   select has_table_privilege('authenticated', 'public.training_sleep_logs', 'insert') as signed_in_can_write,
          has_table_privilege('authenticated', 'public.training_sleep_logs', 'select') as signed_in_can_read,
          has_table_privilege('anon', 'public.training_sleep_logs', 'select') as signed_out_can_read;
   -- expect false, true, false
   ```
4. **Backend environment** (`backend/.env`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (server only; never a `NEXT_PUBLIC_` variable)
   Who the caller is comes from the team's shared `get_current_user_id`
   (`app/commons/auth/deps.py`): it asks Supabase Auth to resolve the bearer token, so no JWT secret is
   needed here. A missing, malformed or unrecognised token is a 401.
5. **Frontend**: set `NEXT_PUBLIC_TRAINING_API=http` (and `NEXT_PUBLIC_BACKEND_URL` if it isn't
   `http://localhost:8000`). Without the flag the page runs on in-memory fixtures.
6. **Smoke test** with a real access token (sign in through the login page, or copy the access token of a
   signed-in session):
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
| 4. Readiness is private | Only `GET /today` and the stateless `/readiness/score` can return it; selects are scoped to the user. The sleep entries and exam dates that feed it are held to the same rule: only the owner's own `GET /today` and `GET /preferences` return them | `test_training_api.py` walks the OpenAPI schema; `test_training_repository.py`; `test_training_inputs.py` (one user's sleep and exams never reach another's score) |
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
- **The daily check-in feeds readiness.** The check-in rating is `daily_checkins.muscle_fatigue` from
  the gamification questionnaire ("How sore are your muscles?", 1 "Fresh" to 5 "Very sore", so higher
  is worse, the same direction as the score expects). Only that column and the date are read, only for the
  user, and never mood or diet. A check-in counts while it is from today or yesterday
  (`checkin_max_age_days`); an older one is ignored. If the table isn't in the database, readiness runs
  without it and one warning is logged.
- **The profile sets the starting volume, never overrides history.** With under
  `min_history_weeks_for_baseline` weeks of logged training, the baseline starts from the user's
  `activity_level` (`config.default_baseline_by_activity_level`), so a sedentary beginner isn't given
  the same first week as an athlete. With enough history the logged volume is used and the profile is
  ignored. The plan's adaptation note says when the activity level set the default.
- **Only `users.activity_level` and `users.fitness_goal` are read from the profile table**, because that
  table also holds the Strava tokens and a password hash. If the table or a column isn't there yet, a
  warning is logged and the plain defaults are used; any other database error still fails the request.
- **The profile goal tilts the activity mix and nothing else.** Settings stores the goal as `DEFICIT`,
  `MAINTAIN` or `SURPLUS` (a fixed dropdown), which becomes `lose_weight`, `maintain` or `build_muscle`
  (`config.profile_goal_map`). Weight loss gives run and cycling an extra turn in the weekly rotation of
  activities, muscle gain gives gym and bodyweight one (`config.goal_activity_weights`); maintenance, no
  goal, or a value Settings doesn't offer leaves the user's own list as it is. Only activities the user
  picked are ever used, and the goal never changes when sessions fall or how hard they are. The plan stores
  the goal it was built for (`goal`), and adapting a plan re-reads the profile.
- **Exam dates are entered on the training page.** Settings has no exam field, so the user adds them in
  their training preferences (up to 10, within `exam_dates_horizon_days`; kept in order, and a date that
  has passed is dropped on save). `days_until_next_exam` takes the nearest one that hasn't passed. Inside
  `exam_window_days` of it the score drops, up to `exam_max_penalty`, and the "Academic load" factor says
  how many days are left. If Settings ever ships an exam date, read it where
  `TrainingService._readiness` reads `preferences.exam_dates`.
- **Sleep is entered on the Today card, once a day.** Nothing else records it. It is stored per user and
  day in `training_sleep_logs` and only the entry for the day being scored counts. It is the
  `sleep_hours` feature, and it wins over a check-in's own sleep answer if one ever carries one.
  Saving it again replaces it; the cached score is keyed on its inputs, so the next read recomputes.

## Not built yet, and who it depends on

- **Resting heart rate.** The spec lists resting and average heart rate. Nothing in the app records a
  resting rate (the check-in has no such question and a logged workout carries its average only), so the
  heart rate factor is the trend in average heart rate across logged sessions. Entering a resting rate
  would work the way sleep does, plus a model feature and a retrain.
- **Mood and diet answers.** The check-in collects them but readiness doesn't use them. Using them means
  new model features and retraining, and they are the user's most personal answers.
- **Exam load in the plan.** An exam lowers that day's readiness, so a planned hard session is dialled
  down by the usual reconciliation, but the weekly plan itself isn't eased around exams.
- **`activities.source`.** The dashboard's `activities` table is Strava-only and has no `source`
  column, so it is deliberately not read.
- **A model trained on real data.** Stage 2 exists (`ml/`), but it is trained on a synthetic cohort
  labelled by the rules, so it reproduces them and is no more accurate. It needs real labelled
  readiness data to be anything more; `ml/README.md` says how to retrain on it.
