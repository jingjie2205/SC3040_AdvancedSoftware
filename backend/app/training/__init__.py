from fastapi import FastAPI

__all__ = ["install"]


def install(app: FastAPI) -> None:
    """Mount the training routes. Imported lazily so that importing this package (for example to
    train the readiness model) doesn't need the Supabase settings the routes depend on."""
    from .router import install as install_routes
    from .strava_router import router as strava_router

    install_routes(app)
    app.include_router(strava_router)  # the Strava tab's routes sit apart from the rest, see strava_sync.py
