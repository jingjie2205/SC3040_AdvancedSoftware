import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# --- New Architecture Imports ---
from .commons.config import get_settings
from .controllers.users import router as users_router
from .controllers.strava import router as strava_router
from .controllers.checkin import router as checkin_router
from .controllers.gamification import router as gamification_router
from .controllers.nutrition import router as nutrition_router
from .training import install as install_training_routes
from .controllers.chat import router as chat_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fitra.backend")

settings = get_settings()

# Notice lifespan=lifespan has been removed here
app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    description="Scientific Endurance Training Load & AI Recovery Backend",
)

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000", "https://sc-3040-fitra.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# API Routers (The Controller Layer)
# ============================================================================
app.include_router(users_router)
app.include_router(strava_router)
app.include_router(checkin_router)
app.include_router(gamification_router)
app.include_router(nutrition_router)
app.include_router(chat_router)
install_training_routes(app)

@app.get("/health", tags=["Health"])
async def health_check():
    from .commons.auth.deps import get_supabase_admin
    try:
        supabase = get_supabase_admin()
        supabase.table("users").select("*").limit(1).execute()
        db_status = "connected"
    except Exception as e:
        db_status = f"connection failed: {str(e)}"

    return {
        "status": "healthy",
        "service": "fitra-backend",
        "database": db_status,
        "environment": settings.ENVIRONMENT,
    }
