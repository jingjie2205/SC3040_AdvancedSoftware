from typing import Optional
from fastapi import APIRouter, Header, Query, Request, HTTPException, status
from ..services import strava as strava_service
from ..commons.config import get_settings

settings = get_settings()
router = APIRouter(prefix="/strava", tags=["Strava API"])

def get_strava_token(authorization: Optional[str] = Header(None)) -> str:
    """Extracts the forwarded Strava Access Token provided by the Next.js frontend."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Bearer token")
    return authorization.split(" ")[1]


@router.post("/exchange")
async def exchange_token(code: str):
    return await strava_service.exchange_strava_token(code)

@router.get("/athlete")
async def get_athlete(authorization: Optional[str] = Header(None)):
    token = get_strava_token(authorization)
    return await strava_service.fetch_strava_athlete(token)

@router.get("/activities")
async def get_activities(
    page: int = Query(1, ge=1), 
    per_page: int = Query(10, ge=1, le=50), 
    authorization: Optional[str] = Header(None)
):
    token = get_strava_token(authorization)
    return await strava_service.fetch_strava_activities(token, page, per_page)

@router.post("/webhooks")
async def strava_webhook_event(request: Request):
    """Ingests inbound Strava webhook events."""
    payload = await request.json()
    return await strava_service.process_webhook_event(payload)