from fastapi import APIRouter, Depends, HTTPException, status
from typing import Any
from app.models.users import UserResponse, UserUpdate
from app.commons.auth.deps import get_current_user_id, get_supabase_admin

router = APIRouter(tags=["Users"])

@router.get("/users/me", response_model=UserResponse)
async def get_my_profile(
    user_id: str = Depends(get_current_user_id)
) -> Any:
    """Retrieve current authenticated user's profile."""
    supabase = get_supabase_admin()
    
    # Bypass RLS using the admin client to fetch the user profile
    response = supabase.table("users").select("*").eq("user_id", user_id).maybe_single().execute()
    
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, 
            detail="User profile not found"
        )
        
    data = response.data
    return {
        "email": data["email"],
        "age": data.get("age"),
        "weight": data.get("weight"),
        "height": data.get("height"),
        "biologicalSex": data.get("biological_sex"),
        "activityLevel": data.get("activity_level"),
        "fitnessGoal": data.get("fitness_goal"),
        "userId": data["user_id"],
        "createdAt": data["created_at"],
        "isStravaConnected": bool(data.get("strava_access_token")) 
    }

@router.put("/users/me", response_model=UserResponse)
async def update_my_profile(
    body: UserUpdate,
    user_id: str = Depends(get_current_user_id)
) -> Any:
    """Update current user's profile attributes."""
    supabase = get_supabase_admin()
        
    # Dynamically build the update payload stripping out None values
    update_data = {}
    if body.age is not None: update_data["age"] = body.age
    if body.weight is not None: update_data["weight"] = body.weight
    if body.height is not None: update_data["height"] = body.height
    if body.biologicalSex is not None: update_data["biological_sex"] = body.biologicalSex.value
    if body.activityLevel is not None: update_data["activity_level"] = body.activityLevel.value
    if body.fitnessGoal is not None: update_data["fitness_goal"] = body.fitnessGoal

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="No valid fields provided for update"
        )

    response = supabase.table("users").update(update_data).eq("user_id", user_id).execute()
    
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Failed to update profile. Ensure the profile exists in the database."
        )
        
    data = response.data[0]
    return {
        "email": data["email"],
        "age": data.get("age"),
        "weight": data.get("weight"),
        "height": data.get("height"),
        "biologicalSex": data.get("biological_sex"),
        "activityLevel": data.get("activity_level"),
        "fitnessGoal": data.get("fitness_goal"),
        "userId": data["user_id"],
        "createdAt": data["created_at"],
        "isStravaConnected": bool(data.get("strava_access_token"))
    }