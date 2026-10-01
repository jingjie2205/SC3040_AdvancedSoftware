import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import redis.asyncio as redis
from supabase import Client, create_client
from .calculations import (
    AthleteParams,
    calculate_acwr,
    calculate_banister_trimp,
    calculate_hr_zones,
)
from .config import get_settings
from .strava import (
    fetch_strava_activity,
    fetch_strava_activity_streams,
    refresh_strava_token,
)

logger = logging.getLogger(__name__)


def get_supabase_admin() -> Optional[Client]:
    settings = get_settings()
    url = settings.effective_supabase_url
    key = settings.effective_supabase_key
    if not url or not key:
        return None
    try:
        return create_client(url, key)
    except Exception as e:
        logger.warning(f"Failed to initialize Supabase client: {e}")
        return None


async def get_redis_client() -> Optional[redis.Redis]:
    settings = get_settings()
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=1.0)
        await r.ping()
        return r
    except Exception:
        return None


async def enqueue_activity_job(activity_id: int, athlete_id: Optional[int] = None) -> bool:
    """Enqueues an activity processing task onto the Redis queue."""
    settings = get_settings()
    r = await get_redis_client()
    payload = {
        "activity_id": activity_id,
        "athlete_id": athlete_id,
        "enqueued_at": time.time(),
    }
    if r:
        try:
            await r.lpush(settings.REDIS_ACTIVITY_QUEUE, json.dumps(payload))
            await r.aclose()
            return True
        except Exception as e:
            logger.error(f"Failed to push job to Redis: {e}")
            await r.aclose()

    # Fallback to in-process execution if Redis is not connected
    logger.info("Redis unavailable; processing activity directly in background.")
    asyncio.create_task(process_activity_pipeline(activity_id, athlete_id))
    return True


async def process_activity_pipeline(activity_id: int, athlete_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Main background pipeline:
    1. Fetches Strava activity & streams.
    2. Vectorized TRIMP & HR zones calculation via NumPy.
    3. Persists activity to Supabase.
    4. Computes 28-day ACWR and updates daily training loads.
    """
    supabase = get_supabase_admin()
    user_id = "00000000-0000-0000-0000-000000000001"
    access_token = "mock_strava_access_token"
    athlete_params = AthleteParams(rest_hr=60, max_hr=190, gender="male")

    # If Supabase is available and athlete_id is known, query profile
    if supabase and athlete_id:
        try:
            resp = (
                supabase.table("athlete_profiles")
                .select("*")
                .eq("strava_athlete_id", athlete_id)
                .maybe_single()
                .execute()
            )
            profile = resp.data if resp else None
            if profile:
                user_id = profile.get("user_id", user_id)
                access_token = profile.get("strava_access_token", access_token)
                athlete_params = AthleteParams(
                    rest_hr=profile.get("rest_hr", 60),
                    max_hr=profile.get("max_hr", 190),
                    gender=profile.get("gender", "male"),
                )

                # Token rotation check
                expires_at = profile.get("strava_token_expires_at")
                if expires_at and expires_at <= int(time.time()) + 300:
                    ref_token = profile.get("strava_refresh_token")
                    if ref_token:
                        refreshed = await refresh_strava_token(ref_token)
                        access_token = refreshed.access_token
                        supabase.table("athlete_profiles").update(
                            {
                                "strava_access_token": refreshed.access_token,
                                "strava_refresh_token": refreshed.refresh_token,
                                "strava_token_expires_at": refreshed.expires_at,
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            }
                        ).eq("id", profile["id"]).execute()
        except Exception as e:
            logger.warning(f"Error querying athlete profile: {e}")

    # Fetch Strava activity metadata and second-by-second telemetry streams
    activity_meta = await fetch_strava_activity(access_token, activity_id)
    streams = await fetch_strava_activity_streams(access_token, activity_id, ["time", "heartrate"])

    time_stream = streams.get("time")
    hr_stream = streams.get("heartrate")

    # Vectorized physiological modeling
    trimp_score = calculate_banister_trimp(
        duration_seconds=activity_meta.moving_time,
        avg_hr=activity_meta.average_heartrate,
        athlete=athlete_params,
        time_stream=time_stream,
        hr_stream=hr_stream,
    )
    hr_zones = calculate_hr_zones(athlete_params.max_hr, time_stream, hr_stream)

    # Persist activity to Supabase
    if supabase:
        try:
            supabase.table("activities").upsert(
                {
                    "user_id": user_id,
                    "strava_activity_id": activity_meta.id,
                    "name": activity_meta.name,
                    "type": activity_meta.type,
                    "start_date": activity_meta.start_date,
                    "elapsed_time": activity_meta.elapsed_time,
                    "moving_time": activity_meta.moving_time,
                    "distance": activity_meta.distance,
                    "total_elevation_gain": activity_meta.total_elevation_gain,
                    "average_heartrate": activity_meta.average_heartrate,
                    "max_heartrate": activity_meta.max_heartrate,
                    "trimp_score": trimp_score,
                    "streams_summary": hr_zones.model_dump(),
                    "raw_streams": {"time": time_stream, "heartrate": hr_stream} if time_stream else None,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="strava_activity_id",
            ).execute()
        except Exception as e:
            logger.warning(f"Could not persist activity to Supabase: {e}")

    # Aggregate 28-day daily loads and compute ACWR
    activity_date = activity_meta.start_date.split("T")[0]
    daily_loads_map: Dict[str, float] = {}

    if supabase:
        try:
            loads_resp = (
                supabase.table("daily_training_loads")
                .select("date, daily_trimp")
                .eq("user_id", user_id)
                .order("date", desc=False)
                .limit(28)
                .execute()
            )
            for row in loads_resp.data or []:
                daily_loads_map[row["date"]] = float(row["daily_trimp"])
        except Exception as e:
            logger.warning(f"Error fetching past daily loads: {e}")

    # Add today's load to the map
    daily_loads_map[activity_date] = daily_loads_map.get(activity_date, 0.0) + trimp_score

    # Reconstruct continuous chronological 28-day window
    today = datetime.now(timezone.utc).date()
    continuous_28d: List[float] = []
    for offset in range(27, -1, -1):
        d_str = datetime.fromtimestamp(time.time() - offset * 86400, tz=timezone.utc).strftime("%Y-%m-%d")
        continuous_28d.append(daily_loads_map.get(d_str, 0.0))

    acwr_result = calculate_acwr(continuous_28d)

    if supabase:
        try:
            supabase.table("daily_training_loads").upsert(
                {
                    "user_id": user_id,
                    "date": activity_date,
                    "daily_trimp": daily_loads_map[activity_date],
                    "acute_load_7d": acwr_result.acute_load_7d,
                    "chronic_load_28d": acwr_result.chronic_load_28d,
                    "acwr": acwr_result.acwr,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="user_id,date",
            ).execute()
        except Exception as e:
            logger.warning(f"Could not update daily_training_loads in Supabase: {e}")

    return {
        "activity_id": activity_meta.id,
        "trimp_score": trimp_score,
        "acute_load_7d": acwr_result.acute_load_7d,
        "chronic_load_28d": acwr_result.chronic_load_28d,
        "acwr": acwr_result.acwr,
        "status": acwr_result.status,
    }


async def run_worker_loop(stop_event: asyncio.Event) -> None:
    """Continuous worker loop consuming jobs from the Redis queue."""
    settings = get_settings()
    has_logged_status = False

    while not stop_event.is_set():
        r = await get_redis_client()
        if not r:
            if not has_logged_status:
                logger.info("Redis not detected at %s. Running in standalone in-memory mode for local dev.", settings.REDIS_URL)
                has_logged_status = True
            await asyncio.sleep(15)
            continue

        if has_logged_status:
            logger.info("Connected to Redis at %s. Worker queue active.", settings.REDIS_URL)
            has_logged_status = False

        try:
            item = await r.brpop(settings.REDIS_ACTIVITY_QUEUE, timeout=2)
            if item:
                _, raw_data = item
                task = json.loads(raw_data)
                logger.info(f"Worker popped activity job: {task.get('activity_id')}")
                await process_activity_pipeline(
                    activity_id=task["activity_id"],
                    athlete_id=task.get("athlete_id"),
                )
        except Exception as e:
            logger.error(f"Worker loop encountered an error: {e}")
            await asyncio.sleep(1)
        finally:
            await r.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    stop = asyncio.Event()
    try:
        asyncio.run(run_worker_loop(stop))
    except KeyboardInterrupt:
        stop.set()
