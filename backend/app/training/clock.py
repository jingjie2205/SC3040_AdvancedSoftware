"""
"Today" as the user sees it. The server has no timezone database and users aren't all in UTC, so
the client sends its local date. It must be within a day of UTC, which any real timezone satisfies.
"""
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException


def get_client_date(x_client_date: Optional[str] = Header(None)) -> date:
    utc_today = datetime.now(timezone.utc).date()
    if x_client_date is None:
        return utc_today
    try:
        client_date = date.fromisoformat(x_client_date)
    except ValueError:
        raise _invalid("X-Client-Date must be a date like 2026-09-30.")
    if abs((client_date - utc_today).days) > 1:
        raise _invalid("X-Client-Date is too far from the server's date.")
    return client_date


def _invalid(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "VALIDATION", "message": message})
