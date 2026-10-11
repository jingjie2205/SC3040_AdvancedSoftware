import logging
import os
import json
from datetime import date
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

from google import genai
from google.genai import types


class GeminiService:
    DEFAULT_MODEL = "gemini-2.5-flash"

    def __init__(self, api_key: Optional[str] = None, model: str = DEFAULT_MODEL):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("NEXT_PUBLIC_GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY environment variable is missing from .env.")

        self.client = genai.Client(api_key=self.api_key)
        self.model = model
        self.logger = logging.getLogger(__name__)

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
            return {
                "reply": "I encountered a brief connection issue contacting the AI core. Here is a recommended threshold run to get you on track.",
                "recommended_session": {
                    "date": current_date_iso,
                    "activity_type": "run",
                    "target_duration_min": 45,
                    "intensity_band": "push",
                    "target_volume": 45,
                    "status": "planned",
                },
                "planned_session": {
                    "date": current_date_iso,
                    "activity_type": "run",
                    "target_duration_min": 45,
                    "intensity_band": "push",
                    "target_volume": 45,
                    "status": "planned",
                },
                "nutrition_plan": None,
            }

        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError:
            clean = raw_text.strip().replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(clean)
            except Exception:
                return {
                    "reply": raw_text,
                    "recommended_session": None,
                    "planned_session": None,
                    "nutrition_plan": None,
                }

        if not isinstance(parsed, dict):
            return {
                "reply": raw_text,
                "recommended_session": None,
                "planned_session": None,
                "nutrition_plan": None,
            }

        session = parsed.get("recommended_session") or parsed.get("planned_session")

        return {
            "reply": parsed.get("reply", raw_text),
            "recommended_session": session,
            "planned_session": session,
            "nutrition_plan": parsed.get("nutrition_plan"),
        }


gemini_service = GeminiService()