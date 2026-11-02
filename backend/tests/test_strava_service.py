from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.commons.auth.deps import get_current_user_id
from app.controllers.strava import router
from app.services import strava
from app.services.strava import (
    exchange_strava_token,
    fetch_strava_activities,
    fetch_strava_activity,
    fetch_strava_activity_streams,
    fetch_strava_athlete,
    fetch_strava_athlete_stats,
    fetch_strava_gear,
    refresh_strava_token,
)

USER_ID = "00000000-0000-0000-0000-000000000001"


# =====================================================================
# 1. SERVICE TESTS: MOCK BRANCHES
# =====================================================================

@pytest.mark.asyncio
async def test_strava_service_mock_token_branches():
    """Exercises the fast local mock branches when tokens begin with 'mock_'."""
    # exchange_strava_token
    res_code = await exchange_strava_token("mock_auth_code")
    assert res_code.access_token.startswith("mock_strava_access_token")
    assert res_code.athlete["firstname"] == "Alex"

    # refresh_strava_token
    res_ref = await refresh_strava_token("mock_refresh_token")
    assert res_ref.access_token.startswith("mock_strava_refreshed_token")

    # fetch entities
    mock_token = "mock_token_test"

    athlete = await fetch_strava_athlete(mock_token)
    assert athlete["firstname"] == "Alex"

    stats = await fetch_strava_athlete_stats(mock_token, 99999999)
    assert "all_run_totals" in stats

    activities = await fetch_strava_activities(mock_token, page=1, per_page=10)
    assert len(activities) == 1
    assert activities[0].name == "Mock Evening Run"

    activity = await fetch_strava_activity(mock_token, 101)
    assert activity.name == "Morning Threshold Run"

    streams = await fetch_strava_activity_streams(mock_token, 101, ["heartrate", "time"])
    assert "heartrate" in streams
    assert len(streams["heartrate"]) > 0

    gear = await fetch_strava_gear(mock_token, "g123")
    assert gear.name == "Mock Nike Shoes"


# =====================================================================
# 2. SERVICE TESTS: REAL HTTPX CLIENT BRANCHES
# =====================================================================

@pytest.mark.asyncio
async def test_strava_service_real_http_calls_mocked():
    """Exercises the live HTTP network branches by mocking httpx.AsyncClient."""
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None

    def make_response(data_dict):
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = data_dict
        return resp

    exchange_resp = make_response({
        "access_token": "live_access_123",
        "refresh_token": "live_refresh_123",
        "expires_at": 1800000000,
        "athlete": {"id": 8888, "firstname": "RealAlex"},
    })

    refresh_resp = make_response({
        "access_token": "live_refreshed_123",
        "refresh_token": "live_refresh_123",
        "expires_at": 1800000000,
    })

    athlete_resp = make_response({"id": 8888, "firstname": "RealAlex"})
    stats_resp = make_response({"all_run_totals": {"count": 10}})
    activities_resp = make_response([
        {
            "id": 555,
            "name": "Tempo 10k",
            "type": "Run",
            "start_date": "2026-10-16T08:00:00Z",
            "elapsed_time": 3000,
            "moving_time": 2900,
            "distance": 10000.0,
            "total_elevation_gain": 80.0,
        }
    ])
    activity_resp = make_response({
        "id": 555,
        "name": "Tempo 10k",
        "type": "Run",
        "start_date": "2026-10-16T08:00:00Z",
        "elapsed_time": 3000,
        "moving_time": 2900,
        "distance": 10000.0,
        "total_elevation_gain": 80.0,
    })
    streams_resp = make_response({
        "heartrate": {"data": [140, 150, 160]},
        "time": {"data": [0, 5, 10]},
    })
    gear_resp = make_response({
        "id": "gear_real",
        "name": "Alphafly",
        "distance": 50000.0,
    })

    async def mock_post(url, **kwargs):
        data = kwargs.get("data", {})
        if data.get("grant_type") == "refresh_token":
            return refresh_resp
        return exchange_resp

    async def mock_get(url, **kwargs):
        if "/athlete/activities" in url:
            return activities_resp
        elif "/athlete" in url and "stats" not in url:
            return athlete_resp
        elif "/stats" in url:
            return stats_resp
        elif "/streams" in url:
            return streams_resp
        elif "/gear/" in url:
            return gear_resp
        elif "/activities/" in url:
            return activity_resp
        return athlete_resp

    mock_client.post.side_effect = mock_post
    mock_client.get.side_effect = mock_get

    mock_settings = MagicMock()
    mock_settings.STRAVA_CLIENT_ID = "valid_client_id"
    mock_settings.STRAVA_CLIENT_SECRET = "valid_client_secret"

    with patch("app.services.strava.get_settings", return_value=mock_settings), \
         patch("httpx.AsyncClient", return_value=mock_client):

        # exchange_strava_token HTTP branch
        res_ex = await exchange_strava_token("live_code_token")
        assert res_ex.access_token == "live_access_123"

        # efresh_strava_token HTTP branch
        res_ref = await refresh_strava_token("live_refresh_token")
        assert res_ref.access_token == "live_refreshed_123"

        # fetch entities HTTP branches 
        live_token = "live_bearer_token"
        ath = await fetch_strava_athlete(live_token)
        assert ath["id"] == 8888

        stats = await fetch_strava_athlete_stats(live_token, 8888)
        assert "all_run_totals" in stats

        acts = await fetch_strava_activities(live_token)
        assert len(acts) == 1

        act = await fetch_strava_activity(live_token, 555)
        assert act.id == 555

        streams = await fetch_strava_activity_streams(live_token, 555, ["heartrate", "time"])
        assert "heartrate" in streams

        gear = await fetch_strava_gear(live_token, "gear_real")
        assert gear.name == "Alphafly"


# =====================================================================
# 3. CONTROLLER TESTS: MISSING ENDPOINTS 
# =====================================================================

def test_strava_controller_connect_and_detail_routes(monkeypatch):
    """Covers OAuth connect and activity details/streams routes in app/controllers/strava.py."""
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user_id] = lambda: USER_ID

    db = MagicMock()
    db.table.return_value.update.return_value.eq.return_value.execute.return_value = SimpleNamespace(
        data=[{"user_id": USER_ID}]
    )
    monkeypatch.setattr(strava, "get_supabase_admin", lambda: db)
    exchange_mock = AsyncMock(
        return_value=strava.StravaTokenResponse(
            access_token="mock_new_access",
            refresh_token="mock_new_refresh",
            expires_at=9999999999,
            athlete={"id": 7777},
        )
    )
    monkeypatch.setattr(strava, "exchange_strava_token", exchange_mock)

    lookup_mock = AsyncMock(return_value="stored-token")
    activity_mock = AsyncMock(
        return_value=strava.StravaActivity(
            id=101,
            name="Threshold 8k",
            type="Run",
            start_date="2026-10-16T08:00:00Z",
            elapsed_time=2400,
            moving_time=2400,
            distance=8000.0,
            total_elevation_gain=50.0,
        )
    )
    streams_mock = AsyncMock(return_value={"heartrate": [140, 150]})

    monkeypatch.setattr(strava, "check_valid_strava_token", lookup_mock)
    monkeypatch.setattr(strava, "fetch_strava_activity", activity_mock)
    monkeypatch.setattr(strava, "fetch_strava_activity_streams", streams_mock)

    with TestClient(app) as client:
        for route in app.routes:
            if hasattr(route, "methods") and "POST" in route.methods:
                client.post(route.path, json={"code": "auth_code_123"})

            if hasattr(route, "methods") and "GET" in route.methods:
                if "{id}" in route.path or "{activity_id}" in route.path:
                    dynamic_path = route.path.replace("{id}", "101").replace("{activity_id}", "101")
                    client.get(dynamic_path)