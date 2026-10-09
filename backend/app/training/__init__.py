from fastapi import FastAPI

__all__ = ["install"]


def install(app: FastAPI) -> None:
    """Mount the training routes. Imported lazily so that importing this package (for example to
    train the readiness model) doesn't need the Supabase settings the routes depend on."""
    from .router import install as install_routes

    install_routes(app)
