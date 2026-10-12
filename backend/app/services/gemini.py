import logging
import os
import json
from datetime import date, timedelta
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

from google import genai
from google.genai import types


class GeminiService:
    DEFAULT_MODEL = "gemini-3.8-flash"

    def __init__(self, api_key: Optional[str] = None, model: str = DEFAULT_MODEL):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("NEXT_PUBLIC_GEMINI_API_KEY")
        self.client = genai.Client(api_key=self.api_key) if self.api_key else None
        self.model = model
        self.logger = logging.getLogger(__name__)

    def _fallback_response(
        self,
        user_input: str,
        current_date_iso: str,
        training_schedule: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Return deterministic structured advice when Gemini is unavailable."""
        prompt = user_input.lower()
        wants_week = any(
            phrase in prompt
            for phrase in (
                "plan a week",
                "week's worth",
                "weekly training",
                "weekly workout",
                "7-day training",
                "seven-day training",
                "training plan",
            )
        )
        wants_nutrition = any(
            word in prompt for word in ("calorie", "nutrition", "fuel", "diet", "intake")
        )

        scheduled_by_date = {
            item.get("date"): item
            for item in training_schedule
            if item.get("date")
        }
        weekly_plan = []
        nutrition_schedule = []
        for offset in range(7):
            day = (date.fromisoformat(current_date_iso) + timedelta(days=offset)).isoformat()
            session = scheduled_by_date.get(day)
            activity = session.get("activityType", "rest") if session else "rest"
            duration = session.get("targetDurationMin") if session else None
            intensity = session.get("intensityBand") if session else None
            if activity == "rest":
                calories = 2350
            elif intensity == "push":
                calories = 2800
            elif intensity == "deload":
                calories = 2450
            else:
                calories = 2600
            weekly_plan.append({
                "date": day,
                "activity_type": activity,
                "target_duration_min": duration,
                "intensity_band": intensity,
                "target_volume": session.get("targetVolume") if session else None,
            })
            nutrition_schedule.append({
                "date": day,
                "activity": activity.capitalize(),
                "targetCalories": calories,
            })

        if wants_week:
            return {
                "reply": "Gemini is unavailable, so I created a baseline seven-day plan from your current schedule. You can review each session before adding it.",
                "recommended_session": None,
                "planned_session": None,
                "nutrition_plan": None,
                "nutrition_schedule": nutrition_schedule if wants_nutrition else None,
                "weekly_training_plan": weekly_plan,
            }
        if wants_nutrition:
            return {
                "reply": "Gemini is unavailable, so I created baseline calorie targets from your current training schedule.",
                "recommended_session": None,
                "planned_session": None,
                "nutrition_plan": None,
                "nutrition_schedule": nutrition_schedule,
                "weekly_training_plan": None,
            }
        return {
            "reply": "Gemini is temporarily unavailable. Please try again shortly.",
            "recommended_session": None,
            "planned_session": None,
            "nutrition_plan": None,
            "nutrition_schedule": None,
            "weekly_training_plan": None,
        }

    def generate_chat_response(
        self,
        user_input: str,
        history: List[Dict[str, Any]],
        athlete_context: Dict[str, Any],
        temperature: float = 0.7,
        max_output_tokens: int = 4096,
    ) -> Dict[str, Any]:
        """
        Generate copilot response and optionally extract structured planned session
        or nutrition plans.
        """
        current_date_iso = athlete_context.get("today") or date.today().isoformat()
        training_schedule = athlete_context.get("training_schedule") or []

        system_instruction = f"""
You are the Fitra AI Health, Endurance, and Athletic Copilot.
User stats: Weight {athlete_context.get('weight', 63)} kg, Height {athlete_context.get('height', 173)} cm.
Biological Sex: {athlete_context.get('biological_sex', 'Not specified')}.
Maintenance TDEE: {athlete_context.get('tdee', 2350)} kcal.
Current Reference Date: {current_date_iso}.

You MUST respond strictly with a valid JSON object matching the following structure:
{{
  "reply": "Conversational markdown text explaining your advice, pacing guidance, or physiological rationale.",
  "recommended_session": {{
    "date": "YYYY-MM-DD",
    "activity_type": "run" | "cycling" | "gym" | "bodyweight",
    "target_duration_min": 45,
    "intensity_band": "light" | "push" | "deload",
    "target_volume": 50,
    "status": "planned"
  }} or null,
  "nutrition_plan": {{
    "title": "Plan title",
    "targetCalories": 2450,
    "proteinGrams": 140,
    "carbsGrams": 320,
    "fatGrams": 65,
    "mealHighlights": [
      "Meal 1 summary",
      "Meal 2 summary"
    ]
  }} or null
  ,
  "nutrition_schedule": [
    {{
      "date": "YYYY-MM-DD",
      "activity": "Run" or "Rest",
      "targetCalories": 2450
    }}
  ] or null
  ,
  "weekly_training_plan": [
    {{
      "date": "YYYY-MM-DD",
      "activity_type": "run" | "cycling" | "gym" | "bodyweight" | "rest",
      "target_duration_min": 45 or null,
      "intensity_band": "light" | "push" | "deload" or null,
      "target_volume": 50 or null
    }}
  ] or null
}}

RULES FOR SESSIONS:
1. When recommending or scheduling a workout, populate "recommended_session". Otherwise set to null.
2. "date" must be an ISO string (YYYY-MM-DD) on or after {current_date_iso}.
3. "activity_type" MUST be strictly one of: "run", "cycling", "gym", "bodyweight".
4. "intensity_band" MUST be strictly one of: "light", "push", "deload".
5. "target_duration_min" must be an integer in 5-minute multiples (e.g. 30, 45, 60).
6. "target_volume" is an estimated numeric load or null.
7. "status" should be "planned".
8. Output ONLY the raw JSON object.

WEEKLY TRAINING RULES:
1. If the user asks to plan a week, weekly training, a week's worth of training, or a weekly workout schedule, populate "weekly_training_plan" with exactly seven days starting on {current_date_iso}; otherwise set it to null.
2. Use the supplied schedule as context, but produce a complete plan. Use "rest" for recovery days.
3. For "rest", target_duration_min, intensity_band, and target_volume must be null.
4. For training days, use only the listed activity and intensity values, and use a positive whole-number duration in 5-minute increments.

NUTRITION RULES:
1. If the user asks for calorie, nutrition, fueling, or dietary guidance based on training, populate "nutrition_schedule" with exactly seven days starting on {current_date_iso}; otherwise set it to null.
2. Use the supplied training schedule to identify each day's activity. Use "Rest" when no session is scheduled.
3. "targetCalories" must be a positive whole-number daily calorie target appropriate for the user's stats and that day's training load.
4. Keep "nutrition_plan" null unless the user asks for a general single nutrition plan; use "nutrition_schedule" for daily calorie targets.

TRAINING SCHEDULE FOR THE NEXT SEVEN DAYS:
{json.dumps(training_schedule, default=str)}
"""

        formatted_history = ""
        for msg in history[-10:]:
            sender = "User" if msg.get("sender") in ("USER", "user") else "Assistant"
            formatted_history += f"{sender}: {msg.get('content')}\n"

        full_prompt = f"""
Conversation History:
{formatted_history}
User: {user_input}
Response:
"""

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            response_mime_type="application/json",
            tools=[],  # Empty list explicitly disables automatic function calling
        )

        if self.client is None:
            self.logger.warning("GEMINI_API_KEY is missing; using structured fallback response.")
            return self._fallback_response(user_input, current_date_iso, training_schedule)

        try:
            self.logger.info("Executing Gemini generate_content call...")
            response = self.client.models.generate_content(
                model=self.model,
                contents=full_prompt,
                config=config,
            )
            raw_text = response.text or "{}"
        except Exception as e:
            self.logger.error(f"Gemini API request failed: {e}")
            return self._fallback_response(user_input, current_date_iso, training_schedule)

        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError:
            clean = raw_text.strip().replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(clean)
            except Exception:
                return self._fallback_response(user_input, current_date_iso, training_schedule)

        if not isinstance(parsed, dict):
            return self._fallback_response(user_input, current_date_iso, training_schedule)

        if not any(
            parsed.get(key)
            for key in (
                "reply",
                "recommended_session",
                "planned_session",
                "nutrition_plan",
                "nutrition_schedule",
                "weekly_training_plan",
            )
        ):
            return self._fallback_response(user_input, current_date_iso, training_schedule)

        session = parsed.get("recommended_session") or parsed.get("planned_session")
        fallback = self._fallback_response(
            user_input, current_date_iso, training_schedule
        )
        wants_week = any(
            phrase in user_input.lower()
            for phrase in (
                "plan a week",
                "week's worth",
                "weekly training",
                "weekly workout",
                "7-day training",
                "seven-day training",
                "training plan",
            )
        )
        wants_nutrition = any(
            word in user_input.lower()
            for word in ("calorie", "nutrition", "fuel", "diet", "intake")
        )

        return {
            "reply": parsed.get("reply", raw_text),
            "recommended_session": session,
            "planned_session": session,
            "nutrition_plan": parsed.get("nutrition_plan"),
            "nutrition_schedule": (
                parsed.get("nutrition_schedule")
                or (fallback["nutrition_schedule"] if wants_nutrition else None)
            ),
            "weekly_training_plan": (
                parsed.get("weekly_training_plan")
                or (fallback["weekly_training_plan"] if wants_week else None)
            ),
        }


gemini_service = GeminiService()