"""
The routes behind the training page's Strava tab: whether Strava is connected and how much is on the schedule,
pulling the athlete's latest activities, saving chosen ones to the schedule, and taking them off again. Everything
else about Strava stays where the team put it (`/strava/...`).

Hard Rule 1: this is the only router that touches `strava_sync.py`, and nothing in the readiness score, the plan,
the summary or the coach imports it. `test_training_strava_isolation.py` pins that.
"""
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends

from ..commons.auth.deps import get_current_user_id, get_supabase_admin
from .repository import ThreadLocalClient
from .strava_sync import (
    DeleteResult,
    PullResult,
    SaveRequest,
    SaveResult,
    StravaAccount,
    StravaLogRepository,
    StravaStatus,
    StravaSyncService,
)

router = APIRouter(prefix="/api/v1/training/strava", tags=["Training: Strava"])


@lru_cache
def _default_service() -> StravaSyncService:
    client = ThreadLocalClient(get_supabase_admin)
    return StravaSyncService(StravaLogRepository(client), StravaAccount(client))


def get_sync_service() -> StravaSyncService:
    return _default_service()


UserId = Annotated[str, Depends(get_current_user_id)]
SyncService = Annotated[StravaSyncService, Depends(get_sync_service)]


@router.get("/status", response_model=StravaStatus)
def get_status(user_id: UserId, service: SyncService):
    """Whether Strava is connected, and how many activities from it are on the schedule. No call to Strava."""
    return service.status(user_id)


@router.post("/pull", response_model=PullResult)
async def pull_activities(user_id: UserId, service: SyncService):
    """The athlete's latest Strava activities as cards. Saves nothing."""
    return await service.pull(user_id)


@router.post("/save", response_model=SaveResult)
async def save_to_schedule(body: SaveRequest, user_id: UserId, service: SyncService):
    """Save the chosen activities to the schedule as training logs. Saving one that is already there does nothing."""
    return await service.save(user_id, body.strava_ids)


@router.delete("/logs", response_model=DeleteResult)
def remove_from_schedule(user_id: UserId, service: SyncService):
    """Take every activity that came from Strava off the schedule. The athlete's own logs stay."""
    return service.delete(user_id)
