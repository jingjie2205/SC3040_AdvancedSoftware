from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


# --- Food Items ---
class FoodItemBase(BaseModel):
    name: str
    estimatedWeight: float | None = None
    calories: float | None = None
    protein: float | None = None
    carbs: float | None = None
    fats: float | None = None


class FoodItemResponse(FoodItemBase):
    itemId: str
    logId: str
    createdAt: datetime

    class Config:
        from_attributes = True


# --- Meal Plans (Logs) ---
class MealPlanBase(BaseModel):
    timestamp: datetime
    imageReference: str | None = None
    totalCalories: float | None = None
    confidenceScore: float | None = None


class MealPlanResponse(MealPlanBase):
    logId: str
    userId: str
    createdAt: datetime
    contains: list[FoodItemResponse] = []

    class Config:
        from_attributes = True


Nutrient = Annotated[float, Field(ge=0, le=100000, allow_inf_nan=False)]


class FoodItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    estimated_weight_g: float = Field(gt=0, le=10000, allow_inf_nan=False)
    calories: Nutrient
    protein_g: Nutrient
    carbs_g: Nutrient
    fat_g: Nutrient


class MealEstimate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    meal_name: str = Field(min_length=1, max_length=160)
    confidence_score: float = Field(ge=0, le=1, allow_inf_nan=False)
    training_context_note: str = Field(max_length=2000)
    items: list[FoodItem] = Field(max_length=50)


class MealAnalysis(MealEstimate):
    items: list[FoodItem] = Field(min_length=1, max_length=50)
    total_calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


class MealCreate(MealEstimate):
    items: list[FoodItem] = Field(min_length=1, max_length=50)
    id: UUID
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    logged_at: AwareDatetime


class MealRecord(MealAnalysis):
    id: UUID
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    logged_at: AwareDatetime
