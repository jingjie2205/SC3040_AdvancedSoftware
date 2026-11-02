from unittest.mock import MagicMock, patch
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient

from app.commons.auth.deps import get_current_user_id
from app.main import app

client = TestClient(app)
MOCK_USER_ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture(autouse=True)
def override_user_authentication():
    app.dependency_overrides[get_current_user_id] = lambda: MOCK_USER_ID
    yield
    app.dependency_overrides.clear()


def test_get_user_chat_sessions_returns_session_list():
    mock_supabase = MagicMock()
    session_id = str(uuid4())
    mock_supabase.table().select().eq().order().execute.return_value = MagicMock(
        data=[
            {
                "session_id": session_id,
                "user_id": MOCK_USER_ID,
                "started_at": "2026-10-16T10:00:00Z",
            }
        ]
    )

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        response = client.get("/chat/sessions")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["session_id"] == session_id


def test_create_chat_session_returns_201_with_new_session():
    mock_supabase = MagicMock()
    new_session_id = str(uuid4())
    mock_supabase.table().insert().execute.return_value = MagicMock(
        data=[
            {
                "session_id": new_session_id,
                "user_id": MOCK_USER_ID,
                "started_at": "2026-10-16T11:00:00Z",
            }
        ]
    )

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        response = client.post("/chat/sessions", json={})
        assert response.status_code == 201
        assert response.json()["session_id"] == new_session_id


def test_get_chat_history_returns_session_detail_and_messages():
    target_session_id = str(uuid4())
    mock_supabase = MagicMock()

    mock_supabase.table().select().eq().execute.return_value = MagicMock(
        data=[
            {
                "session_id": target_session_id,
                "user_id": MOCK_USER_ID,
                "started_at": "2026-10-16T10:00:00Z",
            }
        ]
    )
    mock_supabase.table().select().eq().order().execute.return_value = MagicMock(
        data=[
            {
                "message_id": "msg-1",
                "session_id": target_session_id,
                "sender": "AI",
                "content": "Pacing recommendations",
                "timestamp": "2026-10-16T10:01:00Z",
                "has_health_flag": False,
                "planned_session": [{"activity_type": "run", "target_duration_min": 45}],
            }
        ]
    )

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        response = client.get(f"/chat/sessions/{target_session_id}")
        assert response.status_code == 200
        payload = response.json()
        assert payload["session_id"] == target_session_id
        assert len(payload["messages"]) == 1
        assert payload["messages"][0]["sender"] == "assistant"


def test_delete_chat_session_returns_204_when_successful():
    target_session_id = str(uuid4())
    mock_supabase = MagicMock()
    mock_supabase.table().select().eq().eq().limit().execute.return_value = MagicMock(
        data=[{"session_id": target_session_id}]
    )

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        response = client.delete(f"/chat/sessions/{target_session_id}")
        assert response.status_code == 204


def test_delete_chat_session_returns_404_when_not_found():
    target_session_id = str(uuid4())
    mock_supabase = MagicMock()
    mock_supabase.table().select().eq().eq().limit().execute.return_value = MagicMock(data=[])

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        response = client.delete(f"/chat/sessions/{target_session_id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Chat session not found."


def test_send_chat_message_flags_health_warning_on_pain_keyword():
    target_session_id = str(uuid4())
    mock_supabase = MagicMock()

    mock_supabase.table().select().eq().execute.return_value = MagicMock(
        data=[{"session_id": target_session_id, "user_id": MOCK_USER_ID}]
    )
    mock_supabase.table().select().eq().order().limit().execute.return_value = MagicMock(data=[])
    mock_supabase.table().select().eq().limit().execute.return_value = MagicMock(
        data=[{"weight": 70, "height": 175, "biological_sex": "MALE"}]
    )
    mock_supabase.table().insert().select().execute.return_value = MagicMock(
        data=[{"message_id": "msg-persisted", "timestamp": "2026-10-16T12:00:00Z"}]
    )

    mock_ai_output = {
        "reply": "Please stop immediately and evaluate symptoms.",
        "recommended_sessions": [],
        "nutrition_plan": None,
        "nutrition_schedule": None,
        "weekly_training_plan": None,
    }

    with patch("app.controllers.chat.get_supabase_admin", return_value=mock_supabase):
        with patch("app.controllers.chat.gemini_service.generate_chat_response", return_value=mock_ai_output):
            payload = {
                "content": "I am experiencing sharp chest pain while running",
                "training_schedule": [],
            }
            response = client.post(f"/chat/sessions/{target_session_id}/send", json=payload)
            assert response.status_code == 201
            assert response.json()["has_health_flag"] is True