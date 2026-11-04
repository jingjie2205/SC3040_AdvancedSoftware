from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.commons.auth.deps import get_current_user_id
from app.controllers.strava import router
from app.services import strava as strava_service


USER_ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user_id] = lambda: USER_ID
    with TestClient(app) as test_client:
        yield test_client


def test_exchange_strava_token_persists_tokens(client, monkeypatch):
    supabase = MagicMock()
    supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = (
        SimpleNamespace(data=[{"user_id": USER_ID}])
    )
    token_data = SimpleNamespace(
        access_token="access-token",
        refresh_token="refresh-token",
        expires_at=1_900_000_000,
    )
    exchange = AsyncMock(return_value=token_data)
    monkeypatch.setattr(strava_service, "exchange_strava_token", exchange)
    monkeypatch.setattr(
        "app.controllers.strava.get_supabase_admin", lambda: supabase
    )

    response = client.post("/strava/exchange", json={"code": "authorization-code"})

    assert response.status_code == 200
    assert response.json() == {"message": "Strava connected successfully"}
    exchange.assert_awaited_once_with("authorization-code")
    supabase.table.return_value.update.assert_called_once_with(
        {
            "strava_access_token": "access-token",
            "strava_refresh_token": "refresh-token",
            "strava_expires_at": 1_900_000_000,
        }
    )
    supabase.table.return_value.update.return_value.eq.assert_called_once_with(
        "user_id", USER_ID
    )


def test_exchange_strava_token_returns_500_when_persistence_fails(client, monkeypatch):
    supabase = MagicMock()
    supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = (
        SimpleNamespace(data=[])
    )
    monkeypatch.setattr(
        strava_service,
        "exchange_strava_token",
        AsyncMock(
            return_value=SimpleNamespace(
                access_token="access-token",
                refresh_token="refresh-token",
                expires_at=1_900_000_000,
            )
        ),
    )
    monkeypatch.setattr(
        "app.controllers.strava.get_supabase_admin", lambda: supabase
    )

    response = client.post("/strava/exchange", json={"code": "authorization-code"})

    assert response.status_code == 500
    assert response.json()["detail"] == "Failed to persist Strava tokens to database"


def test_disconnect_strava_clears_tokens(client, monkeypatch):
    supabase = MagicMock()
    supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = (
        SimpleNamespace(data=[{"user_id": USER_ID}])
    )
    monkeypatch.setattr(
        "app.controllers.strava.get_supabase_admin", lambda: supabase
    )

    response = client.post("/strava/disconnect")

    assert response.status_code == 200
    assert response.json() == {"message": "Strava disconnected successfully"}
    supabase.table.return_value.update.assert_called_once_with(
        {
            "strava_access_token": None,
            "strava_refresh_token": None,
            "strava_expires_at": None,
        }
    )
    supabase.table.return_value.update.return_value.eq.assert_called_once_with(
        "user_id", USER_ID
    )
