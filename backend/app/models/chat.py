from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field

class SessionCreate(BaseModel):
    pass


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: UUID
    user_id: UUID
    started_at: datetime


class MessageCreate(BaseModel):
    content: str
    training_schedule: List[Dict[str, Any]] = Field(default_factory=list)


class MessageResponse(BaseModel):
    message_id: str
    session_id: str
    sender: str
    content: str
    timestamp: str
    has_health_flag: Optional[bool] = False
    planned_session: Optional[Union[Dict[str, Any], List[Dict[str, Any]]]] = None
    recommended_session: Optional[Dict[str, Any]] = None
    recommended_sessions: Optional[List[Dict[str, Any]]] = None
    nutrition_plan: Optional[Dict[str, Any]] = None
    nutrition_schedule: Optional[List[Dict[str, Any]]] = None
    weekly_training_plan: Optional[List[Dict[str, Any]]] = None


class SessionDetailResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: UUID
    user_id: UUID
    started_at: datetime
    messages: List[MessageResponse] = []


MessageResponse.model_rebuild()
SessionDetailResponse.model_rebuild()