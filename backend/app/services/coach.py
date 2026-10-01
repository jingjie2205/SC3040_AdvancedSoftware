import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field
from .config import get_settings

logger = logging.getLogger(__name__)


class RecommendedWorkout(BaseModel):
    type: Literal["Rest", "Active Recovery", "Zone 2 Base", "Tempo", "Intervals", "Long Run/Ride"] = "Zone 2 Base"
    durationMinutes: int = 45
    targetHrZone: str = Field(
        default="Zone 2 (130 - 145 bpm)",
        description="Target heart rate zone range or threshold target",
    )
    description: str = "Aerobic base maintenance session."
    structuredWorkoutPlan: str = Field(
        default="10m Warmup -> 30m Zone 2 steady -> 5m Cool down",
        description="Step-by-step protocol for the workout",
    )


class RecommendationSchema(BaseModel):
    readinessScore: int = Field(default=85, ge=0, le=100, description="Readiness score out of 100")
    injuryRiskLevel: Literal["low", "moderate", "high", "critical"] = Field(
        default="low", description="Injury risk derived from ACWR & recent spikes"
    )
    recoveryStatus: Literal["fresh", "optimal", "fatigued", "overreaching"] = Field(
        default="optimal", description="Physiological fatigue state"
    )
    recommendedWorkout: RecommendedWorkout = Field(default_factory=RecommendedWorkout)
    coachingRationale: str = Field(
        default="ACWR is balanced within the optimal sweet spot (0.8 - 1.3).",
        description="Scientific explanation citing TRIMP and ACWR data",
    )
    keyInsights: List[str] = Field(
        default_factory=lambda: [
            "ACWR is in the peak adaptation sweet spot.",
            "Cardiovascular drift remained low on recent workouts.",
            "Hydration and 8 hours sleep advised.",
        ]
    )


def _get_mock_recommendation(
    acwr: float, acute_load: float, chronic_load: float
) -> RecommendationSchema:
    """Deterministic fallback for local evaluation without a live Gemini API key."""
    if acwr > 1.3:
        injury_risk = "high" if acwr > 1.5 else "moderate"
        recovery_status = "overreaching" if acwr > 1.5 else "fatigued"
        workout = RecommendedWorkout(
            type="Active Recovery",
            durationMinutes=30,
            targetHrZone="Zone 1 (< 125 bpm)",
            description="Active flush session to stimulate lymphatic drainage without adding cardiac stress.",
            structuredWorkoutPlan="10m light spin/walk -> 15m foam rolling and hip mobility -> 5m breathwork.",
        )
        rationale = (
            f"Your current ACWR is {acwr:.2f} (Acute: {acute_load:.1f}, Chronic: {chronic_load:.1f}), "
            "indicating that recent workload has accelerated faster than your chronic conditioning base. "
            "An active recovery session is prescribed to facilitate tissue repair."
        )
    else:
        injury_risk = "low"
        recovery_status = "optimal"
        workout = RecommendedWorkout(
            type="Zone 2 Base",
            durationMinutes=50,
            targetHrZone="Zone 2 (132 - 146 bpm)",
            description="Steady aerobic session targeting mitochondrial efficiency with minimal sympathetic strain.",
            structuredWorkoutPlan="10m Warmup building to 130 bpm -> 35m Steady Zone 2 cruise -> 5m Cool down.",
        )
        rationale = (
            f"Your ACWR of {acwr:.2f} sits comfortably in Gabbett's optimal adaptation corridor (0.8 - 1.3). "
            f"With chronic load at {chronic_load:.1f} and acute load at {acute_load:.1f}, today is suitable "
            "for steady aerobic endurance adaptation."
        )

    return RecommendationSchema(
        readinessScore=72 if acwr > 1.3 else 86,
        injuryRiskLevel=injury_risk,
        recoveryStatus=recovery_status,
        recommendedWorkout=workout,
        coachingRationale=rationale,
        keyInsights=[
            f"Current ACWR is {acwr:.2f} ({'Elevated risk' if acwr > 1.3 else 'Optimal sweet spot'}).",
            "7-day acute fatigue is aligned with cardiovascular tolerance.",
            "Maintain electrolyte intake and ensure target sleep duration.",
        ],
    )


async def synthesize_recommendation(
    user_id: str,
    athlete_profile: Optional[Dict[str, Any]] = None,
    recent_loads: Optional[List[Dict[str, Any]]] = None,
    recent_activities: Optional[List[Dict[str, Any]]] = None,
) -> RecommendationSchema:
    """
    Synthesizes an AI recovery and workout protocol using Google Gemini 2.5 Flash via `google-genai`.
    Falls back gracefully to scientific deterministic heuristics if API key is not configured.
    """
    settings = get_settings()

    # Determine current ACWR and load baseline
    latest_load = recent_loads[0] if recent_loads else {}
    acwr = float(latest_load.get("acwr", 1.05))
    acute_load = float(latest_load.get("acute_load_7d", 45.0))
    chronic_load = float(latest_load.get("chronic_load_28d", 43.0))

    if not settings.GOOGLE_GENERATIVE_AI_API_KEY:
        logger.info("GOOGLE_GENERATIVE_AI_API_KEY not found; using deterministic recommendation fallback.")
        return _get_mock_recommendation(acwr, acute_load, chronic_load)

    rest_hr = athlete_profile.get("rest_hr", 60) if athlete_profile else 60
    max_hr = athlete_profile.get("max_hr", 190) if athlete_profile else 190
    gender = athlete_profile.get("gender", "male") if athlete_profile else "male"

    prompt = f"""
You are an elite sports scientist and Olympic endurance coach. Analyze the following athlete data to prescribe today's training and recovery protocol:

Athlete Profile:
- Rest HR: {rest_hr} bpm
- Max HR: {max_hr} bpm
- Gender: {gender}

Training Load Metrics:
- Current ACWR (Acute:Chronic Workload Ratio): {acwr:.2f}
- 7-Day Acute Training Load (Fatigue): {acute_load:.1f} TRIMP
- 28-Day Chronic Training Load (Fitness): {chronic_load:.1f} TRIMP

Recent Activities:
{json.dumps(recent_activities or [], indent=2, default=str)}

Prescribe a scientifically rigorous recommendation optimizing for adaptation while minimizing injury risk based on Gabbett's ACWR model and Banister's impulse-response framework.
"""

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=settings.GOOGLE_GENERATIVE_AI_API_KEY)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=RecommendationSchema,
            ),
        )

        if response.parsed:
            return response.parsed  # type: ignore

        if response.text:
            data = json.loads(response.text)
            return RecommendationSchema.model_validate(data)

        return _get_mock_recommendation(acwr, acute_load, chronic_load)
    except Exception as e:
        logger.error(f"Gemini 2.5 Flash call failed, falling back to heuristic: {e}")
        return _get_mock_recommendation(acwr, acute_load, chronic_load)
