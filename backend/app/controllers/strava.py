from typing import Optional
from fastapi import APIRouter, Depends, Header, Query, Request, HTTPException, status
from pydantic import BaseModel
from ..services import strava as strava_service
from ..commons.config import get_settings
from ..commons.auth.deps import get_current_user_id, get_supabase_admin

settings = get_settings()
router = APIRouter(prefix="/strava", tags=["Strava API"])

class StravaExchangeRequest(BaseModel):
    code: str


@router.post("/exchange")
async def exchange_token(
    payload: StravaExchangeRequest,
    user_id: str = Depends(get_current_user_id),
):
    """
    Exchanges Strava authorization code for tokens and saves them
    to the authenticated user's record in Supabase.
    """
    token_data = await strava_service.exchange_strava_token(payload.code)

    supabase = get_supabase_admin()
    update_res = (
        supabase.table("users")
        .update({
            "strava_access_token": token_data.access_token,
            "strava_refresh_token": token_data.refresh_token,
            "strava_expires_at": token_data.expires_at,
        })
        .eq("user_id", user_id)
        .execute()
    )

    if not update_res.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to persist Strava tokens to database",
        )

    return {"message": "Strava connected successfully"}


@router.post("/disconnect")
async def disconnect_strava(
    user_id: str = Depends(get_current_user_id),
):
    """Clears Strava tokens from the authenticated user's record."""
    supabase = get_supabase_admin()
    
    supabase.table("users").update({
        "strava_access_token": None,
        "strava_refresh_token": None,
        "strava_expires_at": None,
    }).eq("user_id", user_id).execute()

    return {"message": "Strava disconnected successfully"}

def get_strava_token(authorization: Optional[str] = Header(None)) -> str:
    """Extracts the forwarded Strava Access Token provided by the Next.js frontend."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Bearer token")
    return authorization.split(" ")[1]

@router.get("/athlete")
async def get_athlete(authorization: Optional[str] = Header(None)):
    token = await check_valid_strava_token(user_id)
    return await strava_service.fetch_strava_athlete(token)

@router.get("/activities")
async def get_activities(
    page: int = Query(1, ge=1), 
    per_page: int = Query(10, ge=1, le=50),
    user_id: str = Depends(get_current_user_id),
):
    token = await check_valid_strava_token(user_id)
    return await strava_service.fetch_strava_activities(token, page, per_page)