import concurrent.futures
from unittest.mock import MagicMock, patch
import pytest

from app.services.gemini import GeminiService


def test_fallback_response_returns_educational_rationale_on_question_intent():
    service = GeminiService(api_key=None)
    response = service._fallback_response(
        user_input="Why is Zone 2 important for aerobic base?",
        current_date_iso="2026-10-16",
        training_schedule=[],
    )
    assert "Physiological Rationale" in response["reply"]
    assert response["recommended_sessions"] == []


def test_fallback_response_returns_nutrition_schedule_on_nutrition_intent():
    service = GeminiService(api_key=None)
    response = service._fallback_response(
        user_input="Plan my daily calorie and protein intake",
        current_date_iso="2026-10-16",
        training_schedule=[],
    )
    assert response["nutrition_plan"] is not None
    assert len(response["nutrition_schedule"]) == 7


def test_fallback_response_returns_weekly_plan_on_schedule_intent():
    service = GeminiService(api_key=None)
    response = service._fallback_response(
        user_input="Plan a week's worth of training",
        current_date_iso="2026-10-16",
        training_schedule=[],
    )
    assert len(response["weekly_training_plan"]) == 7


def test_fallback_response_returns_two_a_day_sessions_on_exercise_intent():
    service = GeminiService(api_key=None)
    response = service._fallback_response(
        user_input="Schedule a workout for tomorrow",
        current_date_iso="2026-10-16",
        training_schedule=[],
    )
    assert len(response["recommended_sessions"]) == 2
    assert response["recommended_session"]["activity_type"] == "run"
    assert response["planned_session"]["activity_type"] == "run"


def test_fallback_response_returns_default_guidance_on_general_input():
    service = GeminiService(api_key=None)
    response = service._fallback_response(
        user_input="Hello bot",
        current_date_iso="2026-10-16",
        training_schedule=[],
    )
    assert "Consistency in low-intensity" in response["reply"]


def test_generate_chat_response_invokes_fallback_when_client_is_none():
    service = GeminiService(api_key=None)
    service.client = None
    response = service.generate_chat_response(
        user_input="plan a workout",
        history=[
            {"sender": "USER", "content": "hi"},
            {"sender": "AI", "content": "hello"},
        ],
        athlete_context={"weight": 70, "height": 175, "today": "2026-10-16"},
    )
    assert response["reply"] != ""
    assert response["planned_session"] is not None


def test_generate_chat_response_parses_successful_model_output():
    service = GeminiService(api_key="mock_key")
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = (
        '{"reply": "Great run planned", "recommended_sessions": [{"date": "2026-10-16", '
        '"activity_type": "run", "target_duration_min": 45, "intensity_band": "light", '
        '"target_volume": 40, "status": "planned"}]}'
    )
    mock_client.models.generate_content.return_value = mock_response
    service.client = mock_client

    response = service.generate_chat_response(
        user_input="plan my run",
        history=[],
        athlete_context={},
    )
    assert response["reply"] == "Great run planned"
    assert len(response["recommended_sessions"]) == 1
    assert response["recommended_session"]["activity_type"] == "run"


def test_generate_chat_response_recovers_on_timeout_exhaustion():
    service = GeminiService(api_key="mock_key")
    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = concurrent.futures.TimeoutError()
    service.client = mock_client

    with patch("time.sleep", return_value=None):
        response = service.generate_chat_response(
            user_input="plan my run",
            history=[],
            athlete_context={},
        )
        assert response["recommended_sessions"] is not None


def test_generate_chat_response_strips_markdown_code_fences():
    service = GeminiService(api_key="mock_key")
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "```json\n{\"reply\": \"Cleaned JSON reply\", \"recommended_sessions\": []}\n```"
    mock_client.models.generate_content.return_value = mock_response
    service.client = mock_client

    response = service.generate_chat_response(
        user_input="hello",
        history=[],
        athlete_context={},
    )
    assert response["reply"] == "Cleaned JSON reply"