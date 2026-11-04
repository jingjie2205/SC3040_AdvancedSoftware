from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_check_reports_connected_database():
    supabase = MagicMock()

    with patch("app.commons.auth.deps.get_supabase_admin", return_value=supabase):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "service": "fitra-backend",
        "database": "connected",
        "environment": "development",
    }
    supabase.table.assert_called_once_with("users")
    supabase.table.return_value.select.assert_called_once_with("*")
    supabase.table.return_value.select.return_value.limit.assert_called_once_with(1)
    supabase.table.return_value.select.return_value.limit.return_value.execute.assert_called_once_with()


def test_health_check_reports_database_failure():
    supabase = MagicMock()
    supabase.table.side_effect = RuntimeError("database unavailable")

    with patch("app.commons.auth.deps.get_supabase_admin", return_value=supabase):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["database"] == "connection failed: database unavailable"
