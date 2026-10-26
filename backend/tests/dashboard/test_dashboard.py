from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.commons.auth.deps import get_current_user_id
from app.controllers import checkin as checkin_controller
from app.controllers import nutrition as nutrition_controller
from app.main import app
from app.services import nutrition
from app.training.router import get_service


client = TestClient(app)
USER_ID = "dashboard-test-user"


@pytest.fixture(autouse=True)
def authenticated_dashboard_user():
    app.dependency_overrides[get_current_user_id] = lambda: USER_ID
    yield
    app.dependency_overrides.clear()


class CheckInQuery:
    def select(self, fields):
        return self

    def eq(self, field, value):
        assert field == "user_id"
        assert value == USER_ID
        return self

    def order(self, field):
        assert field == "date"
        return self

    def execute(self):
        return SimpleNamespace(
            data=[{"date": "2026-10-24"}, {"date": "2026-10-25"}]
        )


class CheckInSupabase:
    def table(self, name):
        assert name == "daily_checkins"
        return CheckInQuery()


def test_dashboard_check_in_dates(monkeypatch):
    monkeypatch.setattr(checkin_controller, "get_supabase_admin", CheckInSupabase)

    response = client.get("/checkin/me/dates")

    assert response.status_code == 200
    assert response.json() == {
        "user_id": USER_ID,
        "dates": ["2026-10-24", "2026-10-25"],
    }


def test_dashboard_nutrition_daily(monkeypatch):
    expected = {
        "date": "2026-10-26",
        "total_calories": 650,
        "meals": [],
    }

    def fake_daily_log(db, user_id, day, offset_minutes):
        assert user_id == USER_ID
        assert day == date(2026, 10, 26)
        assert offset_minutes == 480
        return expected

    monkeypatch.setattr(nutrition, "daily_log", fake_daily_log)
    monkeypatch.setattr(
        nutrition_controller, "get_supabase_admin", lambda: object()
    )

    response = client.get(
        "/api/nutrition/daily?day=2026-10-26&offset_minutes=480"
    )

    assert response.status_code == 200
    assert response.json() == expected


class DashboardTrainingService:
    def get_summary(self, user_id, today):
        assert user_id == USER_ID
        return {
            "date": today.isoformat(),
            "hasPlan": False,
            "goal": None,
            "readiness": {
                "score": 80,
                "classification": "light",
                "factors": [],
                "explanation": "Ready for an easy session.",
                "date": today.isoformat(),
                "computedAt": "2026-10-26T08:00:00Z",
            },
            "today": {"state": "rest_day"},
            "week": {
                "start": today.isoformat(),
                "end": today.isoformat(),
                "plannedSessions": 0,
                "completedSessions": 0,
                "missedSessions": 0,
                "loggedMinutes": 0,
            },
            "nextSession": None,
        }


def test_dashboard_training_summary():
    app.dependency_overrides[get_service] = DashboardTrainingService

    response = client.get(
        "/api/v1/training/summary",
        headers={"X-Client-Date": "2026-10-26"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-10-26"
    assert body["today"]["state"] == "rest_day"
    assert body["readiness"]["score"] == 80
