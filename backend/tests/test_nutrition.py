import io
import json
import os
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")

from app.commons.auth.deps import get_current_user_id
from app.controllers import nutrition as controller
from app.models.nutrition import FoodItem, MealAnalysis, MealCreate
from app.services import nutrition

USER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"


def payload():
    return {
        "id": str(uuid4()),
        "meal_name": "Rice bowl",
        "meal_type": "lunch",
        "logged_at": "2026-10-07T04:00:00Z",
        "confidence_score": 0.8,
        "training_context_note": "Estimated recovery meal.",
        "items": [
            {
                "name": "Rice",
                "estimated_weight_g": 150,
                "calories": 195,
                "protein_g": 4,
                "carbs_g": 42,
                "fat_g": 0.5,
            }
        ],
    }


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters = []
        self.op, self.payload = "select", None

    def select(self, *_):
        return self

    def eq(self, key, value):
        self.filters.append(lambda row: row.get(key) == value)
        return self

    def gte(self, key, value):
        self.filters.append(lambda row: row[key] >= value)
        return self

    def lt(self, key, value):
        self.filters.append(lambda row: row[key] < value)
        return self

    def order(self, *_, **__):
        return self

    def limit(self, *_):
        return self

    def insert(self, value):
        self.op, self.payload = "insert", value
        return self

    def upsert(self, value, on_conflict):
        assert on_conflict == "user_id,date"
        self.op, self.payload = "upsert", value
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        rows = self.db.rows.setdefault(self.table, [])
        if self.op == "upsert":
            for new in self.payload:
                existing = next((row for row in rows if (row["user_id"], row["date"]) == (new["user_id"], new["date"])), None)
                if existing is None:
                    rows.append(new.copy())
                else:
                    existing.update(new)
            return SimpleNamespace(data=self.payload)
        if self.op == "insert":
            rows.append(self.payload)
            return SimpleNamespace(data=[self.payload])
        selected = [row for row in rows if all(test(row) for test in self.filters)]
        if self.op == "delete":
            self.db.rows[self.table] = [row for row in rows if row not in selected]
        return SimpleNamespace(data=selected)


class Database:
    def __init__(self):
        self.rows = {}

    def table(self, name):
        return Query(self, name)

    def rpc(self, name, params):
        if name == "save_nutrition_meal":
            meal, user = params["p_meal"], params["p_user_id"]
            rows = self.rows.setdefault("meal_plans", [])
            existing = next((row for row in rows if row["log_id"] == meal["id"]), None)
            if existing is None:
                rows.append(
                    {
                        "log_id": meal["id"],
                        "user_id": user,
                        "timestamp": meal["logged_at"],
                        "meal_name": meal["meal_name"],
                        "meal_type": meal["meal_type"],
                        "confidence_score": meal["confidence_score"],
                        "training_context_note": meal["training_context_note"],
                        "food_items": [
                            {
                                "name": item["name"],
                                "estimated_weight": item["estimated_weight_g"],
                                "calories": item["calories"],
                                "protein": item["protein_g"],
                                "carbs": item["carbs_g"],
                                "fats": item["fat_g"],
                            }
                            for item in meal["items"]
                        ],
                    }
                )
            elif existing["user_id"] != user:
                raise nutrition.APIError({"code": "23505", "message": "collision"})
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=meal["id"]))
        assert name == "delete_nutrition_meal"
        rows = self.rows.setdefault("meal_plans", [])
        selected = [
            row
            for row in rows
            if row["log_id"] == params["p_log_id"]
            and row["user_id"] == params["p_user_id"]
        ]
        self.rows["meal_plans"] = [row for row in rows if row not in selected]
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=bool(selected)))


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(controller.router)
    db = Database()
    app.dependency_overrides[get_current_user_id] = lambda: USER
    monkeypatch.setattr(controller, "get_supabase_admin", lambda: db)
    with TestClient(app) as test_client:
        yield test_client, db


def image_bytes(format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "green").save(output, format=format)
    return output.getvalue()


def test_auth_required():
    app = FastAPI()
    app.include_router(controller.router)
    with TestClient(app) as client:
        for method, path in [
            ("GET", "/daily?day=2026-10-07"),
            ("POST", "/analyze"),
            ("POST", "/meals"),
            ("DELETE", f"/meals/{uuid4()}"),
        ]:
            assert client.request(method, f"/api/nutrition{path}").status_code in {
                401,
                403,
            }


@pytest.mark.parametrize("format", ["PNG", "JPEG", "WEBP", "HEIF"])
def test_normalizes_supported_images(format):
    result = nutrition.normalize_image(image_bytes(format))
    with Image.open(io.BytesIO(result)) as image:
        assert image.format == "JPEG"
        assert image.size == (20, 20)


@pytest.mark.parametrize("content", [b"", b"not an image", b"<svg></svg>"])
def test_rejects_invalid_image(content):
    with pytest.raises(HTTPException) as exc:
        nutrition.normalize_image(content)
    assert exc.value.status_code == 400


def test_upload_validation(client, monkeypatch):
    api, _ = client
    spy = AsyncMock()
    monkeypatch.setattr(nutrition, "analyze_image", spy)
    for body, mime, expected in [
        (b"x", "text/plain", 415),
        (b"bad", "image/png", 400),
        (b"x" * (nutrition.MAX_UPLOAD_BYTES + 1), "image/png", 413),
    ]:
        assert (
            api.post(
                "/api/nutrition/analyze", files={"file": ("meal.png", body, mime)}
            ).status_code
            == expected
        )
    spy.assert_not_called()


def test_analyze_preserves_notes_without_saving(client, monkeypatch):
    api, db = client
    data = payload()
    estimate = MealAnalysis(
        **{
            key: data[key]
            for key in (
                "meal_name",
                "confidence_score",
                "training_context_note",
                "items",
            )
        },
        **nutrition.totals([FoodItem(**data["items"][0])]),
    )
    spy = AsyncMock(return_value=estimate)
    monkeypatch.setattr(nutrition, "analyze_image", spy)
    result = api.post(
        "/api/nutrition/analyze",
        files={"file": ("meal.png", image_bytes(), "image/png")},
        data={"notes": "After a run"},
    )
    assert result.status_code == 200
    assert result.json()["total_calories"] == 195
    assert spy.call_args.args[1] == "After a run"
    assert not db.rows


def test_save_recalculates_and_is_idempotent(client):
    api, db = client
    body = payload()
    body["items"].append({**body["items"][0], "name": "More rice"})
    first = api.post("/api/nutrition/meals", json=body)
    second = api.post("/api/nutrition/meals", json=body)
    assert first.status_code == second.status_code == 201
    assert first.json()["total_calories"] == 390
    assert len(db.rows["meal_plans"]) == 1
    assert db.rows["meal_plans"][0]["user_id"] == USER


@pytest.mark.parametrize(
    "changes",
    [
        {"user_id": OTHER},
        {"total_calories": 1},
        {"items": []},
        {"confidence_score": 2},
        {"meal_type": "other"},
        {"logged_at": "2026-10-07T12:00:00"},
    ],
)
def test_rejects_invalid_or_spoofed_save(client, changes):
    api, _ = client
    assert (
        api.post("/api/nutrition/meals", json={**payload(), **changes}).status_code
        == 422
    )


@pytest.mark.parametrize(
    "key,value",
    [
        ("estimated_weight_g", 0),
        ("calories", -1),
        ("protein_g", float("nan")),
        ("name", " "),
    ],
)
def test_food_bounds(key, value):
    with pytest.raises(ValidationError):
        FoodItem(**{**payload()["items"][0], key: value})


def test_daily_timezone_energy_and_ownership(client):
    api, db = client
    nutrition.save_meal(
        db, USER, MealCreate(**{**payload(), "logged_at": "2026-10-06T17:00:00+00:00"})
    )
    nutrition.save_meal(
        db, USER, MealCreate(**{**payload(), "logged_at": "2026-10-07T16:00:00+00:00"})
    )
    nutrition.save_meal(db, OTHER, MealCreate(**payload()))
    db.rows["users"] = [
        {
            "user_id": USER,
            "weight": 70,
            "height": 175,
            "age": 30,
            "biological_sex": "MALE",
        }
    ]
    db.rows["activities"] = [
        {"user_id": USER, "start_date": "2026-10-07T01:00:00+00:00", "calories": 400},
        {"user_id": OTHER, "start_date": "2026-10-07T01:00:00+00:00", "calories": 900},
    ]
    result = api.get("/api/nutrition/daily?day=2026-10-07&offset_minutes=480").json()
    assert len(result["meals"]) == 1
    assert result["total_calories"] == 195
    assert result["bmr"] == 1649
    assert result["active_calories"] == 400
    assert result["net_energy"] == 195 - 1649 - 400


def test_missing_energy_data_is_not_zero(client):
    _, db = client
    result = nutrition.daily_log(db, USER, date(2026, 10, 7), 0)
    assert result["bmr"] is result["active_calories"] is result["net_energy"] is None
    assert result["total_calories"] == 0


def test_delete_only_owned_meal(client):
    api, db = client
    mine, other = MealCreate(**payload()), MealCreate(**payload())
    nutrition.save_meal(db, USER, mine)
    nutrition.save_meal(db, OTHER, other)
    assert api.delete(f"/api/nutrition/meals/{other.id}").status_code == 404
    assert api.delete(f"/api/nutrition/meals/{mine.id}").status_code == 204
    assert len(db.rows["meal_plans"]) == 1


@pytest.mark.asyncio
async def test_missing_ai_key(monkeypatch):
    monkeypatch.setattr(
        nutrition,
        "get_settings",
        lambda: SimpleNamespace(GOOGLE_GENERATIVE_AI_API_KEY=""),
    )
    with pytest.raises(HTTPException) as exc:
        await nutrition.analyze_image(image_bytes(), "")
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_gemini_request_serializes_with_real_sdk(monkeypatch):
    data = payload()
    estimate = {
        key: data[key]
        for key in ("meal_name", "confidence_score", "training_context_note", "items")
    }
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "role": "model",
                            "parts": [{"text": json.dumps(estimate)}],
                        },
                        "finishReason": "STOP",
                    }
                ],
            },
        )

    client_factory = nutrition.genai.Client
    monkeypatch.setattr(
        nutrition,
        "get_settings",
        lambda: SimpleNamespace(
            GOOGLE_GENERATIVE_AI_API_KEY="fixture-key",
            GEMINI_NUTRITION_MODEL="gemini-3.1-flash-lite",
        ),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
        monkeypatch.setattr(
            nutrition.genai,
            "Client",
            lambda **kwargs: client_factory(
                api_key=kwargs["api_key"],
                http_options=nutrition.types.HttpOptions(httpx_async_client=http_client),
            ),
        )
        result = await nutrition.analyze_image(image_bytes(), "after run")

    assert result.total_calories == 195
    assert len(requests) == 1
    schema = requests[0]["generationConfig"]["responseSchema"]
    weight_schema = schema["properties"]["items"]["items"]["properties"]["estimated_weight_g"]
    assert "minimum" not in weight_schema
    assert "maximum" not in weight_schema
    assert "exclusiveMinimum" not in weight_schema
    assert "maxItems" not in schema["properties"]["items"]
    assert "additionalProperties" not in schema
    assert "maxLength" not in schema["properties"]["meal_name"]
    assert requests[0]["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "image/jpeg"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scenario,expected",
    [
        ("valid", 200),
        ("empty", 422),
        ("invalid", 422),
        ("zero_weight", 422),
        ("negative_nutrient", 422),
        ("invalid_confidence", 422),
        ("too_many_items", 422),
        ("timeout", 504),
        ("quota", 429),
        ("bad_request", 502),
        ("credentials", 502),
        ("denied", 502),
        ("missing_model", 502),
        ("unavailable", 502),
    ],
)
async def test_gemini_response_handling(monkeypatch, scenario, expected):
    data = payload()
    estimate = {
        key: data[key]
        for key in ("meal_name", "confidence_score", "training_context_note", "items")
    }
    if scenario == "empty":
        estimate["items"] = []
    if scenario == "zero_weight":
        estimate["items"][0]["estimated_weight_g"] = 0
    if scenario == "negative_nutrient":
        estimate["items"][0]["calories"] = -1
    if scenario == "invalid_confidence":
        estimate["confidence_score"] = 80
    if scenario == "too_many_items":
        estimate["items"] *= 51
    response_text = "not JSON" if scenario == "invalid" else json.dumps(estimate)
    generate = AsyncMock(return_value=SimpleNamespace(text=response_text))
    if scenario == "timeout":
        generate.side_effect = TimeoutError()
    provider_errors = {
        "quota": (429, "usage limit"),
        "bad_request": (400, "rejected the request"),
        "credentials": (401, "credentials are invalid"),
        "denied": (403, "access is denied"),
        "missing_model": (404, "configured analysis model"),
        "unavailable": (503, "temporarily unavailable"),
    }
    if scenario in provider_errors:
        generate.side_effect = nutrition.errors.APIError(
            provider_errors[scenario][0], {"error": {"message": "provider error"}}
        )

    class AsyncClient:
        models = SimpleNamespace(generate_content=generate)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

    monkeypatch.setattr(
        nutrition,
        "get_settings",
        lambda: SimpleNamespace(
            GOOGLE_GENERATIVE_AI_API_KEY="fixture-key",
            GEMINI_NUTRITION_MODEL="fixture-model",
        ),
    )
    monkeypatch.setattr(
        nutrition.genai, "Client", lambda **_: SimpleNamespace(aio=AsyncClient())
    )
    if expected != 200:
        with pytest.raises(HTTPException) as exc:
            await nutrition.analyze_image(image_bytes(), "after run")
        assert exc.value.status_code == expected
        if scenario in provider_errors:
            assert provider_errors[scenario][1] in exc.value.detail
    else:
        result = await nutrition.analyze_image(image_bytes(), "after run")
        assert result.total_calories == 195
        assert result.protein_g == 4
        assert generate.call_args.kwargs["model"] == "fixture-model"


def test_shared_schema_missing_activities_keeps_meals_available(client, monkeypatch):
    api, db = client
    nutrition.save_meal(db, USER, MealCreate(**payload()))
    original = db.table

    def table(name):
        if name == "activities":
            raise nutrition.APIError({"code": "PGRST205", "message": "missing table"})
        return original(name)

    monkeypatch.setattr(db, "table", table)
    result = api.get("/api/nutrition/daily?day=2026-10-07").json()
    assert result["total_calories"] == 195
    assert result["active_calories"] is result["net_energy"] is None


def test_legacy_incomplete_meal_values_remain_unknown(client):
    api, db = client
    db.rows["meal_plans"] = [
        {
            "log_id": str(uuid4()),
            "user_id": USER,
            "timestamp": "2026-10-07T04:00:00Z",
            "total_calories": 200,
            "food_items": [{"name": "Older food", "calories": None}],
        }
    ]
    result = api.get("/api/nutrition/daily?day=2026-10-07").json()
    assert result["total_calories"] == 200
    assert result["protein_g"] is None
    assert result["meals"][0]["items"][0]["estimated_weight_g"] is None


def test_save_id_collision_does_not_expose_another_users_meal(client):
    api, db = client
    body = payload()
    nutrition.save_meal(db, OTHER, MealCreate(**body))
    assert api.post("/api/nutrition/meals", json=body).status_code == 409
    assert len(db.rows["meal_plans"]) == 1


@pytest.mark.parametrize("code,status", [("23503", 409), ("PGRST202", 503)])
def test_missing_profile_or_migration_has_actionable_error(
    client, monkeypatch, code, status
):
    api, db = client

    def fail(*_):
        raise nutrition.APIError({"code": code, "message": "database setup missing"})

    monkeypatch.setattr(db, "rpc", fail)
    result = api.post("/api/nutrition/meals", json=payload())
    assert result.status_code == status


def test_calendar_targets_persist_and_are_user_scoped(client):
    api, db = client
    db.rows['nutrition_calorie_targets'] = [{'user_id': OTHER, 'date': '2026-10-11', 'target_calories': 999}]
    body = {'targets': [{'date': '2026-10-11', 'target_calories': 2200}, {'date': '2026-10-12', 'target_calories': 2400}]}
    assert api.put('/api/nutrition/targets', json=body).status_code == 200
    body['targets'][0]['target_calories'] = 2300
    assert api.put('/api/nutrition/targets', json={'targets': body['targets'][:1]}).status_code == 200
    days = api.get('/api/nutrition/calendar?start_date=2026-10-11&end_date=2026-10-17').json()
    assert len(days) == 7
    assert days[0]['target_calories'] == 2300
    assert days[1]['target_calories'] == 2400
    assert days[0]['target_source'] == 'saved'
    assert days[2]['target_calories'] is None
    assert days[0]['total_calories'] == 0
    assert db.rows['nutrition_calorie_targets'][0]['target_calories'] == 999
    assert len(db.rows['nutrition_calorie_targets']) == 3


@pytest.mark.parametrize('targets', [[], [{'date': 'invalid', 'target_calories': 2000}], [{'date': '2026-10-11', 'target_calories': value} for value in [2000, 2100]], *[[{'date': '2026-10-11', 'target_calories': value}] for value in [-1, 0, 1.5, 100001, '2000']]])
def test_calendar_rejects_invalid_targets(client, targets):
    api, _ = client
    assert api.put('/api/nutrition/targets', json={'targets': targets}).status_code == 422


def test_calendar_profile_estimate_and_local_intake(client):
    api, db = client
    db.rows['users'] = [{'user_id': USER, 'age': 33, 'weight': 70, 'height': 175, 'biological_sex': 'MALE', 'activity_level': 'SEDENTARY', 'fitness_goal': 'MAINTAIN'}]
    db.rows['meal_plans'] = [
        {'user_id': USER, 'timestamp': '2026-10-10T16:00:00+00:00', 'total_calories': 400},
        {'user_id': USER, 'timestamp': '2026-10-11T15:59:59.999999+00:00', 'total_calories': 100},
        {'user_id': USER, 'timestamp': '2026-10-11T16:00:00+00:00', 'total_calories': None},
        {'user_id': OTHER, 'timestamp': '2026-10-10T18:00:00+00:00', 'total_calories': 900},
    ]
    days = api.get('/api/nutrition/calendar?start_date=2026-10-11&end_date=2026-10-12&offset_minutes=480').json()
    assert days[0]['total_calories'] == 500
    assert days[0]['meal_count'] == 2
    assert days[1]['total_calories'] is None
    assert days[0]['target_calories'] == 1961
    assert days[0]['target_source'] == 'profile'
    assert api.get('/api/nutrition/calendar?start_date=2026-10-12&end_date=2026-10-11').status_code == 422
    assert api.get('/api/nutrition/calendar?start_date=2026-10-01&end_date=2026-11-01').status_code == 422


def test_calendar_requires_authentication():
    app = FastAPI()
    app.include_router(controller.router)
    with TestClient(app) as api:
        assert api.get('/api/nutrition/calendar?start_date=2026-10-11&end_date=2026-10-17').status_code in (401, 403)
        assert api.put('/api/nutrition/targets', json={'targets': [{'date': '2026-10-11', 'target_calories': 2200}]}).status_code in (401, 403)
