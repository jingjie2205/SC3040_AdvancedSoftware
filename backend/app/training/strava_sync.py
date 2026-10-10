"""
Strava activities pulled for the athlete to look over, and saved to their schedule one by one or all at once.

Pulling ("Upload Strava data") asks Strava for the latest activities and returns them as cards, saving nothing.
Saving ("Save to schedule") asks Strava again for the activities the athlete picked and writes each as an ordinary
training log with source = "strava" and the Strava activity's id, so what is saved is what Strava said and never
what a browser sends. Saving the same activity twice does nothing.

Hard Rule 1: Strava data never reaches an AI feature. So this module is the one place in the training package that
touches Strava code, and the only one that writes a Strava log. Those logs sit in `training_workout_logs` beside
the athlete's own, flagged source = "strava", and every calculation in the training backend (the readiness
features, the plan baseline, the summary, the coach) drops them before it counts anything. They are shown on the
schedule and nowhere else, they are never linked to a planned session, and saving one awards no XP.
`test_training_strava_isolation.py` pins all of that.
"""
import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol, Sequence, Set, Tuple
from uuid import uuid4

import httpx
from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import Field, ValidationError
from starlette.concurrency import run_in_threadpool

from ..services import strava as strava_service
from .config import RULES, TrainingRules
from .errors import TrainingError
from .models import ActivityType, ApiModel, WorkoutSession
from .repository import _SCHEMA_NOT_READY

logger = logging.getLogger(__name__)

TABLE = "training_workout_logs"
SOURCE = "strava"

FETCH_LIMIT = 100  # the latest activities asked of Strava per pull, in one request

# What the schedule can hold: it has four kinds of training, so only activities that are one of them can be
# saved. Everything else (walks, swims, hikes, yoga...) is still listed, and says why it can't be saved.
ACTIVITY_FOR_TYPE: Dict[str, ActivityType] = {
    "Run": "run",
    "TrailRun": "run",
    "VirtualRun": "run",
    "Ride": "cycling",
    "VirtualRide": "cycling",
    "EBikeRide": "cycling",
    "MountainBikeRide": "cycling",
    "EMountainBikeRide": "cycling",
    "GravelRide": "cycling",
    "WeightTraining": "gym",
    "Workout": "bodyweight",
    "Crossfit": "bodyweight",
    "HighIntensityIntervalTraining": "bodyweight",
}


# --------------------------------------------------------------------------- what goes over the wire


class StravaCard(ApiModel):
    strava_id: int
    name: str
    sport_type: str  # Strava's own word: "Run", "Ride", "Swim"...
    started_local: datetime  # the athlete's wall clock, not a point in time
    distance_m: float
    moving_time_s: int
    elevation_gain_m: float
    average_heartrate: Optional[float] = None
    # How it would be saved to the schedule. All three are None when the schedule has no place for it.
    activity_type: Optional[ActivityType] = None
    duration_min: Optional[int] = None
    volume: Optional[int] = None
    saved: bool = False


class PullResult(ApiModel):
    activities: List[StravaCard]


class SaveRequest(ApiModel):
    strava_ids: List[int] = Field(min_length=1, max_length=FETCH_LIMIT)


class SaveResult(ApiModel):
    saved_ids: List[int]  # the activities that were saved just now
    already_saved: int  # asked for, but on the schedule already
    skipped: int  # asked for, but not in Strava's latest, or with nowhere on the schedule to go


class StravaStatus(ApiModel):
    connected: bool
    saved_count: int  # activities from Strava on the schedule


class DeleteResult(ApiModel):
    deleted: int


# --------------------------------------------------------------------------- from Strava's activity to a card


class StravaActivityLike(Protocol):
    """The fields of Strava's activity that are read. The team's `services.strava.StravaActivity` has them all."""

    id: int
    name: str
    type: str
    start_date: str
    start_date_local: Optional[str]
    elapsed_time: int
    moving_time: int
    distance: float
    total_elevation_gain: float
    average_heartrate: Optional[float]


def _local_start(*candidates: Optional[str]) -> Optional[datetime]:
    """Strava's "local" start is the athlete's wall clock, with a Z on the end that doesn't mean UTC."""
    for text in candidates:
        if not text:
            continue
        try:
            return datetime.fromisoformat(text.strip().removesuffix("Z")).replace(tzinfo=None)
        except ValueError:
            continue
    return None


def _half_up(value: float) -> int:
    return int(value + 0.5)


def log_figures(
    moving_time_s: int, average_heartrate: Optional[float], rules: TrainingRules = RULES
) -> Optional[Tuple[int, int, Optional[int]]]:
    """(minutes, pts, average heart rate) a Strava activity is saved with, or None if it took no time at all."""
    if moving_time_s <= 0:
        return None
    minutes = min(max(1, _half_up(moving_time_s / 60)), rules.workout_duration_max)
    points = min(max(1, _half_up(minutes * rules.strava_points_per_minute)), int(rules.workout_volume_max))
    heart = None
    if average_heartrate and rules.workout_hr_min <= average_heartrate <= rules.workout_hr_max:
        heart = _half_up(average_heartrate)
    return minutes, points, heart


def to_card(activity: StravaActivityLike, saved: bool = False, rules: TrainingRules = RULES) -> Optional[StravaCard]:
    """A card for the activity, or None if there is nothing to show (no usable start)."""
    started = _local_start(activity.start_date_local, activity.start_date)
    if started is None:
        return None
    moving = max(int(activity.moving_time or 0), 0)
    heart = activity.average_heartrate
    activity_type = ACTIVITY_FOR_TYPE.get(activity.type)
    figures = log_figures(moving, heart, rules) if activity_type else None
    return StravaCard(
        strava_id=int(activity.id),
        name=(activity.name or "").strip()[:200] or "Untitled activity",
        sport_type=activity.type,
        started_local=started,
        distance_m=round(max(float(activity.distance or 0), 0.0), 1),
        moving_time_s=moving,
        elevation_gain_m=round(max(float(activity.total_elevation_gain or 0), 0.0), 1),
        average_heartrate=round(float(heart), 1) if heart and heart > 0 else None,
        activity_type=activity_type if figures else None,
        duration_min=figures[0] if figures else None,
        volume=figures[1] if figures else None,
        saved=saved,
    )


# --------------------------------------------------------------------------- the table


@contextmanager
def _table_ready() -> Iterator[None]:
    """A database that hasn't had the migration yet is a clear 503, not a crash."""
    try:
        yield
    except APIError as error:
        if error.code not in _SCHEMA_NOT_READY:
            raise
        raise TrainingError(
            "UNAVAILABLE",
            "Saving Strava activities to your schedule isn't set up on this database yet. "
            "Apply the latest training migration first.",
        ) from error


def _row(user_id: str, log: WorkoutSession) -> Dict[str, Any]:
    """Only the columns the table has. (The API model carries fields that aren't columns, such as calories.)"""
    return {
        "id": log.id,
        "user_id": user_id,
        "planned_session_id": None,  # a Strava log is never tied to a planned session
        "date": log.date.isoformat(),
        "activity_type": log.activity_type,
        "actual_volume": log.actual_volume,
        "actual_duration_min": log.actual_duration_min,
        "rpe": None,
        "avg_hr": log.avg_hr,
        "source": SOURCE,
        "external_id": log.external_id,
        "created_at": log.created_at.isoformat(),
    }


class StravaLogRepository:
    """Every query names the user and the source: the backend's service role bypasses row-level security."""

    def __init__(self, client: Any) -> None:
        self.db = client

    def saved_ids(self, user_id: str) -> Set[int]:
        with _table_ready():
            rows = (
                self.db.table(TABLE)
                .select("external_id")
                .eq("user_id", user_id)
                .eq("source", SOURCE)
                .execute()
                .data
            )
        ids: Set[int] = set()
        for row in rows or []:
            try:
                ids.add(int(row["external_id"]))
            except (TypeError, ValueError):
                continue
        return ids

    def save_logs(self, user_id: str, logs: Sequence[WorkoutSession]) -> None:
        rows = [_row(user_id, log) for log in logs]
        with _table_ready():
            # "do nothing" on a clash, so a second save of the same activity leaves the first one exactly as it was
            self.db.table(TABLE).upsert(
                rows, on_conflict="user_id,source,external_id", ignore_duplicates=True
            ).execute()

    def delete_all(self, user_id: str) -> int:
        count = len(self.saved_ids(user_id))
        with _table_ready():
            self.db.table(TABLE).delete().eq("user_id", user_id).eq("source", SOURCE).execute()
        return count


# --------------------------------------------------------------------------- Strava itself


class StravaSource(Protocol):
    def is_connected(self, user_id: str) -> bool: ...

    async def latest_activities(self, user_id: str, limit: int) -> Sequence[StravaActivityLike]: ...


class StravaAccount:
    """The athlete's own Strava connection, through the team's Strava service (which renews expired tokens)."""

    def __init__(self, client: Any) -> None:
        self.db = client

    def is_connected(self, user_id: str) -> bool:
        # The expiry is saved and cleared together with the tokens, so it says "connected" without reading them.
        rows = self.db.table("users").select("strava_expires_at").eq("user_id", user_id).limit(1).execute().data
        return bool(rows and rows[0].get("strava_expires_at"))

    async def latest_activities(self, user_id: str, limit: int) -> Sequence[StravaActivityLike]:
        token = await strava_service.check_valid_strava_token(user_id)
        return await strava_service.fetch_strava_activities(token, 1, limit)


def _not_connected(message: str = "Connect Strava first.") -> TrainingError:
    return TrainingError("NOT_CONNECTED", message)


def strava_failure(error: Exception) -> TrainingError:
    """What a failure reaching Strava means for the athlete."""
    if isinstance(error, TrainingError):
        return error
    if isinstance(error, HTTPException) and error.status_code == 400:
        return _not_connected()  # the team's service says "Strava account not connected"
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status == 429:
            return TrainingError("RATE_LIMITED", "Strava is limiting requests right now. Try again in a few minutes.")
        if status in (400, 401, 403):
            return _not_connected(
                "Strava no longer accepts your saved connection. Disconnect and connect Strava again in Settings."
            )
    if isinstance(error, (httpx.HTTPError, ValidationError)):
        logger.warning("Strava request failed: %s", type(error).__name__)
    else:
        logger.exception("Strava request failed unexpectedly")
    return TrainingError("UNAVAILABLE", "Strava didn't respond. Try again in a minute.")


# --------------------------------------------------------------------------- the service


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return str(uuid4())


class StravaSyncService:
    def __init__(
        self,
        repository: StravaLogRepository,
        source: StravaSource,
        rules: TrainingRules = RULES,
        clock: Callable[[], datetime] = _utcnow,
        new_id: Callable[[], str] = _new_id,
    ) -> None:
        self.repo = repository
        self.source = source
        self.rules = rules
        self.clock = clock
        self.new_id = new_id

    def status(self, user_id: str) -> StravaStatus:
        return StravaStatus(connected=self.source.is_connected(user_id), saved_count=len(self.repo.saved_ids(user_id)))

    async def pull(self, user_id: str) -> PullResult:
        """The athlete's latest Strava activities as cards, newest first. Nothing is saved."""
        activities = await self._latest(user_id)
        saved = await run_in_threadpool(self.repo.saved_ids, user_id)
        cards = [to_card(activity, int(activity.id) in saved, self.rules) for activity in activities]
        return PullResult(activities=sorted((c for c in cards if c), key=lambda c: c.started_local, reverse=True))

    async def save(self, user_id: str, strava_ids: Sequence[int]) -> SaveResult:
        """Save the chosen activities to the schedule. Asks Strava again, and saves nothing twice."""
        wanted = list(dict.fromkeys(strava_ids))
        activities = await self._latest(user_id)
        return await run_in_threadpool(self._save, user_id, wanted, activities)

    def delete(self, user_id: str) -> DeleteResult:
        """Take every activity that came from Strava off the schedule. The athlete's own logs stay."""
        return DeleteResult(deleted=self.repo.delete_all(user_id))

    # ---------------------------------------------------------------- inside

    async def _latest(self, user_id: str) -> Sequence[StravaActivityLike]:
        if not await run_in_threadpool(self.source.is_connected, user_id):
            raise _not_connected()
        try:
            return list(await self.source.latest_activities(user_id, FETCH_LIMIT))
        except Exception as error:  # noqa: BLE001 - whatever the vendor does, the athlete gets a plain reason
            raise strava_failure(error) from error

    def _log_for(self, activity: StravaActivityLike) -> Optional[WorkoutSession]:
        activity_type = ACTIVITY_FOR_TYPE.get(activity.type)
        started = _local_start(activity.start_date_local, activity.start_date)
        figures = log_figures(max(int(activity.moving_time or 0), 0), activity.average_heartrate, self.rules)
        if activity_type is None or started is None or figures is None:
            return None
        minutes, points, heart = figures
        return WorkoutSession(
            id=self.new_id(),
            planned_session_id=None,
            date=started.date(),
            activity_type=activity_type,
            actual_volume=points,
            actual_duration_min=minutes,
            rpe=None,
            avg_hr=heart,
            source="strava",
            external_id=str(int(activity.id)),
            created_at=self.clock(),
        )

    def _save(self, user_id: str, wanted: Sequence[int], activities: Sequence[StravaActivityLike]) -> SaveResult:
        by_id = {int(activity.id): activity for activity in activities}
        already = self.repo.saved_ids(user_id)
        logs: List[WorkoutSession] = []
        saved_ids: List[int] = []
        already_saved = skipped = 0
        for strava_id in wanted:
            if strava_id in already:
                already_saved += 1
                continue
            log = self._log_for(by_id[strava_id]) if strava_id in by_id else None
            if log is None:
                skipped += 1
                continue
            logs.append(log)
            saved_ids.append(strava_id)
        if logs:
            self.repo.save_logs(user_id, logs)
        return SaveResult(saved_ids=saved_ids, already_saved=already_saved, skipped=skipped)
