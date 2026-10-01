"""
Request identity for the training routes.

Unlike a permissive dev fallback, this fails closed: no token, a bad signature, an expired token
or a missing secret all stop the request. The user id comes only from the verified token's `sub`.
"""
from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

import jwt
from fastapi import Header, HTTPException

from ..commons.config import get_settings


def _error(status: int, code: str, message: str) -> HTTPException:
    headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
    return HTTPException(status_code=status, detail={"code": code, "message": message}, headers=headers)


def require_user_id(authorization: Optional[str] = Header(None)) -> str:
    secret = get_settings().SUPABASE_JWT_SECRET
    if not secret:
        raise _error(503, "NOT_CONFIGURED", "Authentication isn't configured. Set SUPABASE_JWT_SECRET.")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _error(401, "UNAUTHORIZED", "Sign in to continue.")

    token = authorization[7:].strip()
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["exp", "sub"]},
        )
        return str(UUID(str(payload["sub"])))
    except (jwt.PyJWTError, ValueError):
        raise _error(401, "UNAUTHORIZED", "Your session is invalid or has expired. Sign in again.")


def get_client_date(x_client_date: Optional[str] = Header(None)) -> date:
    """
    "Today" as the user sees it. The server has no timezone database and users aren't all in
    UTC, so the client sends its local date. It must be within a day of UTC, which any real
    timezone satisfies.
    """
    utc_today = datetime.now(timezone.utc).date()
    if x_client_date is None:
        return utc_today
    try:
        client_date = date.fromisoformat(x_client_date)
    except ValueError:
        raise _error(400, "VALIDATION", "X-Client-Date must be a date like 2026-09-30.")
    if abs((client_date - utc_today).days) > 1:
        raise _error(400, "VALIDATION", "X-Client-Date is too far from the server's date.")
    return client_date
