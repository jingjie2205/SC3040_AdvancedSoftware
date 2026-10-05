from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

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
    """Retrieve all check-in dates for the current user."""

    supabase = get_supabase_admin()

    response = (
        supabase
        .table("daily_check_ins")
        .select("user_id, dates")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    if not response or not response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Check-in record not found",
        )

    data = response.data

    return {
        "user_id": data["user_id"],
        "dates": data["dates"],
    }


@router.post("/me", response_model=CheckInDatesResponse)
async def check_in(
    user_id: str = Depends(get_current_user_id),
) -> Any:
    """Add today's date to the user's check-in dates."""

    supabase = get_supabase_admin()

    today = date.today().isoformat()

    # Get the user's existing check-in record
    response = (
        supabase
        .table("daily_check_ins")
        .select("user_id, dates")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )

    # If no record exists, create a new one
    if not response or not response.data:
        new_record = {
            "user_id": user_id,
            "dates": [today]
        }
        insert_response = supabase.table("daily_check_ins").insert(new_record).execute()
        if not insert_response.data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to create check-in record",
            )
        return insert_response.data[0]

    # If a record exists, update it
    data = response.data
    dates = data.get("dates") or []

    # Prevent checking in twice on the same day
    if today in dates:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Already checked in today",
        )

    dates.append(today)

    # Update the array
    update_response = (
        supabase
        .table("daily_check_ins")
        .update({"dates": dates})
        .eq("user_id", user_id)
        .execute()
    )

    if not update_response.data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to update check-in",
        )

    updated_data = update_response.data[0]

    return {
        "user_id": updated_data["user_id"],
        "dates": updated_data["dates"],
    }