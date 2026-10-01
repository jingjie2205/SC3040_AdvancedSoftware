from enum import Enum
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, EmailStr

class BiologicalSex(str, Enum):
    MALE = "MALE"
    FEMALE = "FEMALE"

class ActivityLevel(str, Enum):
    SEDENTARY = "SEDENTARY"
    LIGHTLY_ACTIVE = "LIGHTLY_ACTIVE"
    MODERATELY_ACTIVE = "MODERATELY_ACTIVE"
    VERY_ACTIVE = "VERY_ACTIVE"
    EXTRA_ACTIVE = "EXTRA_ACTIVE"

class UserBase(BaseModel):
    email: EmailStr
    age: Optional[int] = None
    weight: Optional[float] = None
    height: Optional[float] = None
    biologicalSex: Optional[BiologicalSex] = None
    activityLevel: Optional[ActivityLevel] = None
    fitnessGoal: Optional[str] = None

class UserUpdate(BaseModel):
    age: Optional[int] = None
    weight: Optional[float] = None
    height: Optional[float] = None
    biologicalSex: Optional[BiologicalSex] = None
    activityLevel: Optional[ActivityLevel] = None
    fitnessGoal: Optional[str] = None

class UserResponse(UserBase):
    userId: str
    createdAt: datetime

    class Config:
        from_attributes = True