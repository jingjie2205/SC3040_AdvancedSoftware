from unittest.mock import MagicMock, patch
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


def test_get_my_profile_returns_200_with_user_attributes():
    mock_supabase = MagicMock()
    mock_supabase.table().select().eq().maybe_single().execute.return_value = MagicMock(
        data={
            "user_id": MOCK_USER_ID,
            "email": "athlete@example.com",
            "name": "Alex Runner",
            "age": 25,
            "weight": 70.0,
            "height": 175.0,
            "biological_sex": "MALE",
            "activity_level": "MODERATELY_ACTIVE",
            "fitness_goal": "MAINTENANCE",
            "created_at": "2026-01-01T00:00:00Z",
            "strava_access_token": "mock_token",
        }
    )

    with patch("app.controllers.users.get_supabase_admin", return_value=mock_supabase):
        response = client.get("/users/me")
        assert response.status_code == 200
        payload = response.json()
        assert payload["email"] == "athlete@example.com"
        assert payload["isStravaConnected"] is True


def test_get_my_profile_returns_404_when_user_not_found():
    mock_supabase = MagicMock()
    mock_supabase.table().select().eq().maybe_single().execute.return_value = MagicMock(data=None)

    with patch("app.controllers.users.get_supabase_admin", return_value=mock_supabase):
        response = client.get("/users/me")
        assert response.status_code == 404
        assert response.json()["detail"] == "User profile not found"


def test_update_my_profile_returns_200_on_valid_payload():
    mock_supabase = MagicMock()
    mock_supabase.table().update().eq().execute.return_value = MagicMock(
        data=[
            {
                "user_id": MOCK_USER_ID,
                "email": "athlete@example.com",
                "age": 26,
                "weight": 72.0,
                "height": 175.0,
                "biological_sex": "MALE",
                "activity_level": "VERY_ACTIVE",
                "fitness_goal": "STRENGTH",
                "created_at": "2026-01-01T00:00:00Z",
                "strava_access_token": None,
            }
        ]
    )

    with patch("app.controllers.users.get_supabase_admin", return_value=mock_supabase):
        payload = {
            "age": 26,
            "weight": 72.0,
            "height": 175.0,
            "biologicalSex": "MALE",
            "activityLevel": "VERY_ACTIVE",
            "fitnessGoal": "STRENGTH",
        }
        response = client.put("/users/me", json=payload)
        assert response.status_code == 200
        assert response.json()["weight"] == 72.0


def test_update_my_profile_returns_400_on_empty_payload():
    mock_supabase = MagicMock()
    with patch("app.controllers.users.get_supabase_admin", return_value=mock_supabase):
        response = client.put("/users/me", json={})
        assert response.status_code == 400
        assert "No valid fields provided" in response.json()["detail"]


def test_update_my_profile_returns_400_when_database_update_fails():
    mock_supabase = MagicMock()
    mock_supabase.table().update().eq().execute.return_value = MagicMock(data=[])

    with patch("app.controllers.users.get_supabase_admin", return_value=mock_supabase):
        response = client.put("/users/me", json={"age": 27})
        assert response.status_code == 400
        assert "Failed to update profile" in response.json()["detail"]