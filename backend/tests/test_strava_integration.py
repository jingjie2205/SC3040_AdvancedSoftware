import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")

from app.commons.auth.deps import get_current_user_id
from app.controllers.strava import router
from app.services import strava

USER_ID = "00000000-0000-0000-0000-000000000001"


@pytest.mark.parametrize("route", ["/strava/athlete", "/strava/activities"])
def test_strava_reads_require_authentication(route):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        assert client.get(route).status_code in {401, 403}


@pytest.mark.parametrize(
    "route,method,args",
    [
        ("/strava/athlete", "fetch_strava_athlete", ("stored-token",)),
        (
            "/strava/activities?page=2&per_page=5",
            "fetch_strava_activities",
            ("stored-token", 2, 5),
        ),
    ],
)
def test_strava_reads_use_authenticated_users_token(monkeypatch, route, method, args):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user_id] = lambda: USER_ID
    lookup = AsyncMock(return_value="stored-token")
    fetch = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(strava, "check_valid_strava_token", lookup)
    monkeypatch.setattr(strava, method, fetch)
    with TestClient(app) as client:
        assert client.get(route).status_code == 200
    lookup.assert_awaited_once_with(USER_ID)
    fetch.assert_awaited_once_with(*args)


@pytest.mark.asyncio
@pytest.mark.parametrize("expired", [False, True])
async def test_token_lookup_and_refresh(monkeypatch, expired):
    db = MagicMock()
    query = db.table.return_value
    query.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = SimpleNamespace(
        data={
            "strava_access_token": "old-token",
            "strava_refresh_token": "refresh-token",
            "strava_expires_at": 1100 if expired else 2000,
        }
    )
    monkeypatch.setattr(strava, "get_supabase_admin", lambda: db)
    monkeypatch.setattr(strava.time, "time", lambda: 1000)
    refresh = AsyncMock(
        return_value=strava.StravaTokenResponse(
            access_token="new-token", refresh_token="new-refresh", expires_at=9000
        )
    )
    monkeypatch.setattr(strava, "refresh_strava_token", refresh)
    result = await strava.check_valid_strava_token(USER_ID)
    assert query.select.call_count == 1
    assert ",".join(query.select.call_args.args) == (
        "strava_access_token,strava_refresh_token,strava_expires_at"
    )
    query.select.return_value.eq.assert_called_once_with("user_id", USER_ID)
    if expired:
        assert result == "new-token"
        refresh.assert_awaited_once_with("refresh-token")
        query.update.assert_called_once_with(
            {
                "strava_access_token": "new-token",
                "strava_refresh_token": "new-refresh",
                "strava_expires_at": 9000,
            }
        )
        query.update.return_value.eq.assert_called_once_with("user_id", USER_ID)
    else:
        assert result == "old-token"
        refresh.assert_not_awaited()
        query.update.assert_not_called()


@pytest.mark.asyncio
async def test_disconnected_user_gets_clear_error(monkeypatch):
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = SimpleNamespace(
        data=None
    )
    monkeypatch.setattr(strava, "get_supabase_admin", lambda: db)
    with pytest.raises(HTTPException) as error:
        await strava.check_valid_strava_token(USER_ID)
    assert error.value.status_code == 400
