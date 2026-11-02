"""
Application logic for the training routine. Every method takes the user id from the verified
session (never from a request body) and `today` from the caller, so it stays pure and testable.
"""
import logging
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple
from uuid import uuid4

from .coach import (
    SYSTEM_INSTRUCTION,
    CoachClient,
    CoachContext,
    CoachUnavailable,
    build_prompt,
    clean,
    fallback_message,
    weekday_name,
)
from .config import (
    COACH_RULES,
    FORECAST_RULES,
    PLAN_NOTICE,
    RULES,
    CoachRules,
    ForecastRules,
    TrainingRules,
)
from .errors import TrainingError
from .forecast import LoadForecast, build_forecast, fmt, forecast_view
from .models import (
    ActivityType,
    AddSessionRequest,
    AddSessionResult,
    CoachMessage,
    ForecastView,
    GeneratePlanRequest,
    IntensityBand,
    LogResult,
    LogWorkoutInput,
    ModelInfo,
    NextSession,
    PlanAdaptation,
    PlannedSession,
    ReadinessScore,
    RemoveResult,
    Schedule,
    ScoreResult,
    SessionResponseRequest,
    SessionUpdateRequest,
    SleepEntry,
    SleepInput,
    TodaySummary,
    TodayView,
    TrainingPlan,
    TrainingPreferences,
    TrainingPreferencesInput,
    TrainingSummary,
    WeekProgress,
    WorkoutSession,
)
from .planner import (
    AthleteProfile,
    Baseline,
    WeekTarget,
    baseline_from_history,
    build_sessions,
    default_duration_min,
    first_unsafe_week,
    goal_for,
    is_deload_week,
    modelling_workouts,
    plan_end_date,
    plan_week_target,
    round_half_up,
    sessions_per_week,
    share_week,
    week_pool,
    week_start,
    weekly_targets,
    weight_of,
)
from .readiness import (
    ActivityRecord,
    ReadinessFeatures,
    ReadinessScorer,
    build_features,
    days_until_next_exam,
    fingerprint,
)
from .repository import ChangeSet, TrainingRepository
from .rules import (
    LOGGABLE_STATUSES,
    MOVABLE_STATUSES,
    MoveContext,
    band_refusal,
    check_move,
    check_placement,
    reconcile,
)

logger = logging.getLogger("endurance.training")


def _new_id() -> str:
    return str(uuid4())


def _session_for_today(sessions: Sequence[PlannedSession]) -> Optional[PlannedSession]:
    """
    The session Today shows when a day holds several: the first one still to do (so a finished session never hides the
    one that is left), otherwise the first. Ordered by id so the choice doesn't change from one read to the next.
    """
    ordered = sorted(sessions, key=lambda s: s.id)
    return next((s for s in ordered if s.status in MOVABLE_STATUSES), ordered[0] if ordered else None)


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class PlanSnapshot:
    """
    The plan side of "how is today going": the plan, today's session, the week so far and what is next.
    It involves no readiness, which is how the coach gets its facts without computing a score.
    """

    plan: Optional[TrainingPlan]
    session: Optional[PlannedSession]
    logged: Optional[WorkoutSession]
    week: WeekProgress
    next_session: Optional[NextSession]

    @property
    def state(self) -> str:
        if self.plan is None:
            return "no_plan"
        if self.session is None:
            return "rest_day"
        if self.session.status in ("completed", "partial"):
            return "done"
        if self.session.status == "missed":
            return "missed"
        return "to_do"


class TrainingService:
    def __init__(
        self,
        repository: TrainingRepository,
        scorer: ReadinessScorer,
        rules: TrainingRules = RULES,
        *,
        coach: Optional[CoachClient] = None,
        coach_rules: CoachRules = COACH_RULES,
        forecast_rules: ForecastRules = FORECAST_RULES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.repo = repository
        self.scorer = scorer
        self.rules = rules
        self.forecast_rules = forecast_rules
        self.coach = coach
        self.coach_rules = coach_rules
        self._clock = clock
        # What the coach said and when each user last asked, in this process's memory only.
        self._coach_lock = threading.Lock()
        self._coach_cache: Dict[str, Tuple[float, CoachMessage]] = {}
        self._coach_last_call: Dict[str, float] = {}

    # ------------------------------------------------------------------ preferences (T-1)

    def get_preferences(self, user_id: str) -> Optional[TrainingPreferences]:
        return self.repo.get_preferences(user_id)

    def save_preferences(
        self, user_id: str, today: date, data: TrainingPreferencesInput
    ) -> TrainingPreferences:
        horizon = today + timedelta(days=self.rules.exam_dates_horizon_days)
        if any(day > horizon for day in data.exam_dates):
            raise TrainingError(
                "VALIDATION",
                "Check the highlighted fields.",
                field_errors={
                    "examDates": f"Exam dates can be at most {self.rules.exam_dates_horizon_days} days ahead"
                },
            )
        # An exam that has passed no longer matters, so it isn't kept.
        upcoming = [day for day in data.exam_dates if day >= today]
        preferences = TrainingPreferences(
            **{**data.model_dump(), "exam_dates": upcoming}, updated_at=_now()
        )
        self.repo.save_preferences(user_id, preferences)
        return preferences

    # ------------------------------------------------------------------ plan (T-2, T-8)

    def get_plan(self, user_id: str, today: date) -> Optional[TrainingPlan]:
        return self._sync(user_id, today)

    def generate_plan(
        self, user_id: str, today: date, request: GeneratePlanRequest
    ) -> TrainingPlan:
        preferences = self.repo.get_preferences(user_id)
        if preferences is None:
            raise TrainingError("NO_PREFERENCES", "Set your training preferences before generating a plan.")
        existing = self.repo.get_active_plan(user_id)
        if existing and not request.confirm_replace:
            raise TrainingError("PLAN_EXISTS", "You already have an active plan. Confirm to replace it.")

        profile = self.repo.get_profile(user_id)
        goal = goal_for(profile, self.rules)
        baseline = self._baseline(user_id, today, profile)
        targets, progression = self._plan_targets(baseline.volume, request.weeks, 0, self._forecast(user_id, today))

        start = week_start(today)
        plan = TrainingPlan(
            id=_new_id(),
            start_date=start,
            end_date=plan_end_date(start, request.weeks),
            weeks=request.weeks,
            status="active",
            baseline_volume=baseline.volume,
            created_at=_now(),
            notice=PLAN_NOTICE,
            goal=goal,
            last_adaptation=None,
            progression_pct=progression,
        )

        # Only sessions still to do are dropped; completed, partial and missed ones are history.
        # The old plan may run longer than the new one, so look as far as either reaches.
        reach = max(plan.end_date, existing.end_date) if existing else plan.end_date
        upcoming = self.repo.list_sessions(user_id, today, reach)
        drop = [
            s.id
            for s in upcoming
            if existing and s.plan_id == existing.id and s.status in MOVABLE_STATUSES
        ]
        taken = {s.date for s in upcoming if s.id not in drop}
        sessions = self._new_sessions(plan.id, preferences, start, targets, today, taken, goal)

        self.repo.apply(
            user_id,
            ChangeSet(
                supersede_active_plan=existing is not None,
                delete_session_ids=drop,
                upsert_plans=[plan],
                upsert_sessions=sessions,
            ),
        )
        return plan
    def get_user_plans(self, user_id: str):
        # Fetch all routine plans for user ordered by creation
        return self.repo.get_plans(user_id)

    def recalculate_plan(self, user_id: str, today: date) -> TrainingPlan:
        plan = self.repo.get_active_plan(user_id)
        if plan is None:
            raise TrainingError("NO_PLAN", "There's no active plan to adapt.")
        return self._adapt(user_id, today, plan, "manual", "")

    def acknowledge_adaptation(self, user_id: str) -> None:
        plan = self.repo.get_active_plan(user_id)
        if plan and plan.last_adaptation and not plan.last_adaptation.acknowledged:
            adaptation = plan.last_adaptation.model_copy(update={"acknowledged": True})
            self.repo.apply(
                user_id, ChangeSet(upsert_plans=[plan.model_copy(update={"last_adaptation": adaptation})])
            )

    # ------------------------------------------------------------------ schedule (T-6, T-7)

    def get_schedule(self, user_id: str, today: date, start: date, end: date) -> Schedule:
        if end < start:
            raise TrainingError("VALIDATION", "Check the dates.", field_errors={"to": "End must not be before start"})
        if (end - start).days > self.rules.schedule_max_range_days:
            raise TrainingError(
                "VALIDATION",
                "That range is too long.",
                field_errors={"to": f"Ask for at most {self.rules.schedule_max_range_days} days at a time"},
            )
        self._sync(user_id, today)
        return Schedule(
            sessions=self.repo.list_sessions(user_id, start, end),
            workouts=self.repo.list_workouts(user_id, start, end),
        )

    def reschedule_session(
        self, user_id: str, today: date, session_id: str, target: date
    ) -> PlannedSession:
        plan = self._sync(user_id, today)
        session = self._require_session(user_id, session_id)
        if plan is None or session.plan_id != plan.id:
            raise TrainingError("NOT_MOVABLE", "Sessions from a replaced plan can't be moved.")

        refusal = check_move(session, target, self._placement_context(user_id, today, plan), self.rules)
        if refusal:
            raise TrainingError(refusal.code, refusal.reason, suggested_date=refusal.suggested_date)

        moved = session.model_copy(update={"date": target, "status": "moved"})
        self.repo.apply(user_id, ChangeSet(upsert_sessions=[moved]))
        return moved

    def remove_session(self, user_id: str, today: date, session_id: str) -> RemoveResult:
        self._sync(user_id, today)
        session = self._require_session(user_id, session_id)
        if session.status not in MOVABLE_STATUSES:
            raise TrainingError("NOT_MOVABLE", "Completed, partial and missed sessions can't be removed.")

        monday = week_start(session.date)
        rest = [
            s
            for s in self.repo.list_sessions(user_id, monday, monday + timedelta(days=6))
            if s.plan_id == session.plan_id and s.id != session.id and s.status in MOVABLE_STATUSES
        ]
        # Spread the removed volume over what's left of the week so weekly volume is kept.
        share = round_half_up(session.target_volume / len(rest)) if rest else 0
        updated = [s.model_copy(update={"target_volume": s.target_volume + share}) for s in rest]
        self.repo.apply(
            user_id, ChangeSet(delete_session_ids=[session.id], upsert_sessions=updated)
        )
        return RemoveResult(redistributed_count=len(rest))

    # ------------------------------------------------------------------ planning by hand

    def add_session(self, user_id: str, today: date, data: AddSessionRequest) -> AddSessionResult:
        """
        Plan a session on a day of the active plan. The plan, not the athlete, decides how much training a week
        carries (see `planner.week_pool`): the new session takes its share of that, by intensity and length, and the
        week's other sessions give a little to make room, the same promise removing one makes the other way round.
        """
        plan = self._require_plan(user_id, today, "Generate a training plan first, then you can plan sessions in it.")
        preferences = self._require_preferences(user_id, "Set your training preferences before planning sessions.")
        monday = week_start(data.date)
        self._require_details_allowed(plan, preferences, monday, data.activity_type, data.intensity_band)

        duration = (
            data.target_duration_min
            if data.target_duration_min is not None
            else default_duration_min(preferences.session_duration_min, data.intensity_band, self.rules)
        )
        context = self._placement_context(user_id, today, plan)
        draft = PlannedSession(
            id=_new_id(),
            plan_id=plan.id,
            date=data.date,
            activity_type=data.activity_type,
            target_volume=0,
            target_duration_min=duration,
            intensity_band=data.intensity_band,
            status="planned",
        )
        refusal = check_placement(draft, data.date, context, self.rules)
        if refusal:
            raise TrainingError(refusal.code, refusal.reason, suggested_date=refusal.suggested_date)

        week = self._plan_week(context, plan, monday)
        movable = [s for s in week if s.status in MOVABLE_STATUSES]
        pool = week_pool(
            target=plan_week_target(plan, monday, self.rules) or 0,
            finished=sum(s.target_volume for s in week if s.status not in MOVABLE_STATUSES),  # done or missed
            now=sum(s.target_volume for s in movable),
            sessions_after=len(movable) + 1,
            per_week=sessions_per_week(preferences),
        )
        if pool < len(movable) + 1:
            raise TrainingError(
                "WEEK_FULL",
                "That week's training load is already planned or done, so there's nothing left to share with "
                "another session. Pick another week, or log it as an extra workout once you've done it.",
            )

        share = share_week(pool, self._weights(movable), weight_of(data.intensity_band, duration, self.rules))
        added = draft.model_copy(update={"target_volume": share.new_volume})
        adjusted = self._with_volumes(movable, share.others)
        self.repo.apply(user_id, ChangeSet(upsert_sessions=[added, *adjusted]))
        return AddSessionResult(session=added, adjusted_count=len(adjusted))

    def update_session(
        self, user_id: str, today: date, session_id: str, patch: SessionUpdateRequest
    ) -> PlannedSession:
        """Move a session to another day, or change its activity, intensity or length where it stands."""
        if patch.date is not None:
            return self.reschedule_session(user_id, today, session_id, patch.date)

        plan = self._sync(user_id, today)
        session = self._require_session(user_id, session_id)
        if plan is None or session.plan_id != plan.id:
            raise TrainingError("NOT_MOVABLE", "Sessions from a replaced plan can't be changed.")
        if session.status not in MOVABLE_STATUSES:
            raise TrainingError("NOT_MOVABLE", "Completed, partial and missed sessions can't be changed.")

        asked = {
            "activity_type": patch.activity_type,
            "intensity_band": patch.intensity_band,
            "target_duration_min": patch.target_duration_min,
        }
        changes = {name: value for name, value in asked.items() if value is not None and value != getattr(session, name)}
        if not changes:
            raise TrainingError("NO_CHANGE", "That session already looks like that.")

        preferences = self._require_preferences(user_id, "Set your training preferences before changing a session.")
        monday = week_start(session.date)
        self._require_details_allowed(
            plan, preferences, monday, changes.get("activity_type"), changes.get("intensity_band")
        )
        updated = session.model_copy(update=changes)
        context = self._placement_context(user_id, today, plan)
        if "intensity_band" in changes:
            # Only the intensity can break a day rule where the session already stands: a push beside a push.
            refusal = check_placement(updated, updated.date, context, self.rules)
            if refusal:
                raise TrainingError(refusal.code, refusal.reason)

        adjusted: List[PlannedSession] = []
        if "intensity_band" in changes or "target_duration_min" in changes:
            # A different weight changes this session's share of the week; the week's total stays what it was.
            movable = [s for s in self._plan_week(context, plan, monday) if s.status in MOVABLE_STATUSES]
            others = [s for s in movable if s.id != session.id]
            share = share_week(
                sum(s.target_volume for s in movable),
                self._weights(others),
                weight_of(updated.intensity_band, updated.target_duration_min, self.rules),
            )
            updated = updated.model_copy(update={"target_volume": share.new_volume})
            adjusted = self._with_volumes(others, share.others)
        self.repo.apply(user_id, ChangeSet(upsert_sessions=[updated, *adjusted]))
        return updated

    # ------------------------------------------------------------------ today (T-3, T-4)

    def get_today(self, user_id: str, today: date) -> TodayView:
        plan = self._sync(user_id, today)
        planned: Optional[PlannedSession] = None
        if plan:
            planned = _session_for_today([s for s in self.repo.list_sessions(user_id, today, today) if s.plan_id == plan.id])
        sleep_hours = self.repo.get_sleep(user_id, today)
        readiness = self._readiness(user_id, today, sleep_hours)
        return TodayView(
            date=today,
            readiness=readiness,
            planned=planned,
            recommendation=reconcile(planned, readiness, self.rules) if planned else None,
            logged=self.repo.get_workout_for_session(user_id, planned.id) if planned else None,
            sleep_hours=sleep_hours,
        )

    # ------------------------------------------------------------------ Home summary and coach

    def get_summary(self, user_id: str, today: date) -> TrainingSummary:
        """Everything a Home card needs in one read: readiness, today, the week and what is next."""
        snapshot = self._snapshot(user_id, today)
        readiness = self._readiness(user_id, today, self.repo.get_sleep(user_id, today))
        recommendation = (
            reconcile(snapshot.session, readiness, self.rules)
            if snapshot.state == "to_do" and snapshot.session
            else None
        )
        return TrainingSummary(
            date=today,
            has_plan=snapshot.plan is not None,
            goal=snapshot.plan.goal if snapshot.plan else None,
            readiness=readiness,
            today=TodaySummary(
                state=snapshot.state,  # type: ignore[arg-type]
                session=snapshot.session,
                recommendation=recommendation,
                logged=snapshot.logged,
            ),
            week=snapshot.week,
            next_session=snapshot.next_session,
        )

    def get_coach_message(self, user_id: str, today: date) -> CoachMessage:
        """
        A short note about today from Gemini, or the built-in text when Gemini isn't configured or
        can't answer. The facts come from the plan snapshot only: readiness is never computed here.
        """
        snapshot = self._snapshot(user_id, today)
        context = self._coach_context(snapshot, today)
        if self.coach is None:
            return self._coach_message(today, fallback_message(context), "fallback", None)

        key = f"{user_id}:{context.fingerprint(today)}"
        now = self._clock()
        with self._coach_lock:
            hit = self._coach_cache.get(key)
            if hit and now - hit[0] < self.coach_rules.cache_ttl_s:
                return hit[1].model_copy(update={"cached": True})
            last = self._coach_last_call.get(user_id)
            if last is not None and now - last < self.coach_rules.cooldown_s:
                raise TrainingError("RATE_LIMITED", "Give the coach a few seconds before asking again.")
            self._coach_last_call[user_id] = now

        try:
            text = clean(self.coach.complete(SYSTEM_INSTRUCTION, build_prompt(context)), self.coach_rules)
        except CoachUnavailable as error:
            logger.warning("The coach fell back to its built-in message: %s", error)
            text = ""
        if not text:
            # Not remembered: a vendor hiccup shouldn't stick for an hour.
            return self._coach_message(today, fallback_message(context), "fallback", None)

        message = self._coach_message(today, text, "gemini", self.coach.model)
        with self._coach_lock:
            self._coach_cache[key] = (now, message)
            self._prune_coach_state(now)
        return message

    def _coach_message(self, today: date, text: str, source: str, model: Optional[str]) -> CoachMessage:
        return CoachMessage(
            date=today, message=text, source=source, model=model, cached=False, notice=PLAN_NOTICE  # type: ignore[arg-type]
        )

    def _prune_coach_state(self, now: float) -> None:
        """Drop expired entries, and the oldest ones if there are too many. Called with the lock held."""
        ttl = self.coach_rules.cache_ttl_s
        for key in [k for k, (stamp, _) in self._coach_cache.items() if now - stamp >= ttl]:
            del self._coach_cache[key]
        overflow = len(self._coach_cache) - self.coach_rules.cache_max_entries
        if overflow > 0:
            for key in sorted(self._coach_cache, key=lambda k: self._coach_cache[k][0])[:overflow]:
                del self._coach_cache[key]
        for user in [u for u, stamp in self._coach_last_call.items() if now - stamp >= ttl]:
            del self._coach_last_call[user]

    @staticmethod
    def _coach_context(snapshot: PlanSnapshot, today: date) -> CoachContext:
        """The only place facts are chosen for the coach. Nothing readiness-related is read here."""
        session = snapshot.session
        return CoachContext(
            weekday=weekday_name(today),
            goal=snapshot.plan.goal if snapshot.plan else None,
            state=snapshot.state,
            activity_type=session.activity_type if session else None,
            planned_band=session.intensity_band if session else None,
            duration_min=session.target_duration_min if session else None,
            week_planned=snapshot.week.planned_sessions,
            week_completed=snapshot.week.completed_sessions,
            week_missed=snapshot.week.missed_sessions,
            week_minutes=snapshot.week.logged_minutes,
        )

    def _snapshot(self, user_id: str, today: date) -> PlanSnapshot:
        plan = self._sync(user_id, today)
        monday = week_start(today)
        sunday = monday + timedelta(days=6)
        mine = [
            s for s in self.repo.list_sessions(user_id, monday, sunday) if plan and s.plan_id == plan.id
        ]
        session = _session_for_today([s for s in mine if s.date == today])
        # Hard Rule 1: Strava rows are dropped before anything is counted.
        workouts = modelling_workouts(self.repo.list_workouts(user_id, monday, sunday))
        upcoming: List[PlannedSession] = []
        if plan:
            ahead_end = min(plan.end_date, today + timedelta(days=28))
            upcoming = [
                s
                for s in self.repo.list_sessions(user_id, today + timedelta(days=1), ahead_end)
                if s.plan_id == plan.id and s.status in MOVABLE_STATUSES
            ]
        following = min(upcoming, key=lambda s: s.date) if upcoming else None
        return PlanSnapshot(
            plan=plan,
            session=session,
            logged=self.repo.get_workout_for_session(user_id, session.id) if session else None,
            week=WeekProgress(
                start=monday,
                end=sunday,
                planned_sessions=len(mine),
                completed_sessions=sum(1 for s in mine if s.status in ("completed", "partial")),
                missed_sessions=sum(1 for s in mine if s.status == "missed"),
                logged_minutes=sum(w.actual_duration_min for w in workouts),
            ),
            next_session=NextSession(
                date=following.date,
                activity_type=following.activity_type,
                intensity_band=following.intensity_band,
                target_duration_min=following.target_duration_min,
            )
            if following
            else None,
        )

    def respond_to_session(
        self, user_id: str, today: date, session_id: str, response: SessionResponseRequest
    ) -> PlannedSession:
        self._sync(user_id, today)
        session = self._require_session(user_id, session_id)
        if session.status not in MOVABLE_STATUSES:
            raise TrainingError("INVALID_STATE", "This session has already been logged or missed.")

        if response.action == "accept":
            updated = session.model_copy(update={"status": "accepted"})
        elif response.action == "swap":
            preferences = self.repo.get_preferences(user_id)
            if preferences and response.activity_type not in preferences.activity_types:
                raise TrainingError("INVALID_STATE", "Pick one of your preferred activity types.")
            updated = session.model_copy(
                update={"activity_type": response.activity_type, "status": "accepted"}
            )
        else:
            updated = session.model_copy(update={"status": "missed"})
        self.repo.apply(user_id, ChangeSet(upsert_sessions=[updated]))
        return updated

    def scorer_info(self) -> ModelInfo:
        return self.scorer.info()

    def score_features(self, features: ReadinessFeatures) -> ScoreResult:
        return self.scorer.score(features)

    def log_sleep(self, user_id: str, today: date, data: SleepInput) -> SleepEntry:
        """Last night's sleep, filed under today. Entering it again replaces it. The next read of
        today's readiness picks it up on its own, because the cached score is keyed on its inputs."""
        hours = round(data.hours, 2)
        self.repo.save_sleep(user_id, today, hours)
        return SleepEntry(date=today, hours=hours)

    def clear_sleep(self, user_id: str, today: date) -> None:
        self.repo.delete_sleep(user_id, today)

    # ------------------------------------------------------------------ logging (T-5)

    def log_session(
        self, user_id: str, today: date, session_id: str, data: LogWorkoutInput
    ) -> LogResult:
        session = self._require_session(user_id, session_id)
        if session.status not in LOGGABLE_STATUSES:
            raise TrainingError("INVALID_STATE", "That session has already been logged.")
        if session.date > today:
            raise TrainingError("INVALID_STATE", "You can't log a session that hasn't happened yet.")
        self._require_not_future(data.date, today)

        workout = self._workout_from(data, session.id)
        finished = data.actual_volume >= self.rules.partial_completion_ratio * session.target_volume
        updated = session.model_copy(update={"status": "completed" if finished else "partial"})
        # Tomorrow's readiness score picks this up on its own: its cached copy is keyed on the
        # inputs, so new history changes the key and the score is recomputed.
        self.repo.apply(user_id, ChangeSet(upsert_sessions=[updated], insert_workouts=[workout]))
        self._award_workout_xp(user_id, workout.id)
        return LogResult(workout=workout, session=updated)

    def log_ad_hoc_session(self, user_id: str, today: date, data: LogWorkoutInput) -> LogResult:
        self._require_not_future(data.date, today)
        workout = self._workout_from(data, None)
        self.repo.apply(user_id, ChangeSet(insert_workouts=[workout]))
        self._award_workout_xp(user_id, workout.id)
        return LogResult(workout=workout, session=None)

    # ------------------------------------------------------------------ internals

    def _award_workout_xp(self, user_id: str, workout_id: str) -> None:
        """XP for the leaderboard. The workout is already saved, so nothing here may make the log fail."""
        try:
            self.repo.award_workout_xp(user_id, workout_id)
        except Exception as error:  # noqa: BLE001 - an optional side effect, whatever goes wrong with it
            logger.warning("XP for a logged workout wasn't recorded: %s", type(error).__name__)

    def _require_session(self, user_id: str, session_id: str) -> PlannedSession:
        session = self.repo.get_session(user_id, session_id)
        if session is None:
            raise TrainingError("NOT_FOUND", "That session no longer exists.")
        return session

    def _require_plan(self, user_id: str, today: date, message: str) -> TrainingPlan:
        plan = self._sync(user_id, today)
        if plan is None:
            raise TrainingError("NO_PLAN", message)
        return plan

    def _require_preferences(self, user_id: str, message: str) -> TrainingPreferences:
        preferences = self.repo.get_preferences(user_id)
        if preferences is None:
            raise TrainingError("NO_PREFERENCES", message)
        return preferences

    def _require_details_allowed(
        self,
        plan: TrainingPlan,
        preferences: TrainingPreferences,
        week_monday: date,
        activity_type: Optional[ActivityType],
        band: Optional[IntensityBand],
    ) -> None:
        """A hand-planned session uses one of the athlete's own activities and an intensity its week allows."""
        problems: Dict[str, str] = {}
        if activity_type is not None and activity_type not in preferences.activity_types:
            problems["activityType"] = "Pick one of your preferred activity types"
        if band is not None:
            why_not = band_refusal(band, is_deload_week(plan, week_monday, self.rules))
            if why_not:
                problems["intensityBand"] = why_not
        if problems:
            raise TrainingError("VALIDATION", "Check the highlighted fields.", field_errors=problems)

    def _placement_context(self, user_id: str, today: date, plan: TrainingPlan) -> MoveContext:
        """
        Every session the athlete has in the plan's days and one day either side, whichever plan it belongs to. The
        database allows one planned session a day per user, so a finished session from a replaced plan still takes its
        day, and a push the day before the plan starts still counts as a neighbour.
        """
        return MoveContext(
            sessions=self.repo.list_sessions(
                user_id, plan.start_date - timedelta(days=1), plan.end_date + timedelta(days=1)
            ),
            plan_start=plan.start_date,
            plan_end=plan.end_date,
            today=today,
        )

    @staticmethod
    def _plan_week(context: MoveContext, plan: TrainingPlan, monday: date) -> List[PlannedSession]:
        """The plan's own sessions in the Monday-to-Sunday week starting `monday`."""
        sunday = monday + timedelta(days=6)
        return [s for s in context.sessions if s.plan_id == plan.id and monday <= s.date <= sunday]

    def _weights(self, sessions: Sequence[PlannedSession]) -> List[Tuple[str, int, float]]:
        return [
            (s.id, s.target_volume, weight_of(s.intensity_band, s.target_duration_min, self.rules)) for s in sessions
        ]

    @staticmethod
    def _with_volumes(sessions: Sequence[PlannedSession], volumes: Dict[str, int]) -> List[PlannedSession]:
        """The sessions whose points are different in `volumes`, with the new points. The rest are left out."""
        return [
            s.model_copy(update={"target_volume": volumes[s.id]}) for s in sessions if volumes[s.id] != s.target_volume
        ]

    def _require_safe(self, targets: Sequence[WeekTarget]) -> None:
        unsafe = first_unsafe_week(targets, self.rules)
        if unsafe != -1:
            raise TrainingError(
                "PLAN_UNSAFE",
                f"Week {unsafe + 1} would raise volume by more than "
                f"{self.rules.max_weekly_increase_pct:g}%, so no plan was saved.",
            )

    @staticmethod
    def _require_not_future(day: date, today: date) -> None:
        if day > today:
            raise TrainingError(
                "VALIDATION",
                "Check the highlighted fields.",
                field_errors={"date": "Date can't be in the future"},
            )

    @staticmethod
    def _workout_from(data: LogWorkoutInput, session_id: Optional[str]) -> WorkoutSession:
        return WorkoutSession(
            id=_new_id(),
            planned_session_id=session_id,
            date=data.date,
            activity_type=data.activity_type,
            actual_volume=data.actual_volume,
            actual_duration_min=data.actual_duration_min,
            rpe=data.rpe,
            avg_hr=data.avg_hr,
            calories=data.calories,
            distance_m=None if data.distance_km is None else round(data.distance_km * 1000, 1),
            source="manual",
            created_at=_now(),
        )

    def _forecast(self, user_id: str, today: date) -> LoadForecast:
        """
        The athlete's load forecast as of `today`, from what they actually logged (Hard Rules 1 and 3: Strava rows never
        count, and what was planned never stands in for what was done).
        """
        reach = max(self.forecast_rules.window_weeks, self.forecast_rules.adherence_window_weeks)
        since = week_start(today) - timedelta(weeks=reach)
        workouts = self.repo.list_workouts(user_id, since, today)
        sessions = self.repo.list_sessions(user_id, since, week_start(today) - timedelta(days=1))
        records = [ActivityRecord(w.date, w.actual_volume, w.avg_hr, w.source) for w in workouts]
        acwr = build_features(records, None, today).acwr
        return build_forecast(workouts, sessions, acwr, today, self.rules, self.forecast_rules)

    def _plan_targets(
        self, baseline: float, weeks: int, week_offset: int, forecast: LoadForecast
    ) -> Tuple[List[WeekTarget], Optional[float]]:
        """
        The weekly targets for a plan, and the weekly progression they were built with (None when the database has no
        place to keep one). The forecast's rate is used, but a plan the safety check would reject at that rate is built
        at the standard one instead, and one the standard rate can't make safe is still refused.
        """
        if not self.repo.supports_plan_progression():
            targets = weekly_targets(baseline, weeks, week_offset, self.rules)
            self._require_safe(targets)
            return targets, None
        targets = weekly_targets(baseline, weeks, week_offset, self.rules, progression_pct=forecast.rate_pct)
        if first_unsafe_week(targets, self.rules) == -1:
            return targets, forecast.rate_pct
        standard = self.rules.weekly_progression_pct
        targets = weekly_targets(baseline, weeks, week_offset, self.rules, progression_pct=standard)
        self._require_safe(targets)
        return targets, standard

    def get_forecast(self, user_id: str, today: date) -> ForecastView:
        """The athlete's weekly load, the forecast fitted to it, and the progression it supports (a read, nothing changes)."""
        plan = self.repo.get_active_plan(user_id)
        return forecast_view(
            self._forecast(user_id, today), plan.progression_pct if plan else None, self.rules, self.forecast_rules
        )

    def _baseline(self, user_id: str, today: date, profile: Optional[AthleteProfile]) -> Baseline:
        window_start = week_start(today) - timedelta(weeks=self.rules.baseline_window_weeks)
        workouts = self.repo.list_workouts(user_id, window_start, today)
        return baseline_from_history(
            workouts, today, self.rules, profile.activity_level if profile else None
        )

    def _new_sessions(
        self,
        plan_id: str,
        preferences: TrainingPreferences,
        start: date,
        targets: Sequence[WeekTarget],
        from_date: date,
        taken: Set[date],
        goal: Optional[str] = None,
    ) -> List[PlannedSession]:
        drafts = build_sessions(preferences, start, targets, from_date, self.rules, goal)
        return [
            PlannedSession(
                id=_new_id(),
                plan_id=plan_id,
                date=d.date,
                activity_type=d.activity_type,
                target_volume=d.target_volume,
                target_duration_min=d.target_duration_min,
                intensity_band=d.intensity_band,
                status="planned",
            )
            for d in drafts
            if d.date not in taken
        ]

    def _readiness(self, user_id: str, today: date, sleep_hours: Optional[float]) -> ReadinessScore:
        history = self.repo.list_workouts(user_id, today - timedelta(days=28), today - timedelta(days=1))
        records = [ActivityRecord(w.date, w.actual_volume, w.avg_hr, w.source) for w in history]
        preferences = self.repo.get_preferences(user_id)
        features = build_features(
            records,
            self.repo.get_latest_checkin(user_id, today),
            today,
            days_until_next_exam(preferences.exam_dates if preferences else [], today),
            sleep_hours=sleep_hours,
        )
        digest = fingerprint(features, self.scorer.version)

        cached = self.repo.get_cached_readiness(user_id, today)
        if cached and cached[1] == digest:
            return cached[0]

        result = self.scorer.score(features)
        score = ReadinessScore(**result.model_dump(), date=today, computed_at=_now())
        self.repo.save_readiness(user_id, score, digest)
        return score

    def _adapt(
        self, user_id: str, today: date, plan: TrainingPlan, trigger: str, lead: str
    ) -> TrainingPlan:
        """Rebaseline on what was completed and regenerate only the weeks still to come."""
        preferences = self.repo.get_preferences(user_id)
        if preferences is None:
            raise TrainingError("NO_PREFERENCES", "Set your training preferences before adapting a plan.")
        if today > plan.end_date:
            raise TrainingError("PLAN_ENDED", "Your plan has finished. Generate a new one instead.")

        profile = self.repo.get_profile(user_id)
        goal = goal_for(profile, self.rules)
        baseline = self._baseline(user_id, today, profile)
        monday = week_start(today)
        weeks_elapsed = max(0, (monday - plan.start_date).days // 7)
        remaining = plan.weeks - weeks_elapsed
        forecast = self._forecast(user_id, today)
        targets, progression = self._plan_targets(baseline.volume, remaining, weeks_elapsed, forecast)

        upcoming = self.repo.list_sessions(user_id, today, plan.end_date)
        drop = [s.id for s in upcoming if s.plan_id == plan.id and s.status in MOVABLE_STATUSES]
        taken = {s.date for s in upcoming if s.id not in drop}
        sessions = self._new_sessions(plan.id, preferences, monday, targets, today, taken, goal)

        weeks = self.rules.baseline_window_weeks
        if baseline.used_default:
            rebase = (
                f"There are fewer than {self.rules.min_history_weeks_for_baseline} weeks of logged "
                f"training in the last {weeks} weeks, so a conservative default of "
                f"{baseline.volume:.0f} pts/week was used"
                + (" for your activity level." if baseline.from_profile else ".")
            )
        else:
            rebase = (
                f"Rebaselined from your {baseline.session_count} logged sessions in the last "
                f"{weeks} weeks: {plan.baseline_volume:.0f} to {baseline.volume:.0f} pts/week."
            )
        standard = self.rules.weekly_progression_pct
        pace = (
            f"Weekly progression is now {fmt(progression)}% instead of the standard {fmt(standard)}%: see the load "
            "forecast on the Plan tab."
            if progression is not None and progression != standard
            else ""
        )
        reason = " ".join(
            part
            for part in (lead, rebase, f"Only the remaining {remaining} week(s) were regenerated.", pace)
            if part
        )

        adapted = plan.model_copy(
            update={
                "baseline_volume": baseline.volume,
                "goal": goal,
                "progression_pct": progression,
                "last_adaptation": PlanAdaptation(
                    trigger=trigger,
                    reason=reason,
                    adapted_at=_now(),
                    adapted_on=today,
                    acknowledged=False,
                ),
            }
        )
        self.repo.apply(
            user_id,
            ChangeSet(delete_session_ids=drop, upsert_plans=[adapted], upsert_sessions=sessions),
        )
        return adapted

    def _sync(self, user_id: str, today: date) -> Optional[TrainingPlan]:
        """
        Bring the plan up to date: sessions whose day has passed without being logged become
        missed, and if that (or persistently low readiness) crosses a trigger, the plan is adapted.
        Runs when the plan is read, so nothing needs a scheduler. It is idempotent.
        """
        plan = self.repo.get_active_plan(user_id)
        if plan is None or today <= plan.start_date:
            return plan

        window_end = min(plan.end_date, today - timedelta(days=1))
        past = [
            s
            for s in self.repo.list_sessions(user_id, plan.start_date, window_end)
            if s.plan_id == plan.id
        ]
        overdue = [s for s in past if s.status in MOVABLE_STATUSES and s.date < today]
        if overdue:
            missed = [s.model_copy(update={"status": "missed"}) for s in overdue]
            self.repo.apply(user_id, ChangeSet(upsert_sessions=missed))
            by_id = {s.id: s for s in missed}
            past = [by_id.get(s.id, s) for s in past]

        trigger = self._auto_trigger(user_id, today, plan, past)
        if trigger is None:
            return plan
        try:
            return self._adapt(user_id, today, plan, trigger[0], trigger[1])
        except TrainingError as error:
            logger.warning("Auto-adapt skipped for a user: %s", error.message)
            return plan

    def _auto_trigger(
        self, user_id: str, today: date, plan: TrainingPlan, past: List[PlannedSession]
    ) -> Optional[Tuple[str, str]]:
        # Only what happened since the last adaptation counts, or the same misses would trigger forever.
        since = plan.last_adaptation.adapted_on if plan.last_adaptation else plan.start_date

        missed_n = self.rules.missed_sessions_trigger
        recent = sorted((s for s in past if s.date >= since), key=lambda s: s.date)
        if len(recent) >= missed_n and all(s.status == "missed" for s in recent[-missed_n:]):
            return "missed_sessions", f"You missed your last {missed_n} sessions in a row."

        low_n = self.rules.low_readiness_days_trigger
        days = [today - timedelta(days=i) for i in range(1, low_n + 1)]
        if min(days) >= since:
            scores = {s.date: s for s in self.repo.list_readiness(user_id, min(days), max(days))}
            if all(
                d in scores and scores[d].classification == self.rules.low_readiness_classification
                for d in days
            ):
                return "low_readiness", f"Your readiness stayed low for {low_n} days in a row."
        return None
