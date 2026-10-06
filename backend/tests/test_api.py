import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "fitra-ai-backend"


def test_strava_webhook_challenge_success():
    response = client.get(
        "/api/v1/webhooks/strava",
        params={
            "hub.mode": "subscribe",
            "hub.challenge": "challenge_token_xyz",
            "hub.verify_token": "fitra_strava_verify_token",
        },
    )
    assert response.status_code == 200
    assert response.json() == {"hub.challenge": "challenge_token_xyz"}


def test_strava_webhook_challenge_invalid_token():
    response = client.get(
        "/api/v1/webhooks/strava",
        params={
            "hub.mode": "subscribe",
            "hub.challenge": "challenge_token_xyz",
            "hub.verify_token": "wrong_token",
        },
    )
    assert response.status_code == 403


def test_analytics_acwr():
    response = client.get("/api/v1/analytics/acwr")
    assert response.status_code == 200
    data = response.json()
    assert "history" in data
    assert "currentAcwr" in data
    assert "acuteLoad7d" in data
    assert "chronicLoad28d" in data
    assert len(data["history"]) == 28


def test_recommendation_generation():
    response = client.post(
        "/api/v1/recommendations/generate",
        json={"userId": "00000000-0000-0000-0000-000000000001"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "readinessScore" in data
    assert "recommendedWorkout" in data
    assert "coachingRationale" in data
