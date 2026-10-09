"""
Application logic for the training routine. Every method takes the user id from the verified
session (never from a request body) and `today` from the caller, so it stays pure and testable.
"""
import logging
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional, Sequence, Set, Tuple
from uuid import uuid4

from .config import PLAN_NOTICE, RULES, TrainingRules
from .errors import TrainingError
from .models import (
    GeneratePlanRequest,
    LogResult,
    LogWorkoutInput,
    ModelInfo,
    PlanAdaptation,
    PlannedSession,
    ReadinessScore,
    RemoveResult,
    Schedule,
    ScoreResult,
    SessionResponseRequest,
    SleepEntry,
    SleepInput,
    TodayView,
    TrainingPlan,
    TrainingPreferences,
    TrainingPreferencesInput,
    WorkoutSession,
)
from .planner import (
    AthleteProfile,
    Baseline,
    WeekTarget,
    baseline_from_history,
    build_sessions,
    first_unsafe_week,
    goal_for,
    plan_end_date,
    round_half_up,
    week_start,
    weekly_targets,
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
from .rules import LOGGABLE_STATUSES, MOVABLE_STATUSES, MoveContext, check_move, reconcile

logger = logging.getLogger("endurance.training")


def _new_id() -> str:
    return str(uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TrainingService:
    def __init__(
        self,
        repository: TrainingRepository,
        scorer: ReadinessScorer,
        rules: TrainingRules = RULES,
    ) -> None:
        self.repo = repository
        self.scorer = scorer
        self.rules = rules

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
        targets = weekly_targets(baseline.volume, request.weeks, 0, self.rules)
        self._require_safe(targets)

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

        context = MoveContext(
            sessions=[
                s
                for s in self.repo.list_sessions(user_id, plan.start_date, plan.end_date)
                if s.plan_id == plan.id
            ],
            plan_start=plan.start_date,
            plan_end=plan.end_date,
            today=today,
        )
        refusal = check_move(session, target, context, self.rules)
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

    # ------------------------------------------------------------------ today (T-3, T-4)

    def get_today(self, user_id: str, today: date) -> TodayView:
        plan = self._sync(user_id, today)
        planned: Optional[PlannedSession] = None
        if plan:
            planned = next(
                (s for s in self.repo.list_sessions(user_id, today, today) if s.plan_id == plan.id),
                None,
            )
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
        return LogResult(workout=workout, session=updated)

    def log_ad_hoc_session(self, user_id: str, today: date, data: LogWorkoutInput) -> LogResult:
        self._require_not_future(data.date, today)
        workout = self._workout_from(data, None)
        self.repo.apply(user_id, ChangeSet(insert_workouts=[workout]))
        return LogResult(workout=workout, session=None)

    # ------------------------------------------------------------------ internals

    def _require_session(self, user_id: str, session_id: str) -> PlannedSession:
        session = self.repo.get_session(user_id, session_id)
        if session is None:
            raise TrainingError("NOT_FOUND", "That session no longer exists.")
        return session

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
            source="manual",
            created_at=_now(),
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
        targets = weekly_targets(baseline.volume, remaining, weeks_elapsed, self.rules)
        self._require_safe(targets)

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
        reason = " ".join(
            part for part in (lead, rebase, f"Only the remaining {remaining} week(s) were regenerated.") if part
        )

        adapted = plan.model_copy(
            update={
                "baseline_volume": baseline.volume,
                "goal": goal,
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
