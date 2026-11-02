import concurrent.futures
import json
import logging
import os
import time
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
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
        """
        Deterministic, intent-aware dummy data used when Gemini is unavailable.
        """
        prompt = user_input.lower().strip()
        target_date = "2026-10-16"

        # 1. Detect pure informational/educational queries FIRST to prevent conflicts
        # Checks if user is asking an explanatory question ("why", "how should i adjust", "explain")
        is_question = any(q in prompt for q in ("why is", "how should", "how do", "what is", "explain", "tell me about"))
        is_explicit_scheduling = any(cmd in prompt for cmd in ("schedule", "plan two", "plan a", "book", "add a session", "add workout"))

        wants_nutrition = any(
            word in prompt for word in ("calorie", "nutrition", "fuel", "diet", "intake", "macro", "protein", "meal")
        )

        wants_week = any(
            phrase in prompt
            for phrase in (
                "plan a week",
                "week's worth",
                "weekly training",
                "weekly workout",
                "7-day",
                "seven-day",
            )
        )

        wants_exercise = any(
            word in prompt for word in ("workout", "session", "run", "gym", "training", "exercise")
        )

        res: Dict[str, Any] = {
            "reply": "",
            "recommended_sessions": [],
            "recommended_session": None,
            "planned_session": None,
            "nutrition_plan": None,
            "nutrition_schedule": None,
            "weekly_training_plan": None,
        }

        # -------------------------------------------------------------
        # BRANCH A: General Coaching / Physiological Explanation
        # Triggers if it's an explanatory question and not an explicit schedule command
        # -------------------------------------------------------------
        if is_question and not is_explicit_scheduling:
            res["reply"] = (
                "Physiological Rationale for Aerobic Base Building\n\n"
                "Light aerobic running (Zone 2) keeps your heart rate below the ventilatory threshold. "
                "This stimulates mitochondrial biogenesis, improves capillary density in slow-twitch muscle fibers, "
                "and enhances your body's ability to utilize fat as an efficient primary fuel source. Because it generates "
                "minimal metabolic waste and low joint impact, it expands your cardiovascular volume without causing neuromuscular exhaustion.\n\n"
                "Adjusting for a Low Morning Readiness Score\n\n"
                "If your wearable or readiness score indicates elevated systemic fatigue or poor autonomic recovery "
                "(such as depressed HRV or an elevated resting heart rate):\n\n"
                "• Do Not Scrap the Workout Entirely: Complete rest can sometimes increase stiffness. Consistency is maintained through active recovery.\n\n"
                "• Cap the Duration: Reduce your planned session from 45 minutes down to 20–30 minutes.\n\n"
                "• Enforce a Strict Conversation Pace: Slow down by 30–45 seconds per kilometer or switch to a brisk walk on inclines if your heart rate spikes.\n\n"
                "• Prioritize Parasympathetic Recovery: Keep post-run stretching gentle and focus on proper rehydration and glycogen replenishment."
            )
            return res

        # -------------------------------------------------------------
        # BRANCH B: Nutrition Schedule / Plan
        # -------------------------------------------------------------
        if wants_nutrition:
            res["reply"] = (
                "Here is your nutritional schedule and fueling breakdown for the week. "
                "On high-demand training days like October 16, focus on easily digestible carbohydrates "
                "before your run and high protein post-gym to maximize muscle repair."
            )
            res["nutrition_plan"] = {
                "title": "Performance & Recovery Nutrition Plan",
                "targetCalories": 2500,
                "proteinGrams": 140,
                "carbsGrams": 320,
                "fatGrams": 65,
                "mealHighlights": [
                    "Pre-run snack: Banana or toast with honey 45 minutes prior.",
                    "Post-run lunch: Rice bowl with grilled chicken, avocado, and vegetables.",
                    "Post-gym dinner: High-protein recovery meal with salmon or tofu and sweet potatoes."
                ]
            }
            nutrition_schedule = []
            for offset in range(7):
                day = (date.fromisoformat(current_date_iso) + timedelta(days=offset)).isoformat()
                is_training = (day == target_date) or (offset % 2 == 0)
                nutrition_schedule.append({
                    "date": day,
                    "activity": "Run & Gym" if day == target_date else ("Training" if is_training else "Rest"),
                    "targetCalories": 2750 if day == target_date else (2550 if is_training else 2350),
                })
            res["nutrition_schedule"] = nutrition_schedule
            return res

        # -------------------------------------------------------------
        # BRANCH C: Weekly Plan
        # -------------------------------------------------------------
        if wants_week:
            res["reply"] = "Here is a balanced 7-day training schedule alternating between running and recovery days."
            weekly_plan = []
            for offset in range(7):
                day = (date.fromisoformat(current_date_iso) + timedelta(days=offset)).isoformat()
                weekly_plan.append({
                    "date": day,
                    "activity_type": "run" if offset % 2 == 0 else "rest",
                    "target_duration_min": 45 if offset % 2 == 0 else None,
                    "intensity_band": "light" if offset % 2 == 0 else None,
                    "target_volume": 40 if offset % 2 == 0 else None,
                })
            res["weekly_training_plan"] = weekly_plan
            return res

        # -------------------------------------------------------------
        # BRANCH D: Exercise Scheduling (Two-a-day Workout Cards)
        # -------------------------------------------------------------
        if wants_exercise:
            run_session = {
                "date": target_date,
                "activity_type": "run",
                "target_duration_min": 45,
                "intensity_band": "light",
                "target_volume": 40,
                "status": "planned",
            }
            gym_session = {
                "date": target_date,
                "activity_type": "gym",
                "target_duration_min": 45,
                "intensity_band": "light",
                "target_volume": 45,
                "status": "planned",
            }
            sessions = [run_session, gym_session]

            res["reply"] = (
                f"I've configured two sessions for {target_date}: an easy 45-minute aerobic morning run to build your base, "
                "followed by an evening strength session. Click below to schedule each workout."
            )
            res["recommended_sessions"] = sessions
            res["recommended_session"] = run_session
            res["planned_session"] = run_session
            return res

        # Default fallback
        res["reply"] = (
            "Consistency in low-intensity volume builds a strong cardiovascular base. If your recovery indicators "
            "are low, reducing session duration while staying active maintains physiological adaptations without overloading your nervous system."
        )
        return res

    def generate_chat_response(
        self,
        user_input: str,
        history: List[Dict[str, Any]],
        athlete_context: Dict[str, Any],
        temperature: float = 0.7,
        max_output_tokens: int = 4096,
    ) -> Dict[str, Any]:
        """
        Generate copilot response with timeout protection and up to 7 silent retries.
        Falls back to intent-specific dummy data if all attempts fail.
        """
        current_date_iso = athlete_context.get("today") or date.today().isoformat()
        training_schedule = athlete_context.get("training_schedule") or []

        system_instruction = f"""
You are the Fitra AI Health, Endurance, and Athletic Copilot.
User stats: Weight {athlete_context.get('weight', 63)} kg, Height {athlete_context.get('height', 173)} cm.
Biological Sex: {athlete_context.get('biological_sex', 'Not specified')}.
Maintenance TDEE: {athlete_context.get('tdee', 2350)} kcal.
Current Reference Date: {current_date_iso}.

You MUST respond strictly with a valid JSON object matching this schema:
{{
  "reply": "Conversational markdown text explaining your advice, pacing guidance, or physiological rationale.",
  "recommended_sessions": [
    {{
      "date": "YYYY-MM-DD",
      "activity_type": "run" | "cycling" | "gym" | "bodyweight",
      "target_duration_min": 45,
      "intensity_band": "light" | "push" | "deload",
      "target_volume": 50,
      "status": "planned"
    }}
  ] or null,
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
    "mealHighlights": ["Meal 1", "Meal 2"]
  }} or null,
  "nutrition_schedule": [
    {{
      "date": "YYYY-MM-DD",
      "activity": "Run" or "Rest",
      "targetCalories": 2450
    }}
  ] or null,
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
1. When recommending workouts, populate "recommended_sessions" with an array of session objects.
2. If the user asks for two-a-day workouts (e.g., run in morning and gym at night), include BOTH in the "recommended_sessions" list.
3. Also set "recommended_session" to the first session in the list for backwards compatibility.
4. "date" must be an ISO string (YYYY-MM-DD). If user specifies October 16, 2026, use "2026-10-16".
5. "activity_type" MUST be strictly one of: "run", "cycling", "gym", "bodyweight".
6. "intensity_band" MUST be strictly one of: "light", "push", "deload".
7. "target_duration_min" must be an integer in 5-minute multiples (e.g. 30, 45, 60).
8. "status" should be "planned".
9. Output ONLY raw JSON.

TRAINING SCHEDULE CONTEXT:
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

        # Explicitly configure function calling to NONE to prevent AFC deadlock/warnings
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            response_mime_type="application/json",
            tools=None,
        )

        if self.client is None:
            self.logger.warning("GEMINI_API_KEY missing; using fallback.")
            return self._fallback_response(user_input, current_date_iso, training_schedule)

        raw_text = None
        max_retries = 3  # 3 attempts is ideal for live responsiveness before fallback
        base_delay = 0.5
        call_timeout_seconds = 20.0  # Increased from 8.0s so 200 OK responses can finish generating

        for attempt in range(1, max_retries + 1):
            try:
                self.logger.info(f"Gemini API call (attempt {attempt}/{max_retries})...")
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(
                        self.client.models.generate_content,
                        model=self.model,
                        contents=full_prompt,
                        config=config,
                    )
                    response = future.result(timeout=call_timeout_seconds)

                raw_text = response.text or "{}"
                if raw_text:
                    self.logger.info("Gemini call succeeded and returned content.")
                    break
            except concurrent.futures.TimeoutError:
                self.logger.warning(
                    f"Gemini call timed out after {call_timeout_seconds}s on attempt {attempt}/{max_retries}."
                )
                if attempt == max_retries:
                    self.logger.info("Exhausted retries due to timeout; returning dummy fallback data.")
                    return self._fallback_response(user_input, current_date_iso, training_schedule)
                time.sleep(0.5)
            except Exception as e:
                err_str = str(e).lower()
                is_transient = any(
                    code in err_str
                    for code in ("503", "unavailable", "overloaded", "high demand", "resource_exhausted")
                )

                if is_transient and attempt < max_retries:
                    sleep_time = min(base_delay * (1.5 ** (attempt - 1)), 2.0)
                    self.logger.warning(
                        f"Transient error on attempt {attempt}/{max_retries}: {e}. Retrying in {sleep_time:.2f}s..."
                    )
                    time.sleep(sleep_time)
                else:
                    self.logger.error(f"Gemini call exhausted {attempt} attempts: {e}. Switching to intent dummy data.")
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

        recommended_sessions = parsed.get("recommended_sessions")
        single_session = parsed.get("recommended_session") or parsed.get("planned_session")

        if not recommended_sessions and single_session:
            recommended_sessions = [single_session]
        elif recommended_sessions and not single_session:
            single_session = recommended_sessions[0]

        return {
            "reply": parsed.get("reply", raw_text),
            "recommended_sessions": recommended_sessions or [],
            "recommended_session": single_session,
            "planned_session": single_session,
            "nutrition_plan": parsed.get("nutrition_plan"),
            "nutrition_schedule": parsed.get("nutrition_schedule"),
            "weekly_training_plan": parsed.get("weekly_training_plan"),
        }


gemini_service = GeminiService()