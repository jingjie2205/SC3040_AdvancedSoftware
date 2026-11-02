from typing import Any
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, status
from app.models.gamification import (
    Challenge,
    ChallengeCreate,
    ChallengeListResponse,
    ChallengeResponseCreate,
    DailyCheckInCreate,
    DailyCheckInResponse,
    GamificationStatsResponse,
    LeaderboardMetric,
    LeaderboardResponse,
    PendingXpResponse,
    PendingXpResyncResponse,
    XpHistoryResponse,
)
from app.commons.auth.deps import get_current_user_id, get_supabase_admin
from app.services import gamification as gamification_service

router = APIRouter(prefix="/gamification", tags=["Gamification"])


@router.get("/me", response_model=GamificationStatsResponse)
async def get_my_stats(user_id: str = Depends(get_current_user_id)) -> Any:
    """XP, streak and rank for the current user (zeros if they have never earned XP)."""
    return gamification_service.get_stats(
        get_supabase_admin(), user_id, gamification_service.today_local()
    )


@router.get("/xp-events", response_model=XpHistoryResponse)
async def get_my_xp_history(user_id: str = Depends(get_current_user_id)) -> Any:
    """The user's most recent XP awards, newest first."""
    return {"events": gamification_service.get_xp_history(get_supabase_admin(), user_id)}


@router.get("/pending-xp", response_model=PendingXpResponse)
async def get_my_pending_xp(user_id: str = Depends(get_current_user_id)) -> Any:
    """XP held back because a workout or meal failed a check, with the reason for each."""
    return gamification_service.get_pending_xp(get_supabase_admin(), user_id)


@router.post("/pending-xp/resync", response_model=PendingXpResyncResponse)
async def resync_my_pending_xp(user_id: str = Depends(get_current_user_id)) -> Any:
    """Check held XP again and pay whatever now passes."""
    return gamification_service.resync_pending_xp(get_supabase_admin(), user_id)


@router.post("/checkins", response_model=DailyCheckInResponse, status_code=status.HTTP_201_CREATED)
async def create_checkin(
    body: DailyCheckInCreate,
    user_id: str = Depends(get_current_user_id),
) -> Any:
    """Submit today's check-in questionnaire. Returns 409 if already checked in today."""
    try:
        return gamification_service.perform_checkin(
            get_supabase_admin(), user_id, body.model_dump(), gamification_service.today_local()
        )
    except gamification_service.AlreadyCheckedInError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You have already checked in today",
        )


@router.get("/leaderboard", response_model=LeaderboardResponse)
async def get_leaderboard(
    metric: LeaderboardMetric = LeaderboardMetric.XP,
    limit: int = Query(10, ge=1, le=50),
    user_id: str = Depends(get_current_user_id),
) -> Any:
    """The user and their friends, ranked by XP or by current check-in streak."""
    board = gamification_service.get_leaderboard(
        get_supabase_admin(), user_id, metric, limit, gamification_service.today_local()
    )
    return {"metric": metric, **board}


@router.get("/challenges", response_model=ChallengeListResponse)
async def list_challenges(user_id: str = Depends(get_current_user_id)) -> Any:
    """Challenges the user created, joined or is invited to, with each participant's progress."""
    challenges = gamification_service.list_challenges(
        get_supabase_admin(), user_id, gamification_service.today_local()
    )
    return {"challenges": challenges}


@router.post("/challenges", response_model=Challenge, status_code=status.HTTP_201_CREATED)
async def create_challenge(
    body: ChallengeCreate,
    user_id: str = Depends(get_current_user_id),
) -> Any:
    try:
        return gamification_service.create_challenge(
            get_supabase_admin(), user_id, body.model_dump(), gamification_service.today_local()
        )
    except gamification_service.InvalidChallengeError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/challenges/{challenge_id}/respond", response_model=Challenge)
async def respond_to_challenge(
    challenge_id: UUID,
    body: ChallengeResponseCreate,
    user_id: str = Depends(get_current_user_id),
) -> Any:
    """Accept or decline an invitation. 404 if not invited, 409 if already answered or ended."""
    try:
        return gamification_service.respond_to_challenge(
            get_supabase_admin(),
            user_id,
            str(challenge_id),
            body.accept,
            gamification_service.today_local(),
        )
    except gamification_service.ChallengeNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Challenge not found")
    except gamification_service.ChallengeConflictError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
