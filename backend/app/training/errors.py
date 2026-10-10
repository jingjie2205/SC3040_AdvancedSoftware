from datetime import date
from typing import Dict, Literal, Optional

from fastapi import HTTPException

ErrorCode = Literal[
    "VALIDATION",
    "NO_PREFERENCES",
    "NO_PLAN",
    "PLAN_EXISTS",
    "PLAN_UNSAFE",
    "PLAN_ENDED",
    "NOT_FOUND",
    "INVALID_STATE",
    "NOT_MOVABLE",
    "NO_CHANGE",
    "IN_PAST",
    "OUT_OF_PLAN",
    "DAY_OCCUPIED",
    "CONSECUTIVE_HIGH_INTENSITY",
    "UNAVAILABLE",
    "RATE_LIMITED",
    "NOT_CONNECTED",
]

_STATUS: Dict[str, int] = {
    "VALIDATION": 422,
    "PLAN_UNSAFE": 422,
    "NO_PLAN": 404,
    "NOT_FOUND": 404,
    "UNAVAILABLE": 503,
    "RATE_LIMITED": 429,
}


class TrainingError(HTTPException):
    """
    Raised by the service layer. The default FastAPI handler renders it as
    `{"detail": {"code", "message", "fieldErrors"?, "suggestedDate"?}}`, so the client can
    always show a reason. Anything without an explicit status is a 409 (the request was valid
    but the current state doesn't allow it).
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        field_errors: Optional[Dict[str, str]] = None,
        suggested_date: Optional[date] = None,
    ) -> None:
        detail: Dict[str, object] = {"code": code, "message": message}
        if field_errors:
            detail["fieldErrors"] = field_errors
        if suggested_date is not None:
            detail["suggestedDate"] = suggested_date.isoformat()
        super().__init__(status_code=_STATUS.get(code, 409), detail=detail)
        self.code = code
        self.message = message
        self.suggested_date = suggested_date
