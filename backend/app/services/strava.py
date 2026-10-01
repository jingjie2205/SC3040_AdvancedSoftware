import time
from typing import Any, Dict, List, Optional
import httpx
from pydantic import BaseModel
from ..commons.config import get_settings
from fastapi import HTTPException, status


class StravaTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_at: int
    athlete: Optional[Dict[str, Any]] = None


class StravaActivity(BaseModel):
    id: int
    name: str
    type: str
    start_date: str
    start_date_local: Optional[str] = None
    elapsed_time: int
    moving_time: int
    distance: float
    total_elevation_gain: float
    average_heartrate: Optional[float] = None
    max_heartrate: Optional[float] = None
    average_speed: Optional[float] = None
    gear_id: Optional[str] = None


class StravaGear(BaseModel):
    id: str
    name: str
    distance: float


async def exchange_strava_token(code: str) -> StravaTokenResponse:
    settings = get_settings()

    if not settings.STRAVA_CLIENT_ID or not settings.STRAVA_CLIENT_SECRET or code.startswith("mock_"):
        return StravaTokenResponse(
            access_token=f"mock_strava_access_token_{int(time.time())}",
            refresh_token="mock_strava_refresh_token",
            expires_at=int(time.time()) + 21600,
            athlete={
                "id": 99999999,
                "firstname": "Alex",
                "lastname": "Endurance",
                "sex": "M",
                "weight": 70.0,
            },
        )

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://www.strava.com/oauth/token",
            data={
                "client_id": settings.STRAVA_CLIENT_ID,
                "client_secret": settings.STRAVA_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return StravaTokenResponse(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=data["expires_at"],
            athlete=data.get("athlete"),
        )


async def refresh_strava_token(refresh_token: str) -> StravaTokenResponse:
    settings = get_settings()

    if not settings.STRAVA_CLIENT_ID or not settings.STRAVA_CLIENT_SECRET or refresh_token.startswith("mock_"):
        return StravaTokenResponse(
            access_token=f"mock_strava_refreshed_token_{int(time.time())}",
            refresh_token=refresh_token,
            expires_at=int(time.time()) + 21600,
        )

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://www.strava.com/oauth/token",
            data={
                "client_id": settings.STRAVA_CLIENT_ID,
                "client_secret": settings.STRAVA_CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return StravaTokenResponse(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=data["expires_at"],
        )

async def check_valid_strava_token(user_id: str) -> str:
    supabase = get_supabase_admin()
    
    # Fetch current tokens from database
    res = (
        supabase.table("users")
        .select(
            "strava_access_token", 
            "strava_refresh_token", 
            "strava_expires_at"
        )
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    
    if not res.data or not res.data.get("strava_access_token"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Strava account not connected",
        )
        
    access_token = res.data["strava_access_token"]
    refresh_token = res.data["strava_refresh_token"]
    expires_at = res.data.get("strava_expires_at") or 0

    # Check if expired (with a 5-minute safety buffer)
    current_time = int(time.time())
    if current_time >= (expires_at - 300):
        # Call Strava to refresh
        new_tokens = await refresh_strava_token(refresh_token)
        
        # Save refreshed tokens back to Supabase
        supabase.table("users").update({
            "strava_access_token": new_tokens.access_token,
            "strava_refresh_token": new_tokens.refresh_token,
            "strava_expires_at": new_tokens.expires_at,
        }).eq("user_id", user_id).execute()
        
        return new_tokens.access_token

    return access_token


async def fetch_strava_athlete(access_token: str) -> Dict[str, Any]:
    if access_token.startswith("mock_"):
        return {"id": 99999999, "firstname": "Alex", "weight": 70.0, "shoes": [{"id": "g123", "name": "Mock Shoes"}]}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            "https://www.strava.com/api/v3/athlete",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return resp.json()


async def fetch_strava_athlete_stats(access_token: str, athlete_id: int) -> Dict[str, Any]:
    if access_token.startswith("mock_"):
        return {"all_run_totals": {"distance": 500000, "count": 100}, "all_ride_totals": {"distance": 1000000, "count": 50}}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"https://www.strava.com/api/v3/athletes/{athlete_id}/stats",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return resp.json()


async def fetch_strava_activities(access_token: str, page: int = 1, per_page: int = 10) -> List[StravaActivity]:
    if access_token.startswith("mock_"):
        return [
            StravaActivity(
                id=101, name="Mock Evening Run", type="Run", start_date=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                elapsed_time=3600, moving_time=3500, distance=12000.0, total_elevation_gain=150.0
            )
        ]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            "https://www.strava.com/api/v3/athlete/activities",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"page": page, "per_page": per_page},
        )
        resp.raise_for_status()
        return [StravaActivity(**act) for act in resp.json()]


async def fetch_strava_activity(access_token: str, activity_id: int) -> StravaActivity:
    if access_token.startswith("mock_"):
        return StravaActivity(
            id=activity_id, name="Morning Threshold Run", type="Run", start_date=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            elapsed_time=2700, moving_time=2700, distance=10000.0, total_elevation_gain=120.0,
            average_heartrate=156.0, max_heartrate=178.0, gear_id="g123"
        )

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"https://www.strava.com/api/v3/activities/{activity_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return StravaActivity(**resp.json())


async def fetch_strava_activity_streams(
    access_token: str, activity_id: int, stream_types: Optional[List[str]] = None
) -> Dict[str, List[int]]:
    if stream_types is None:
        stream_types = ["time", "heartrate", "watts", "cadence"]

    if access_token.startswith("mock_"):
        duration, step = 2700, 5
        times = list(range(0, duration, step))
        hrs = [int(min(185, max(110, 125 + (i / len(times)) * 40 + (i % 7) * 2 - 5))) for i in range(len(times))]
        return {"time": times, "heartrate": hrs}

    keys = ",".join(stream_types)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"https://www.strava.com/api/v3/activities/{activity_id}/streams?keys={keys}&key_by_type=true",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
        result: Dict[str, List[int]] = {}
        for key in stream_types:
            if key in data and "data" in data[key]:
                result[key] = data[key]["data"]
        return result


async def fetch_strava_gear(access_token: str, gear_id: str) -> StravaGear:
    if access_token.startswith("mock_"):
        return StravaGear(id=gear_id, name="Mock Nike Shoes", distance=150000.0)
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"https://www.strava.com/api/v3/gear/{gear_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
        return StravaGear(id=data["id"], name=data["name"], distance=float(data["distance"]))