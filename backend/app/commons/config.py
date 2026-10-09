from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # App config
    APP_NAME: str = "FITRA Backend"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False
    PORT: int = 8000
    FRONTEND_URL: str = "http://localhost:3000"

    # Supabase (PostgreSQL & Auth)
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_JWT_SECRET: str = ""

    # Redis Queue
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_ACTIVITY_QUEUE: str = "activity_queue"

    # Strava API (OAuth & Webhooks)
    STRAVA_CLIENT_ID: str = ""
    STRAVA_CLIENT_SECRET: str = ""
    STRAVA_VERIFY_TOKEN: str = "fitra_strava_verify_token"

    # Google Gemini AI
    GOOGLE_GENERATIVE_AI_API_KEY: str = ""
    GEMINI_NUTRITION_MODEL: str = "gemini-2.5-flash"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def effective_supabase_url(self) -> str:
        return self.SUPABASE_URL

    @property
    def effective_supabase_key(self) -> str:
        return self.SUPABASE_SERVICE_ROLE_KEY


@lru_cache
def get_settings() -> Settings:
    return Settings()
