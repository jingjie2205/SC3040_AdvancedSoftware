from datetime import date
from functools import lru_cache
from typing import Annotated, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..commons.auth.deps import get_current_user_id
from .clock import get_client_date
from .coach import load_coach
from .models import (
    CoachMessage,
    GeneratePlanRequest,
    LogResult,
    LogWorkoutInput,
    ModelInfo,
    PlannedSession,
    RemoveResult,
    RescheduleRequest,
    Schedule,
    ScoreResult,
    SessionResponseRequest,
    SleepEntry,
    SleepInput,
    TodayView,
    TrainingPlan,
    TrainingPreferences,
    TrainingPreferencesInput,
    TrainingSummary,
)
from .ml.scorer import load_scorer
from .readiness import ReadinessFeatures
from .repository import create_repository
from .service import TrainingService

TRAINING_PREFIX = "/api/v1/training"
READINESS_PREFIX = "/api/v1/readiness"

router = APIRouter(prefix=TRAINING_PREFIX, tags=["Training"])
readiness_router = APIRouter(prefix=READINESS_PREFIX, tags=["Readiness"])


@lru_cache
def _default_service() -> TrainingService:
    return TrainingService(create_repository(), load_scorer(), coach=load_coach())


def get_service() -> TrainingService:
    return _default_service()


UserId = Annotated[str, Depends(get_current_user_id)]
Today = Annotated[date, Depends(get_client_date)]
Service = Annotated[TrainingService, Depends(get_service)]


# --------------------------------------------------------------------------- preferences


@router.get("/preferences", response_model=Optional[TrainingPreferences])
def get_preferences(user_id: UserId, service: Service):
    return service.get_preferences(user_id)


@router.put("/preferences", response_model=TrainingPreferences)
def put_preferences(body: TrainingPreferencesInput, user_id: UserId, today: Today, service: Service):
    return service.save_preferences(user_id, today, body)


# --------------------------------------------------------------------------- plan


@router.get("/plan", response_model=Optional[TrainingPlan])
def get_plan(user_id: UserId, today: Today, service: Service):
    return service.get_plan(user_id, today)


@router.post("/plan", response_model=TrainingPlan)
def generate_plan(body: GeneratePlanRequest, user_id: UserId, today: Today, service: Service):
    return service.generate_plan(user_id, today, body)


@router.post("/plan/recalculate", response_model=TrainingPlan)
def recalculate_plan(user_id: UserId, today: Today, service: Service):
    return service.recalculate_plan(user_id, today)


@router.post("/plan/adaptation/acknowledge", status_code=204)
def acknowledge_adaptation(user_id: UserId, service: Service):
    service.acknowledge_adaptation(user_id)
    return Response(status_code=204)


# --------------------------------------------------------------------------- schedule


@router.get("/schedule", response_model=Schedule)
def get_schedule(
    user_id: UserId,
    today: Today,
    service: Service,
    start: Annotated[date, Query(alias="from")],
    end: Annotated[date, Query(alias="to")],
):
    return service.get_schedule(user_id, today, start, end)


@router.patch("/sessions/{session_id}", response_model=PlannedSession)
def reschedule_session(
    session_id: UUID, body: RescheduleRequest, user_id: UserId, today: Today, service: Service
):
    return service.reschedule_session(user_id, today, str(session_id), body.date)


@router.delete("/sessions/{session_id}", response_model=RemoveResult)
def remove_session(session_id: UUID, user_id: UserId, today: Today, service: Service):
    return service.remove_session(user_id, today, str(session_id))


# --------------------------------------------------------------------------- today and logging


@router.get("/today", response_model=TodayView)
def get_today(user_id: UserId, today: Today, service: Service):
    return service.get_today(user_id, today)


@router.get("/summary", response_model=TrainingSummary)
def get_summary(user_id: UserId, today: Today, service: Service):
    """One call for the Home page: readiness, today's session, the week so far and what is next."""
    return service.get_summary(user_id, today)


@router.post("/coach", response_model=CoachMessage)
def post_coach(user_id: UserId, today: Today, service: Service):
    """
    A short note about today's training from Gemini, or a built-in message when it isn't available.
    Gemini is given the plan and the week's progress only: never readiness, check-in answers or Strava data.
    """
    return service.get_coach_message(user_id, today)


@router.put("/sleep", response_model=SleepEntry)
def put_sleep(body: SleepInput, user_id: UserId, today: Today, service: Service):
    """Last night's sleep, filed under the user's today. It feeds today's readiness score."""
    return service.log_sleep(user_id, today, body)


@router.delete("/sleep", status_code=204)
def delete_sleep(user_id: UserId, today: Today, service: Service):
    service.clear_sleep(user_id, today)
    return Response(status_code=204)


@router.post("/sessions/{session_id}/respond", response_model=PlannedSession)
def respond_to_session(
    session_id: UUID,
    body: SessionResponseRequest,
    user_id: UserId,
    today: Today,
    service: Service,
):
    return service.respond_to_session(user_id, today, str(session_id), body)


@router.post("/sessions/{session_id}/log", response_model=LogResult)
def log_session(
    session_id: UUID, body: LogWorkoutInput, user_id: UserId, today: Today, service: Service
):
    return service.log_session(user_id, today, str(session_id), body)


@router.post("/sessions", response_model=LogResult)
def log_ad_hoc_session(body: LogWorkoutInput, user_id: UserId, today: Today, service: Service):
    return service.log_ad_hoc_session(user_id, today, body)


# --------------------------------------------------------------------------- readiness


@readiness_router.get("/model", response_model=ModelInfo)
def readiness_model(user_id: UserId, service: Service):
    """Which scorer is live, what it was trained on and how it did. Nothing here is per user."""
    return service.scorer_info()


@readiness_router.post("/score", response_model=ScoreResult)
def score_readiness(features: ReadinessFeatures, user_id: UserId, service: Service):
    """Features in, score, classification and contributing factors out. Stateless: nothing is stored."""
    return service.score_features(features)


# --------------------------------------------------------------------------- wiring


def _field_errors(error: RequestValidationError) -> Dict[str, str]:
    errors: Dict[str, str] = {}
    for item in error.errors():
        location = [str(part) for part in item["loc"] if part not in ("body", "query", "path")]
        key = ".".join(location) or "form"
        message = str(item["msg"]).removeprefix("Value error, ")
        errors.setdefault(key, message)
    return errors


async def _validation_error_handler(request: Request, exc: RequestValidationError):
    """Same `{code, message, fieldErrors}` shape as every other error from these routes."""
    if not request.url.path.startswith((TRAINING_PREFIX, READINESS_PREFIX)):
        return await request_validation_exception_handler(request, exc)
    return JSONResponse(
        status_code=422,
        content={
            "detail": {
                "code": "VALIDATION",
                "message": "Check the highlighted fields.",
                "fieldErrors": _field_errors(exc),
            }
        },
    )


def install(app: FastAPI) -> None:
    """Mount the training and readiness routes on the main app."""
    app.include_router(router)
    app.include_router(readiness_router)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
