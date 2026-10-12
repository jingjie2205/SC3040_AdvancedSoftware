from typing import List, Optional
from uuid import UUID
from datetime import datetime, timezone, date
import re

from fastapi import APIRouter, Depends, HTTPException, Response, status
import httpx
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from app.commons.auth.deps import get_current_user_id, get_supabase_admin
from app.models.chat import (
    SessionCreate,
    SessionResponse,
    SessionDetailResponse,
    MessageCreate,
    MessageResponse,
)
from app.services.gemini import gemini_service

router = APIRouter(prefix="/chat", tags=["Chat"])


def to_frontend_sender(sender: str) -> str:
    s = sender.strip().upper()
    return "assistant" if s == "AI" else "user"


@router.get("/sessions", response_model=List[SessionResponse])
async def get_user_chat_sessions(user_id: str = Depends(get_current_user_id)):
    supabase = get_supabase_admin()
    
    def _fetch():
        return (
            supabase.table("chat_sessions")
            .select("session_id, user_id, started_at")
            .eq("user_id", user_id)
            .order("started_at", desc=True)
            .execute()
        )
    
    res = await run_in_threadpool(_fetch)
    return res.data or []


@router.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_chat_session(
    body: Optional[SessionCreate] = None,
    user_id: str = Depends(get_current_user_id),
):
    supabase = get_supabase_admin()
    now_iso = datetime.now(timezone.utc).isoformat()
    new_session = {"user_id": user_id, "started_at": now_iso}

    def _insert():
        return supabase.table("chat_sessions").insert(new_session).execute()

    res = await run_in_threadpool(_insert)
    if not res.data:
        raise HTTPException(status_code=500, detail="Failed to create session.")
    return res.data[0]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chat_session(
    session_id: UUID,
    user_id: str = Depends(get_current_user_id),
):
    supabase = get_supabase_admin()

    def _delete():
        session_res = (
            supabase.table("chat_sessions")
            .select("session_id")
            .eq("session_id", str(session_id))
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if not session_res.data:
            return False

        supabase.table("chat_messages").delete().eq(
            "session_id", str(session_id)
        ).execute()
        supabase.table("chat_sessions").delete().eq(
            "session_id", str(session_id)
        ).eq("user_id", user_id).execute()
        return True

    deleted = await run_in_threadpool(_delete)
    if not deleted:
        raise HTTPException(status_code=404, detail="Chat session not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def get_chat_history(session_id: UUID, user_id: str = Depends(get_current_user_id)):
    supabase = get_supabase_admin()

    def _get():
        session_res = (
            supabase.table("chat_sessions")
            .select("session_id, user_id, started_at")
            .eq("session_id", str(session_id))
            .execute()
        )
        if not session_res.data or str(session_res.data[0]["user_id"]) != str(user_id):
            return None, []

        msg_res = (
            supabase.table("chat_messages")
            .select(
                "message_id, session_id, sender, content, timestamp, has_health_flag, "
                "planned_session, nutrition_plan, nutrition_schedule"
                ", weekly_training_plan"
            )
            .eq("session_id", str(session_id))
            .order("timestamp", desc=False)
            .execute()
        )
        return session_res.data[0], msg_res.data or []

    session_data, messages = await run_in_threadpool(_get)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found.")

    for m in messages:
        m["sender"] = to_frontend_sender(m.get("sender", ""))
    session_data["messages"] = messages
    return session_data


@router.post(
    "/sessions/{session_id}/send",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def send_chat_message(
    session_id: UUID,
    body: MessageCreate,
    user_id: str = Depends(get_current_user_id),
):
    supabase = get_supabase_admin()

    def _verify_and_prepare():
        session_res = (
            supabase.table("chat_sessions")
            .select("session_id, user_id")
            .eq("session_id", str(session_id))
            .execute()
        )
        if not session_res.data or str(session_res.data[0]["user_id"]) != str(user_id):
            return None, [], {}

        user_msg = {
            "session_id": str(session_id),
            "sender": "USER",
            "content": body.content,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "has_health_flag": False,
        }
        supabase.table("chat_messages").insert(user_msg).execute()

        past = (
            supabase.table("chat_messages")
            .select("sender, content")
            .eq("session_id", str(session_id))
            .order("timestamp", desc=False)
            .limit(10)
            .execute()
            .data or []
        )

        user_info = (
            supabase.table("users")
            .select("weight, height, biological_sex")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
            .data
        )
        ctx = user_info[0] if user_info else {}
        ctx["today"] = date.today().isoformat()
        ctx["training_schedule"] = body.training_schedule
        return session_res.data[0], past, ctx

    session_data, past_messages, athlete_context = await run_in_threadpool(_verify_and_prepare)
    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found.")

    # Call Gemini to get structured output
    ai_result = await run_in_threadpool(
        gemini_service.generate_chat_response,
        user_input=body.content,
        history=past_messages,
        athlete_context=athlete_context,
    )

    reply_text = ai_result.get("reply") or "I processed your request."
    planned_session = ai_result.get("recommended_session") or ai_result.get("planned_session")
    nutrition_plan = ai_result.get("nutrition_plan")
    nutrition_schedule = ai_result.get("nutrition_schedule")
    weekly_training_plan = ai_result.get("weekly_training_plan")

    is_health_flag = bool(re.search(r"pain|injury|chest pain|dizziness|faint|fracture", body.content, re.I))
    now_iso = datetime.now(timezone.utc).isoformat()

    def _persist_ai():
        ai_payload = {
            "session_id": str(session_id),
            "sender": "AI",
            "content": reply_text,
            "timestamp": now_iso,
            "has_health_flag": is_health_flag,
            "planned_session": planned_session,
            "nutrition_plan": nutrition_plan,
            "nutrition_schedule": nutrition_schedule,
            "weekly_training_plan": weekly_training_plan,
        }
        # Note the .select() chained here to guarantee PostgREST returns representation
        return supabase.table("chat_messages").insert(ai_payload).select().execute()

    ai_res = await run_in_threadpool(_persist_ai)
    
    # If Supabase returns representation, use its message_id; otherwise fall back
    if ai_res.data and len(ai_res.data) > 0:
        row = ai_res.data[0]
        msg_id = row.get("message_id")
        created_ts = row.get("timestamp", now_iso)
    else:
        from uuid import uuid4
        msg_id = str(uuid4())
        created_ts = now_iso

    return {
        "message_id": msg_id,
        "session_id": str(session_id),
        "sender": "assistant",
        "content": reply_text,
        "timestamp": created_ts,
        "has_health_flag": is_health_flag,
        "planned_session": planned_session,
        "recommended_session": planned_session,
        "nutrition_plan": nutrition_plan,
        "nutrition_schedule": nutrition_schedule,
        "weekly_training_plan": weekly_training_plan,
    }