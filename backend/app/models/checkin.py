from datetime import date
from pydantic import BaseModel


class CheckInDatesResponse(BaseModel):
    user_id: str
    dates: list[date]
