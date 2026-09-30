import asyncio
from contextlib import asynccontextmanager
import logging
from typing import Any, Dict, List, Optional
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import jwt
from pydantic import BaseModel
from .coach import RecommendationSchema, synthesize_recommendation
from .config import get_settings
from .training import install as install_training_routes
from .worker import enqueue_activity_job, get_supabase_admin, process_activity_pipeline, run_worker_loop

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("endurance.backend")

worker_stop_event = asyncio.Event()
worker_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: launch integrated Redis queue worker in background
    logger.info("Initializing Endurance AI Backend...")
    global worker_task, worker_stop_event
    worker_stop_event.clear()
    worker_task = asyncio.create_task(run_worker_loop(worker_stop_event))
    yield
    # Shutdown: gracefully stop the background worker
    logger.info("Shutting down background workers...")
    worker_stop_event.set()
    if worker_task:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass


settings = get_settings()
app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    description="Scientific Endurance Training Load & AI Recovery Backend",
    lifespan=lifespan,
)

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

install_training_routes(app)


def get_current_user_id(authorization: Optional[str] = Header(None)) -> str:
    """
    Extracts user_id from Supabase JWT if present; falls back to default demo athlete ID.
    """
    default_user = "00000000-0000-0000-0000-000000000001"
    if not authorization or not authorization.startswith("Bearer "):
        return default_user

    token = authorization.replace("Bearer ", "").strip()
    try:
        # Decode without verification if no secret is configured, or verify if configured
        if settings.SUPABASE_JWT_SECRET:
            payload = jwt.decode(
                token,
                settings.SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
            )
        else:
            payload = jwt.decode(token, options={"verify_signature": False})
        return payload.get("sub", default_user)
    except Exception as e:
        logger.debug(f"JWT parse notice: {e}")
        return default_user


class RecommendationRequest(BaseModel):
    userId: Optional[str] = None


class ActivityProcessRequest(BaseModel):
    activityId: int
    athleteId: Optional[int] = None


@app.get("/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "endurance-ai-backend",
        "environment": settings.ENVIRONMENT,
    }


# ============================================================================
# Strava Webhooks
# ============================================================================

@app.get("/api/v1/webhooks/strava", tags=["Strava"])
async def strava_webhook_challenge(
    hub_mode: str = Query(..., alias="hub.mode"),
    hub_challenge: str = Query(..., alias="hub.challenge"),
    hub_verify_token: str = Query(..., alias="hub.verify_token"),
):
    """
    Handles Strava's initial subscription verification handshake.
    """
    if hub_mode == "subscribe" and hub_verify_token == settings.STRAVA_VERIFY_TOKEN:
        logger.info("Strava subscription challenge verified.")
        return {"hub.challenge": hub_challenge}

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Invalid verification token or mode",
    )


@app.post("/api/v1/webhooks/strava", tags=["Strava"])
async def strava_webhook_event(request: Request):
    """
    Ingests inbound Strava webhook events and enqueues them onto Redis queue within 2s.
    """
    payload = await request.json()
    logger.info(f"Received Strava event: {payload}")

    object_type = payload.get("object_type")
    aspect_type = payload.get("aspect_type")
    activity_id = payload.get("object_id")
    athlete_id = payload.get("owner_id")

    if object_type == "activity" and aspect_type in ("create", "update") and activity_id:
        await enqueue_activity_job(activity_id=activity_id, athlete_id=athlete_id)

    # Return HTTP 200 immediately to satisfy Strava's strict 2000ms response window
    return {"status": "event_received"}


# ============================================================================
# Recovery & Coaching
# ============================================================================

@app.post("/api/v1/recommendations/generate", response_model=RecommendationSchema, tags=["Recovery"])
async def generate_recommendation_endpoint(
    body: RecommendationRequest,
    user_id: str = Depends(get_current_user_id),
):
    """
    Generates a daily AI recovery and workout protocol using Google Gemini 2.5 Flash.
    """
    effective_user_id = body.userId or user_id
    supabase = get_supabase_admin()

    athlete_profile = None
    recent_loads = []
    recent_activities = []

    if supabase:
        try:
            p_res = supabase.table("athlete_profiles").select("*").eq("user_id", effective_user_id).maybe_single().execute()
            athlete_profile = p_res.data if p_res else None

            l_res = (
                supabase.table("daily_training_loads")
                .select("date, daily_trimp, acute_load_7d, chronic_load_28d, acwr")
                .eq("user_id", effective_user_id)
                .order("date", desc=True)
                .limit(7)
                .execute()
            )
            recent_loads = l_res.data or []

            a_res = (
                supabase.table("activities")
                .select("name, type, start_date, moving_time, distance, average_heartrate, trimp_score")
                .eq("user_id", effective_user_id)
                .order("start_date", desc=True)
                .limit(5)
                .execute()
            )
            recent_activities = a_res.data or []
        except Exception as e:
            logger.warning(f"Error fetching data from Supabase for AI recommendation: {e}")

    recommendation = await synthesize_recommendation(
        user_id=effective_user_id,
        athlete_profile=athlete_profile,
        recent_loads=recent_loads,
        recent_activities=recent_activities,
    )

    # Persist recommendation to Supabase if available
    if supabase:
        try:
            supabase.table("ai_recommendations").insert(
                {
                    "user_id": effective_user_id,
                    "date": logging.Formatter().converter(None)[:10] if hasattr(logging, "Formatter") else "2026-09-03",
                    "readiness_score": recommendation.readinessScore,
                    "injury_risk_level": recommendation.injuryRiskLevel,
                    "recovery_status": recommendation.recoveryStatus,
                    "recommended_workout": recommendation.recommendedWorkout.model_dump(),
                    "coaching_rationale": recommendation.coachingRationale,
                    "raw_response": recommendation.model_dump(),
                }
            ).execute()
        except Exception as e:
            logger.warning(f"Could not persist recommendation to Supabase: {e}")

    return recommendation


# ============================================================================
# Analytics & Workload
# ============================================================================

@app.get("/api/v1/analytics/acwr", tags=["Analytics"])
async def get_acwr_analytics(
    user_id: str = Query("00000000-0000-0000-0000-000000000001", alias="userId"),
):
    """
    Returns rolling 28-day ACWR, acute fatigue, chronic fitness, and current risk status.
    """
    supabase = get_supabase_admin()
    history = []

    if supabase:
        try:
            resp = (
                supabase.table("daily_training_loads")
                .select("date, daily_trimp, acute_load_7d, chronic_load_28d, acwr")
                .eq("user_id", user_id)
                .order("date", desc=False)
                .limit(28)
                .execute()
            )
            if resp and resp.data:
                for idx, row in enumerate(resp.data):
                    history.append(
                        {
                            "day": f"Day {idx + 1}",
                            "date": row["date"],
                            "trimp": float(row["daily_trimp"]),
                            "acute": float(row["acute_load_7d"]),
                            "chronic": float(row["chronic_load_28d"]),
                            "acwr": float(row["acwr"]),
                        }
                    )
        except Exception as e:
            logger.warning(f"Error fetching ACWR analytics: {e}")

    if not history:
        # Provide representative initial 28-day dataset for evaluation
        base_loads = [45, 60, 0, 75, 50, 90, 0, 55, 70, 0, 65, 85, 110, 0, 50, 60, 0, 95, 40, 120, 0, 65, 80, 0, 70, 90, 105, 78]
        from .calculations import calculate_acwr
        for i in range(28):
            window = base_loads[: i + 1]
            res = calculate_acwr(window)
            history.append({
                "day": f"Day {i + 1}",
                "date": f"08-{i+5:02d}" if i < 27 else "Today",
                "trimp": base_loads[i],
                "acute": res.acute_load_7d,
                "chronic": res.chronic_load_28d,
                "acwr": res.acwr,
            })

    latest = history[-1]
    val = latest["acwr"]
    status_label = "sweet_spot"
    if val < 0.8:
        status_label = "undertraining"
    elif val > 1.5:
        status_label = "danger"
    elif val > 1.3:
        status_label = "overreaching"

    return {
        "history": history,
        "currentAcwr": latest["acwr"],
        "acuteLoad7d": latest["acute"],
        "chronicLoad28d": latest["chronic"],
        "status": status_label,
    }


@app.post("/api/v1/activities/process", tags=["Activities"])
async def trigger_process_activity(body: ActivityProcessRequest):
    """
    Direct synchronous activity ingestion trigger for testing and simulation.
    """
    result = await process_activity_pipeline(
        activity_id=body.activityId,
        athlete_id=body.athleteId,
    )
    return {
        "success": True,
        "activityId": result["activity_id"],
        "trimpScore": result["trimp_score"],
        "acuteLoad7d": result["acute_load_7d"],
        "chronicLoad28d": result["chronic_load_28d"],
        "acwr": result["acwr"],
        "status": result["status"],
    }
