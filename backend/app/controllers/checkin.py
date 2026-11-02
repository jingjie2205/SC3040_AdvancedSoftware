from typing import Any

from fastapi import APIRouter, Depends

from app.commons.auth.deps import (
    get_current_user_id,
    get_supabase_admin,
)
from app.models.checkin import CheckInDatesResponse

router = APIRouter(
    prefix="/checkin",
    tags=["Checkin API"],
)


@router.get("/me/dates", response_model=CheckInDatesResponse)
async def get_my_check_ins(
    user_id: str = Depends(get_current_user_id),
) -> Any:
    """All dates the current user checked in, oldest first.

    Check-ins are created through the questionnaire (POST /gamification/checkins); this only
    reads the dates for the home-page calendar.
    """

    supabase = get_supabase_admin()

    response = (
        supabase
        .table("daily_checkins")
        .select("date")
        .eq("user_id", user_id)
        .order("date")
        .execute()
    )

    return {
        "user_id": user_id,
        "dates": [row["date"] for row in response.data or []],
    }
