from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from supabase import create_client, Client
from app.commons.config import get_settings

security = HTTPBearer()
settings = get_settings()

def get_supabase_admin() -> Client:
    """
    Returns a Supabase client with admin privileges (Service Role).
    Used for backend database operations bypassing RLS.
    """
    try:
        return create_client(
            settings.effective_supabase_url, 
            settings.effective_supabase_key
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=f"Database connection failed: {str(e)}"
        )

async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> str:
    """
    Verifies the frontend JWT with Supabase Auth and extracts the user's UUID.
    Inject this into any endpoint that requires a logged-in user.
    """
    supabase = get_supabase_admin()
    token = credentials.credentials
    
    try:
        # Validate token against Supabase Auth
        auth_response = supabase.auth.get_user(token)
        if not auth_response or not auth_response.user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired authentication token",
            )
        return auth_response.user.id
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )