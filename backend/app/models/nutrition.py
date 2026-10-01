from typing import List, Optional
from datetime import datetime
from pydantic import BaseModel

# --- Food Items ---
class FoodItemBase(BaseModel):
    name: str
    estimatedWeight: Optional[float] = None
    calories: Optional[float] = None
    protein: Optional[float] = None
    carbs: Optional[float] = None
    fats: Optional[float] = None

class FoodItemResponse(FoodItemBase):
    itemId: str
    logId: str
    createdAt: datetime

    class Config:
        from_attributes = True

# --- Meal Plans (Logs) ---
class MealPlanBase(BaseModel):
    timestamp: datetime
    imageReference: Optional[str] = None
    totalCalories: Optional[float] = None
    confidenceScore: Optional[float] = None

class MealPlanResponse(MealPlanBase):
    logId: str
    userId: str
    createdAt: datetime
    contains: List[FoodItemResponse] = []

    class Config:
        from_attributes = True