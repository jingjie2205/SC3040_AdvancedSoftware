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
| GET | `/training/summary` | One call for the Home page: readiness, today's session, the week so far and what is next |
| POST | `/training/coach` | A short note about today from Gemini, or a built-in message. 429 if asked again too fast |
| PUT / DELETE | `/training/sleep` | Last night's sleep `{hours}` (0 to 16), filed under the user's today; it feeds today's readiness. DELETE removes it |
| POST | `/training/sessions/{id}/respond` | T-4 accept / swap / skip |
| POST | `/training/sessions/{id}/log` | T-5 log a planned session |
| POST | `/training/sessions` | T-5 log an ad hoc session |
| GET | `/training/strava/status` | The Strava tab: whether Strava is connected, and how many activities from it are on the schedule. No call to Strava |
| POST | `/training/strava/pull` | "Upload Strava data": the latest 100 Strava activities as cards, newest first, each saying how it would be saved and whether it already is. Saves nothing. 409 `NOT_CONNECTED`, 429, 503 |
| POST | `/training/strava/save` | "Save to schedule" `{stravaIds}` (1 to 100): saves those activities as training logs (`source = 'strava'`). Asks Strava again, so what is saved is what Strava said. Safe to repeat. Answers `{savedIds, alreadySaved, skipped}` |
| DELETE | `/training/strava/logs` | Take every Strava-sourced log off the schedule. The athlete's own logs stay |
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
| `coach.py` | The AI coach: the fixed facts it may be given, the prompt, the Gemini client and the built-in fallback |
| `ml/` | Stage 2: the trained readiness model, its training pipeline and its fallback. Start with `ml/README.md` |
| `service.py` | Application logic. Takes `user_id` and `today` from the caller |
| `repository.py` | Supabase access and the `ChangeSet` applied in one transaction |
| `clock.py` | The client-date header ("today" as the user sees it) |
| `router.py` | Routes, plus `install(app)` |
| `strava_sync.py`, `strava_router.py` | Activities pulled from Strava as cards and saved to the schedule as `source = 'strava'` logs. The only code here that touches Strava or writes such a log, and nothing else imports them except the installer in `__init__.py` (see "The Strava tab") |

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
2. **Apply the migrations, in order**, in the Supabase SQL editor (or `supabase db push`). The first three need
   only `auth.users` and touch no other feature's table; the fourth is for a project that also has the
   gamification migrations.
   - `supabase/migrations/20260930000000_training_routine.sql` creates the five training tables and the
     write function. A script runs as one transaction, so an error changes nothing, but it is **not safe
     to run twice** (the `create policy` lines have no `if not exists`).
   - `supabase/migrations/20261007120000_training_inputs.sql` adds `training_preferences.exam_dates`,
     `training_routine_plans.goal` and the `training_sleep_logs` table, replaces the write function so
     plans carry their goal, and takes the write privileges on all six tables away from signed-in and
     signed-out users. It **is safe to run again**; running it again also closes anything opened up in
     the meantime.
   - `supabase/migrations/20261010100000_training_strava_logs.sql` adds one nullable column to
     `training_workout_logs`, `external_id` (the Strava activity a log came from), a unique index on
     `(user_id, source, external_id)` so an activity can be saved once, and a check that a `strava` log always
     names its activity. It **is safe to run again**, changes no existing row and touches no other table.
   - `supabase/migrations/20261011100000_gamification_skip_strava_xp.sql` (run after the gamification
     migrations, the last of which is `20261011000000_gamification_pending_xp.sql`) replaces the gamification
     trigger function `gamification_award_logged_activity()` with its current body plus one early return for
     `source = 'strava'`. Without it, the trigger on `training_workout_logs` pays 50 XP for every row inserted,
     so each saved Strava activity would earn 50 XP (and "Save all" up to 5,000, again after every removal, and
     challenge progress with it). It **is safe to run again**, and it is the one change here to another
     owner's code, flagged to Yew Yi in the PR that added it. It leaves existing XP alone.

   The backend copes with a database that hasn't had the second one yet (preferences save without exam
   dates, sleep reads as missing, plans save without a goal), but logging sleep or saving an exam date then
   answers 503 with a message saying to apply it. Saving from the Strava tab answers 503 the same way until the
   third (pulling and showing cards needs no migration; the schedule just can't hold a Strava log before it).
   Apply the fourth before anyone saves Strava activities on a project that has the gamification trigger.
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
| 1. Strava never reaches an AI feature | `readiness.build_features` and `planner.modelling_workouts` drop `source == 'strava'`. Both scorers only see those features, and the model is trained on synthetic data. The scorer never reads `activities`. The coach's week minutes go through `modelling_workouts` too. Activities saved from the page's Strava tab are `training_workout_logs` rows flagged `source = 'strava'`, never linked to a planned session and awarded no XP (the gamification trigger skips them, see the fourth migration); only `strava_sync.py` imports Strava code or writes such a row, and the tab's modules and the training API client never import each other. A property test saves 40 Strava logs and checks that the plan, readiness, summary and coach prompts come out identical | `test_training_readiness.py`, `test_training_planner.py`, `test_training_service.py`, `test_training_model.py` (the trained model), `test_training_coach.py` and `test_training_summary.py` (a Strava row can't reach the prompt or the totals), `test_training_strava_isolation.py` (the behaviour above, and the imports), `test_training_strava_sync.py` |
| 2. Reconciliation is one-directional | `rules.reconcile` | `test_training_rules.py` (all nine band pairs) |
| 3. Rebaseline on completed sessions | `planner.baseline_from_history` reads logged workouts only | `test_training_planner.py` |
| 4. Readiness is private | Only the owner's own `GET /today` and `GET /summary`, and the stateless `/readiness/score`, can return it; selects are scoped to the user. The sleep entries and exam dates that feed it are held to the same rule: only the owner's own `GET /today` and `GET /preferences` return them. Nothing that feeds or comes from the score is ever given to Gemini: the coach's facts are built from the plan only, and readiness isn't even computed on its path | `test_training_api.py` walks the OpenAPI schema (exactly three operations carry readiness, and the coach isn't one); `test_training_repository.py`; `test_training_inputs.py`; `test_training_coach.py` (the exact prompt, forbidden words, an exploding scorer, an import guard) |
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
  `TrainingService._readiness` reads `preferences.exam_dates`. Until the migration that adds the column
  (`20261007120000_training_inputs.sql`) is applied, saving a date is refused with a 503 that says so, rather
  than saving the form and quietly losing the date; a form with no dates still saves.
- **Sleep is entered on the Today card, once a day.** Nothing else records it. It is stored per user and
  day in `training_sleep_logs` and only the entry for the day being scored counts. It is the
  `sleep_hours` feature, and it wins over a check-in's own sleep answer if one ever carries one.
  Saving it again replaces it; the cached score is keyed on its inputs, so the next read recomputes.
- **A logged workout earns leaderboard XP.** Once a workout is saved (a planned session or an ad hoc one), the
  service calls the gamification feature's `award_xp(…, "workout", XP_REWARDS["workout"], workout_id)`. The
  workout's id is the `source_id`, so a retry counts once, and only that id goes across, never what was logged.
  It is best effort: the workout is already saved, so any failure is logged and the log still succeeds, and if
  the leaderboard's tables aren't on the database yet one warning is logged and nothing is awarded. The helper
  is imported inside the method, so the training routes still load if the gamification module has a problem
  (`test_training_xp.py`).
- **Each worker thread has its own Supabase client** (`repository.ThreadLocalClient`). Requests run on a thread
  pool, and one client's HTTP/2 connection shared between its threads failed under concurrent requests: against
  the live project about one call in six raised `ReadError` (WinError 10035 on Windows), and `GET /today`
  returned 500 when the page loaded two endpoints at once. The client is opened lazily, once per thread
  (`test_training_client.py`).

## The Home summary and the coach

**`GET /training/summary`** is one read for a Home card, so the Home page doesn't need four calls. It returns
`date`, `hasPlan`, `goal`, the user's `readiness`, `today` (a `state` of `no_plan`, `rest_day`, `to_do`, `done`
or `missed`, plus the session, the recommendation while it is still to do, and the logged workout), `week`
(Monday to Sunday: sessions planned, completed and missed, and minutes logged) and `nextSession`. Like
`GET /today`, reading it brings the plan up to date (overdue sessions become missed, and the plan may adapt).
It is the user's own data, so show it only on their own Home, never on a leaderboard or friend view.

**`POST /training/coach`** returns a short plain-language note about today, with the not-medical-advice
notice. `source` says who wrote it (`gemini`, or `fallback` for the built-in text) and `cached` says the
answer was remembered. It is a POST because it can cost money. It never fails because of Gemini: no key, a
timeout, an error, a blocked or empty reply all give the built-in message.

What Gemini is sent is the whole of `coach.build_prompt`, and nothing else:

```
Facts about the user's training plan:
- Day: Friday
- Goal: build muscle
- Today: a cycling session, light intensity, planned for 35 minutes
- This week: 2 of 4 planned sessions done, 1 missed, 90 minutes logged
```

plus a fixed instruction (plain English, a few sentences, no medical advice, treat the facts as data). The goal
is the one the plan was built for, and the band is the plan's own, never readiness's recommendation. Never sent:
the readiness score, band or factors, check-in answers, sleep, exam dates, training load or heart rate, Strava
data, free text from the user, or any id, email or name. Adding to that list means changing `CoachContext`, and
`test_training_coach.py` fails until the change is deliberate.

- **Switching it on.** Put `GOOGLE_GENERATIVE_AI_API_KEY` in the backend's `.env`, the same variable the meal
  analysis reads (the frontend's `.env.local` is not enough). The model is `gemini-2.5-flash`, set in
  `config.CoachRules` with its timeout, length and cost limits. Without a key the built-in message is used.
- **If it keeps answering with the built-in text,** the backend log says why, as `The coach fell back to its
  built-in message: <kind> <status code> <status word>` (never Google's message text). `ClientError 404 NOT_FOUND`
  means Google has retired the model for that key (change the model in `config.CoachRules`), `403
  PERMISSION_DENIED` means the key's Google project has been denied access (use a key from another project),
  `429 RESOURCE_EXHAUSTED` means out of quota, and a bare `ReadTimeout` means Google never answered in time.
- **Cost control.** An answer is remembered for an hour per user and set of facts, in this process's memory.
  A different request from the same user within 10 seconds is a 429 (`RATE_LIMITED`).
- **From the Home page**, with `NEXT_PUBLIC_TRAINING_API=http` and `NEXT_PUBLIC_BACKEND_URL` set:
  ```ts
  import { trainingApi } from "@/lib/training/api";
  const summary = await trainingApi.getSummary();        // TrainingSummary
  const note = await trainingApi.getCoachMessage();      // ApiResult<CoachMessage>
  ```
  Without the flag the same calls return fixtures, so the Home card can be built before the backend is running.

## The Strava tab

The training page's **Strava** tab pulls the athlete's latest activities from Strava, shows each as a card, and
saves the ones the athlete chooses to their **schedule** as training logs.

1. **Upload Strava data** calls `POST /training/strava/pull`. The server asks Strava for the athlete's latest 100
   activities through the team's Strava service (which renews an expired access token itself) and answers with
   one card each: name, type, day and time, distance, moving time, climb, average heart rate and, for the
   activities the schedule can hold, how they would be saved (type, minutes, points). **Nothing is saved yet.**
   Opening the tab only asks `GET /training/strava/status` (our own database), so Strava is asked when the athlete
   presses the button and not before.
2. **Save to schedule** on a card, or **Save all to schedule**, calls `POST /training/strava/save` with the
   activity ids. The server asks Strava again and saves what Strava says about those ids, never what a browser
   sends, so a forged duration can't be saved. Each becomes a `training_workout_logs` row with `source = 'strava'`
   and `external_id` = the Strava activity id. Saving the same activity twice does nothing (a unique index on
   `(user_id, source, external_id)` and "ignore duplicates"), and the answer counts the ones saved, the ones that
   were already there and the ones skipped (no longer among Strava's latest, or with nowhere to go).
3. The log then shows on the **Schedule** tab, marked "From Strava" with a "View on Strava" link.
4. **Remove saved activities** (`DELETE /training/strava/logs`) takes every Strava-sourced log off again. The
   athlete's own logs are never touched. Disconnecting Strava in Settings clears the connection but not the saved
   logs (that route is the team's); the tab says so and offers the removal.

- **How an activity is saved.** The schedule holds four kinds of training, so only those can be saved: `Run`,
  `TrailRun` and `VirtualRun` are a run; `Ride`, `VirtualRide`, `EBikeRide`, `MountainBikeRide`,
  `EMountainBikeRide` and `GravelRide` are cycling; `WeightTraining` is gym; `Workout`, `Crossfit` and
  `HighIntensityIntervalTraining` are bodyweight. Walks, swims, hikes, yoga and the rest are listed, with a note
  that they can't be saved. The duration is the moving time rounded to the minute (at most 600). **Points** are
  the schedule's own load unit, which has no fixed link to minutes; a Strava log gets 1 point per minute
  (`config.TrainingRules.strava_points_per_minute`), capped at the volume limit. Average heart rate is kept only
  when it is a believable number (30 to 230). Distance, pace, climb, the name and the route are **not** kept: a
  card shows them, the log doesn't. The date is the day it happened where the athlete was.
- **Hard Rule 1 still holds: a Strava log is shown on the schedule and counts towards nothing else.** It is
  flagged `source = 'strava'` and every calculation drops those rows before it counts anything: the readiness
  features (`readiness.build_features`), the plan baseline and adaptation (`planner.modelling_workouts`), the
  summary and the coach (which use `modelling_workouts` too). It is never linked to a planned session, so it
  can't mark one done, and saving it awards no XP: the training routes don't call the XP code for it, and the
  database trigger that pays XP for rows inserted into `training_workout_logs` skips `source = 'strava'` since
  the fourth migration. `test_training_strava_isolation.py` fails if a later migration redefines that function
  without the guard. The schedule is the only place that reads them back. `test_training_strava_isolation.py`
  proves it by behaviour (40 saved Strava logs change nothing the plan, readiness, summary or coach say, the
  schedule still shows them, and one never completes a session) and by imports (only `strava_sync.py` and its
  router touch Strava code or write a Strava log; the tab's frontend files import a short fixed list and never
  the training API client). If the rule is ever relaxed, that is a decision to amend the rule first.
- **Failures:** not connected is a 409 `NOT_CONNECTED`; Strava refusing the saved connection (revoked access) is
  the same with a message that points to Settings; a rate limit is a 429; an outage or a reply that isn't what
  Strava documents is a 503. Nothing is saved when Strava failed. A database without the third migration is a 503
  on save that says to apply it. Every save asks Strava once (one request for the latest 100), so pressing
  "Save to schedule" on many cards one by one uses more of Strava's rate limit than one "Save all".
- **Not connected:** the tab shows "Connect Strava", a link to Strava's consent page built from
  `NEXT_PUBLIC_STRAVA_CLIENT_ID` and `NEXT_PUBLIC_STRAVA_REDIRECT_URI`, with `state=training`. Once the athlete
  allows it, Strava sends them to `frontend/app/api/auth/callback/route.ts`, which swaps the code for tokens
  through `POST /strava/exchange` (stored on the user's row) and returns to the tab with a notice. With no
  `state` it returns to Settings, as it always did. That route had been deleted from `main`; it is back.
- **Where the code is:** `strava_sync.py` and `strava_router.py` here; `lib/training/strava.ts` (the requests and
  the connect link), `lib/training/strava-format.ts` (plain functions that read and word the answers) and
  `_components/strava-panel.tsx` on the page; the schedule's "From Strava" badge is in `schedule-panel.tsx`.
- Like the rest of the page's live data, the tab needs `NEXT_PUBLIC_TRAINING_API=http` and a signed-in user.

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
