# Gamification (G-1 to G-4)

Daily check-ins, XP and ranks, a friends leaderboard and shared challenges. Everything lives on the
**Leaderboard** page (`/dashboard/leaderboard`); the Home page calendar reads the same check-ins.

| Requirement | What's built |
|---|---|
| G-1 Interactive daily check-in | Three questions (muscle soreness, mood, diet adherence, each 1 to 5). One per day. Builds a streak and gives bonus XP |
| G-2 Earn and view XP | XP from check-ins, workouts, meals and completed challenges. Rank with progress bar, plus a Recent XP list showing where it came from |
| G-3 Friends leaderboard | You and your accepted friends, ranked by XP or by current streak. **Mileage is not built** (see the end) |
| G-4 Shared challenges | Create with a goal and dates, invite friends, accept or decline, live progress bars, +100 XP for reaching the target |

## Rules

The backend is the source of truth: `backend/app/services/gamification.py`. The frontend copies some
numbers in `frontend/lib/gamification/config.ts` for the form limits and mock data, and the database
triggers hard-code the workout and meal amounts. Change all three together.

**XP**

| Source | XP | Awarded by |
|---|---|---|
| Check-in | 10, plus 2 for each streak day after the first, capped at 22 from day 7 | `POST /gamification/checkins` |
| Workout logged | 50 | Database trigger on `training_workout_logs` |
| Meal logged | 10 | Database trigger on `meal_plans` |
| Challenge target reached | 100, once per person per challenge | Paid the next time the user loads their challenges |

Every award is a row in `xp_events`. The same `(user, source, source_id)` is only ever awarded once, so
retries and duplicate calls are harmless.

**Pending XP.** Workouts and meals are checked before they earn XP. If the check fails, or recording
the XP errors, the XP is held in `pending_xp` with a reason, and the page shows an "XP on hold" alert
with a **Re-sync** button. Re-syncing checks each held item again: it pays the ones that now pass and
drops the ones whose workout or meal was deleted. While an item is held, nothing else can pay it.

| Held when | Clears when |
|---|---|
| A workout is dated after today (the training API takes "today" from the user's device) | That date arrives and the user re-syncs |
| A meal has no calorie estimate | The meal has calories and the user re-syncs |
| Recording the XP failed | The user re-syncs and it succeeds |

**Ranks** by total XP: Beginner 0, Bronze 100, Silver 500, Gold 1500, Platinum 4000.

**Streaks**

- "Today" is the calendar day in Singapore (UTC+8), decided by the server.
- Checking in the day after your last check-in extends the streak; missing a day restarts it at 1.
- A streak is shown as 0 once a day has been missed, even before the next check-in resets it.
- The streak leaderboard only lists streaks that are still alive (checked in today or yesterday).

**Leaderboard.** Friends are users with an accepted request either way in `friend_requests` (the
Friends page). On the XP board, friends with no XP yet are listed with 0.

**Challenges**

| Metric | Progress counts |
|---|---|
| `xp` | XP earned between the start and end dates, not counting challenge rewards |
| `checkin_streak` | Longest run of consecutive check-in days inside the dates |
| `sessions` | Workouts logged inside the dates |

- Title 1 to 100 characters, target 1 to 100,000, start date not in the past, end on or after start.
- Up to 20 invitees, and they must be your friends.
- The creator is in automatically. Invitees accept or decline; declined invitees are hidden, and only
  accepted participants build up progress.
- Progress isn't stored. It's worked out from `xp_events` and `daily_checkins` each time, so it can't
  drift out of date.
- Status is Upcoming, Active or Ended from the dates. Ended challenges can't be accepted.

## Endpoints

All under `/gamification` except the calendar one. All need `Authorization: Bearer <Supabase access token>`.
Errors are `{"detail": "<message>"}` (validation errors from FastAPI use its usual list shape).

| Method | Path | Purpose |
|---|---|---|
| GET | `/gamification/me` | Total XP, streak, best streak, rank, XP to next rank, `checkedInToday` |
| POST | `/gamification/checkins` | Today's check-in `{muscleFatigue, mood, dietAdherence}` (1 to 5). 201, or 409 if already checked in today |
| GET | `/gamification/xp-events` | The 20 most recent XP awards, newest first |
| GET | `/gamification/pending-xp` | XP on hold, with the reason for each item and the total |
| POST | `/gamification/pending-xp/resync` | Check held XP again. Returns what was paid (`awardedXp`, `released`), cleared (`removed`) and still held (`stillPending`, `items`) |
| GET | `/gamification/leaderboard?metric=xp\|streak&limit=1..50` | You and your friends (default 10), plus `friendCount` so the page can show the no-friends screen |
| GET | `/gamification/challenges` | Challenges you created, joined or are invited to, with everyone's progress. Pays any rewards you've earned |
| POST | `/gamification/challenges` | Create `{title, metric, targetValue, startDate, endDate, inviteeIds}`. 201, or 422 with a message |
| POST | `/gamification/challenges/{id}/respond` | `{accept: true\|false}`. 404 if you weren't invited, 409 if already answered or the challenge ended |
| GET | `/checkin/me/dates` | All your check-in dates, oldest first. Used by the Home page calendar |

## Database

Run these in the Supabase SQL Editor, in order. **The first three have already been run on the team
database**, and each is safe to run again.

| Migration | What it does |
|---|---|
| `supabase/migrations/20261009000000_gamification.sql` | Creates `gamification_user_stats`, `daily_checkins`, `xp_events`, `challenges`, `challenge_participants`, with RLS |
| `supabase/migrations/20261009120000_gamification_xp_sources.sql` | `award_gamification_xp` database function, workout and meal XP triggers (and XP for anything logged earlier), one award per user per source |
| `supabase/migrations/20261010000000_gamification_merge_checkins.sql` | Copies the old `daily_check_ins` calendar dates into `daily_checkins` and recalculates streaks |
| `supabase/migrations/20261011000000_gamification_pending_xp.sql` | `pending_xp` table, the checks, holding failed awards, and `resync_gamification_xp` |

| Table | Holds |
|---|---|
| `gamification_user_stats` | One row per user: total XP, current and best streak, last check-in date. Rank is worked out from XP, not stored |
| `daily_checkins` | One row per user per day with the three answers. Answers are blank only for days copied from the old calendar table |
| `xp_events` | Every XP award. `total_xp` is the sum of these |
| `challenges`, `challenge_participants` | Challenges and who was invited, with their invite status |
| `pending_xp` | XP held back from a workout or meal, with the reason |

Things to know:

- **Users can only read their own rows**, and can't write at all. Every write goes through the backend's
  service-role key, and `award_gamification_xp` can only be called by the backend, so nobody can give
  themselves XP from the browser.
- **Two older tables are unused.** `gamification_stats` (from the original team setup, with different
  columns) and `daily_check_ins` (the old calendar table, now copied across). Drop them once the team agrees.
- **A failed XP award never blocks a workout or meal from saving.** The trigger holds the XP as pending
  instead (see Pending XP above).

## How other features connect

- **Training (Zheng Wee):** workouts get XP from the trigger, and the training code also calls
  `award_xp`; the second award is ignored, so each workout counts once. Readiness reads the soreness
  answer from `daily_checkins.muscle_fatigue`.
- **Nutrition (Matt):** meals get XP from the trigger. No code change needed.
- **Home page calendar (Gary):** reads dates from `GET /checkin/me/dates`. Its Check in button opens the
  questionnaire on the Leaderboard page, so there is one way to check in and one streak.
- **Friends (Rusyaidi):** the leaderboard and challenge invites use accepted rows in `friend_requests`.
  Names come from `users.name`; anyone without a name shows as "Athlete" plus the last 4 characters of
  their id.
- **Any other feature** can give XP with
  `award_xp(supabase, user_id, source, amount, source_id)` from `app/services/gamification.py`, where
  `source` is one of `checkin`, `workout`, `meal`, `challenge`. Pass a `source_id` so retries don't count twice.

## Layout

| Path | Role |
|---|---|
| `backend/app/services/gamification.py` | All rules and database access |
| `backend/app/controllers/gamification.py` | `/gamification` routes |
| `backend/app/models/gamification.py` | Request and response models (camelCase) |
| `backend/app/controllers/checkin.py` | `/checkin/me/dates` for the calendar |
| `backend/tests/test_gamification.py` | Tests, using an in-memory stand-in for Supabase |
| `frontend/app/(app)/dashboard/leaderboard/page.tsx` | The page |
| `frontend/app/(app)/dashboard/leaderboard/_components/` | Stats, check-in, Recent XP, leaderboard and challenges panels, the XP-on-hold alert, and the new-challenge form |
| `frontend/lib/gamification/` | Types, rules, zod schemas, and the API in two versions: real backend and mock data |

## Running it locally

The page uses **mock data** unless told otherwise, so it works without the backend or a login. To use the
real backend, set these in `frontend/.env.local` and restart `npm run dev`:

```
NEXT_PUBLIC_GAMIFICATION_API=http
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_API_URL=http://localhost:8000
```

`NEXT_PUBLIC_API_URL` is what the Home page calendar uses. On Vercel, point both URLs at the deployed
backend, and set `FRONTEND_URL` on the backend to the site's address so CORS allows it.

```powershell
# Backend, from backend/
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\uvicorn app.main:app --reload

# Frontend, from frontend/
npm ci
npm run dev
```

Then register, log in, and open http://localhost:3000/dashboard/leaderboard. To try friends and
challenges, use two accounts and add each other on the Friends page.

## Tests

```powershell
# From backend/
.venv\Scripts\python -m pytest tests/test_gamification.py tests/training/test_training_xp.py -q
```

`test_gamification.py` covers the XP, streak and rank rules, check-ins, the leaderboard and friends,
challenges and rewards, XP history and the calendar endpoint, both in the service and over HTTP. The
in-memory stand-in mirrors the database's unique constraints and the `award_gamification_xp` function.

## Not built yet, and who it depends on

- **Mileage leaderboard (G-3).** Nothing records distance: training volume is load points, not
  kilometres, and Strava runs aren't saved. Needs a distance field from Training (Zheng Wee) or saved
  Strava activities (Jing Jie).
- **Challenge rewards are paid when the user next opens their challenges**, not the moment the target is
  reached. The stats panel catches up on the next refresh.
- **No frontend tests** for this page yet.
