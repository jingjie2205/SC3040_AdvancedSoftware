"""
Logging a workout earns XP on the leaderboard, through the helper the gamification feature provides for
other features (`award_xp`). The link is best effort: a workout that is saved must never fail to log
because the leaderboard's tables aren't there.
"""
import ast
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from postgrest.exceptions import APIError

from app.services.gamification import XP_REWARDS
from app.training import repository as repository_module
from app.training.errors import TrainingError
from app.training.models import GeneratePlanRequest, LogWorkoutInput, SessionResponseRequest
from app.training.planner import week_start
from app.training.readiness import RuleBasedScorer
from app.training.repository import SupabaseTrainingRepository
from app.training.service import TrainingService
from training_fakes import (
    STANDARD_PREFS,
    TODAY,
    USER_A,
    USER_B,
    FakeTrainingRepository,
    seed_history,
)

MONDAY = week_start(TODAY)


def api_error(code, message="boom"):
    return APIError({"message": message, "code": code, "hint": None, "details": None})


def with_plan(user=USER_A):
    repo = FakeTrainingRepository()
    service = TrainingService(repo, RuleBasedScorer())
    service.save_preferences(user, TODAY, STANDARD_PREFS)
    seed_history(repo, user, MONDAY)
    service.generate_plan(user, TODAY, GeneratePlanRequest(weeks=8))
    return service, repo


def entry(session=None, day=TODAY, minutes=40, volume=30):
    return LogWorkoutInput(date=day, activity_type=session.activity_type if session else "run",
                           actual_duration_min=minutes, actual_volume=session.target_volume if session else volume)


def todays_session(repo, user=USER_A):
    return repo.list_sessions(user, TODAY, TODAY)[0]


# ------------------------------------------------------------------ the service


def test_logging_a_planned_session_awards_xp_once_for_that_workout():
    service, repo = with_plan()
    session = todays_session(repo)
    result = service.log_session(USER_A, TODAY, session.id, entry(session))
    assert repo.xp_calls == [(USER_A, result.workout.id)]  # one call, not just one award
    assert repo.xp_awards == [(USER_A, result.workout.id)]


def test_logging_an_ad_hoc_session_awards_xp_too():
    service, repo = with_plan()
    result = service.log_ad_hoc_session(USER_A, TODAY, entry())
    assert repo.xp_calls == [(USER_A, result.workout.id)]
    assert repo.xp_awards == [(USER_A, result.workout.id)]


def test_every_workout_earns_its_own_award():
    service, repo = with_plan()
    first = service.log_ad_hoc_session(USER_A, TODAY, entry())
    second = service.log_ad_hoc_session(USER_A, TODAY, entry())
    assert [workout for _, workout in repo.xp_awards] == [first.workout.id, second.workout.id]


def test_the_award_goes_to_the_user_who_logged_the_workout():
    service, repo = with_plan(USER_A)
    service.save_preferences(USER_B, TODAY, STANDARD_PREFS)
    result = service.log_ad_hoc_session(USER_B, TODAY, entry())
    assert repo.xp_awards == [(USER_B, result.workout.id)]


@pytest.mark.parametrize("failure", [RuntimeError("down"), api_error("42501"), TimeoutError()])
def test_a_failure_awarding_xp_never_fails_the_log_and_the_workout_is_still_saved(failure, caplog):
    service, repo = with_plan()
    repo.xp_error = failure
    session = todays_session(repo)
    with caplog.at_level("WARNING"):
        result = service.log_session(USER_A, TODAY, session.id, entry(session))
    assert result.workout.id in {w.id for _, w in repo.workouts.values()}
    assert repo.get_session(USER_A, session.id).status == "completed"
    assert repo.xp_awards == []
    assert "XP for a logged workout wasn't recorded" in caplog.text


def test_nothing_is_awarded_when_the_log_is_refused():
    service, repo = with_plan()
    session = todays_session(repo)
    service.log_session(USER_A, TODAY, session.id, entry(session))
    before = list(repo.xp_calls)
    with pytest.raises(TrainingError):
        service.log_session(USER_A, TODAY, session.id, entry(session))  # already logged
    with pytest.raises(TrainingError):
        service.log_ad_hoc_session(USER_A, TODAY, entry(day=TODAY + timedelta(days=1)))  # in the future
    with pytest.raises(TrainingError):
        service.log_session(USER_A, TODAY, "not-a-session", entry())  # no such session
    assert repo.xp_calls == before and len(before) == 1


def test_only_logging_a_workout_awards_xp():
    service, repo = with_plan()
    session = todays_session(repo)
    service.get_today(USER_A, TODAY)
    service.get_summary(USER_A, TODAY)
    service.respond_to_session(USER_A, TODAY, session.id, SessionResponseRequest(action="accept"))
    service.recalculate_plan(USER_A, TODAY)
    assert repo.xp_calls == [] and repo.xp_awards == []


# ------------------------------------------------------------------ the real helper, against a fake of her database function


WORKOUT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER_WORKOUT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


class XpFunctionClient:
    """
    Stands in for award_gamification_xp (supabase/migrations/20261009120000_gamification_xp_sources.sql):
    one XP event per (user, source, source_id), and a running total per user. `error` fails every call.
    """

    def __init__(self, error=None):
        self.error, self.events, self.totals = error, [], {}

    def rpc(self, name, params):
        return SimpleNamespace(execute=lambda: self._call(name, params))

    def _call(self, name, params):
        if self.error:
            raise self.error
        assert name == "award_gamification_xp"
        user, source, source_id = params["p_user_id"], params["p_source"], params["p_source_id"]
        if (user, source, source_id) not in {(e["user_id"], e["source"], e["source_id"]) for e in self.events}:
            self.events.append({"user_id": user, "source": source, "source_id": source_id, "amount": params["p_amount"]})
            self.totals[user] = self.totals.get(user, 0) + params["p_amount"]
        return SimpleNamespace(data=self.totals.get(user, 0))


def real_helper():
    client = XpFunctionClient()
    return SupabaseTrainingRepository(client), client


def test_the_real_helper_records_a_workout_event_with_the_workout_id_and_adds_the_xp():
    repo, client = real_helper()
    repo.award_workout_xp(USER_A, WORKOUT)
    assert client.events == [
        {"user_id": USER_A, "source": "workout", "source_id": WORKOUT, "amount": XP_REWARDS["workout"]}
    ]
    assert client.totals == {USER_A: XP_REWARDS["workout"]}


def test_awarding_the_same_workout_twice_counts_once():
    repo, client = real_helper()
    repo.award_workout_xp(USER_A, WORKOUT)
    repo.award_workout_xp(USER_A, WORKOUT)
    assert len(client.events) == 1
    assert client.totals == {USER_A: XP_REWARDS["workout"]}


def test_two_workouts_add_up_and_each_user_has_their_own_total():
    repo, client = real_helper()
    repo.award_workout_xp(USER_A, WORKOUT)
    repo.award_workout_xp(USER_A, OTHER_WORKOUT)
    repo.award_workout_xp(USER_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    assert client.totals == {USER_A: 2 * XP_REWARDS["workout"], USER_B: XP_REWARDS["workout"]}


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST204", "PGRST205"])
def test_a_database_without_the_leaderboard_tables_awards_nothing_and_says_so_once(code, caplog):
    repo = SupabaseTrainingRepository(XpFunctionClient(error=api_error(code)))
    with caplog.at_level("WARNING"):
        repo.award_workout_xp(USER_A, WORKOUT)
        repo.award_workout_xp(USER_B, OTHER_WORKOUT)
    assert caplog.text.count(code) == 1


def test_any_other_database_error_is_left_for_the_service_to_log():
    repo = SupabaseTrainingRepository(XpFunctionClient(error=api_error("42501")))
    with pytest.raises(APIError):
        repo.award_workout_xp(USER_A, WORKOUT)


def test_the_training_package_stays_importable_without_the_gamification_module():
    """The link is a lazy import inside the method, so a problem there can't stop the training routes loading."""
    tree = ast.parse(Path(repository_module.__file__).read_text(encoding="utf-8"))
    top_level = {node.module for node in tree.body if isinstance(node, ast.ImportFrom) and node.module}
    assert not any("gamification" in (module or "") for module in top_level)
