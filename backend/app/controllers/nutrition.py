from datetime import date
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from app.commons.auth.deps import get_current_user_id, get_supabase_admin
from app.models.nutrition import MealAnalysis, MealCreate, MealRecord
from app.services import nutrition

router = APIRouter(prefix="/api/nutrition", tags=["Nutrition"])


@router.post("/analyze", response_model=MealAnalysis)
async def analyze_meal(
    file: Annotated[UploadFile, File()],
    notes: str = Form(default="", max_length=1000),
    user_id: str = Depends(get_current_user_id),
):
    try:
        if file.content_type not in nutrition.SUPPORTED_TYPES:
            raise HTTPException(415, "Use JPEG, PNG, WEBP or HEIC/HEIF.")
        content = await file.read(nutrition.MAX_UPLOAD_BYTES + 1)
        if len(content) > nutrition.MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Image exceeds the 10 MB limit.")
        normalized = await run_in_threadpool(nutrition.normalize_image, content)
    finally:
        await file.close()
    return await nutrition.analyze_image(normalized, notes)


@router.post("/meals", response_model=MealRecord, status_code=201)
def create_meal(body: MealCreate, user_id: str = Depends(get_current_user_id)):
    try:
        return nutrition.save_meal(get_supabase_admin(), user_id, body)
    except (APIError, httpx.RequestError) as exc:
        raise HTTPException(
            503,
            "Could not save your meal. Your draft is still available; please retry.",
        ) from exc


@router.get("/daily")
def get_daily_log(
    day: date,
    offset_minutes: int = Query(default=0, ge=-720, le=840),
    user_id: str = Depends(get_current_user_id),
):
    try:
        return nutrition.daily_log(get_supabase_admin(), user_id, day, offset_minutes)
    except (APIError, httpx.RequestError) as exc:
        raise HTTPException(
            503,
            "Could not load your nutrition log. Check the database setup and try again.",
        ) from exc


@router.delete("/meals/{meal_id}", status_code=204)
def delete_meal(meal_id: UUID, user_id: str = Depends(get_current_user_id)):
    try:
        result = (
            get_supabase_admin()
            .rpc(
                "delete_nutrition_meal",
                {"p_user_id": user_id, "p_log_id": str(meal_id)},
            )
            .execute()
        )
    except (APIError, httpx.RequestError) as exc:
        raise HTTPException(
            503, "Could not delete your meal. Please try again."
        ) from exc
    if not result.data:
        raise HTTPException(404, "Meal not found.")
