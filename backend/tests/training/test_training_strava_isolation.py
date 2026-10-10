"""
Hard Rule 1: Strava data never reaches an AI feature, which here means never reaches the readiness score, the
plan, the summary or the coach.

Activities saved from Strava sit in the training log beside the athlete's own, flagged source = "strava". These
tests pin that they stay out of every calculation, in three ways:

- by behaviour: with a pile of saved Strava logs in the log, the plan, the readiness score, the summary and the
  coach's prompt come out exactly as they do without them, while the schedule still shows them;
- by who may touch Strava: only `strava_sync.py` (and the router that serves it) imports Strava code or writes a
  Strava log, and the package installer is the only thing that mounts that router;
- on the page: the training API client and every other part of the page never import the Strava modules, and the
  Strava tab's own files import only a short, fixed list (in particular never the training API client).

Adding an import to any of them fails a test until the change is deliberate. The filter itself is also tested
where it lives, in test_training_readiness.py and test_training_planner.py.
"""
import ast
import re
from datetime import timedelta
from pathlib import Path

import pytest

from app.training.models import GeneratePlanRequest
from app.training.planner import week_start
from app.training.readiness import RuleBasedScorer
from app.training.service import TrainingService
from training_fakes import STANDARD_PREFS, TODAY, USER_A, FakeTrainingRepository, seed_history, workout

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "backend" / "app"
TRAINING_PACKAGE = APP / "training"
LIB = REPO / "frontend" / "lib" / "training"
COMPONENTS = REPO / "frontend" / "app" / "(app)" / "dashboard" / "training" / "_components"

SYNC_MODULE = TRAINING_PACKAGE / "strava_sync.py"
SYNC_ROUTER = TRAINING_PACKAGE / "strava_router.py"
PACKAGE_INIT = TRAINING_PACKAGE / "__init__.py"
STRAVA_BACKEND_FILES = {SYNC_MODULE, SYNC_ROUTER, PACKAGE_INIT}

STRAVA_LIB_FILES = {"strava.ts", "strava-format.ts"}
STRAVA_PANEL = COMPONENTS / "strava-panel.tsx"

# What each of the Strava tab's files may import, and nothing else. Type-only imports are listed apart:
# they are erased at build time, so they couple nothing at run time.
ALLOWED_VALUE_IMPORTS = {
    LIB / "strava-format.ts": set(),
    LIB / "strava.ts": {"./http-api", "./strava-format"},
    STRAVA_PANEL: {
        "react",
        "next/link",
        "lucide-react",
        "@/lib/training/dates",
        "@/lib/training/strava",
        "@/lib/training/strava-format",
        "./ui",
    },
}
ALLOWED_TYPE_IMPORTS = {
    LIB / "strava-format.ts": set(),
    LIB / "strava.ts": {"./api", "./strava-format"},
    STRAVA_PANEL: {"@/lib/training/strava-format"},
}

frontend_present = pytest.mark.skipif(not LIB.exists(), reason="frontend not present")

STATEMENT = re.compile(r"""^\s*import\s+(type\s+)?([^"';]*?)\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']""", re.M)
DYNAMIC = re.compile(r"""\bimport\s*\(\s*["']([^"']+)["']\s*\)""")


def ts_imports(path: Path) -> list:
    """Every import in a TypeScript file as (is_type_only, module), including side-effect and dynamic ones."""
    text = path.read_text(encoding="utf-8")
    found = []
    for match in STATEMENT.finditer(text):
        found.append((bool(match.group(1)), match.group(3) or match.group(4)))
    found.extend((False, module) for module in DYNAMIC.findall(text))
    return found


def modules(path: Path, *, types: bool) -> set:
    return {module for is_type, module in ts_imports(path) if is_type == types}


def names_strava(specifier: str) -> bool:
    """True for "./strava", "@/lib/training/strava-format" and the like."""
    return specifier.rsplit("/", 1)[-1] in {"strava", "strava-format"}


def python_modules(path: Path) -> set:
    """Every module a Python file imports from, as written (relative ones keep their dots)."""
    found = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            found.add("." * node.level + (node.module or ""))
    return found


def python_names(path: Path, module: str) -> set:
    """The names a file imports with `from <module> import ...`."""
    wanted = module.lstrip(".")
    level = len(module) - len(wanted)
    return {
        alias.name
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.ImportFrom) and node.level == level and (node.module or "") == wanted
        for alias in node.names
    }


STRAVA_MODULE_NAMES = {"strava", "strava_sync", "strava_router", "strava_service"}


def touches_strava(path: Path) -> list:
    """Imports of Strava code: any module path with 'strava' in it, or `from x import strava`."""
    modules_named = {m for m in python_modules(path) if "strava" in m.lower()}
    names_imported = {
        alias.name
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
        if alias.name in STRAVA_MODULE_NAMES
    }
    return sorted(modules_named | names_imported)


# ------------------------------------------------------------------ by behaviour

MONDAY = week_start(TODAY)


class RecordingCoach:
    """Stands in for Gemini and keeps every prompt it was sent."""

    model = "test"

    def __init__(self):
        self.prompts = []

    def complete(self, system, prompt):
        self.prompts.append(prompt)
        return "Keep it easy today."


def service_with(strava_logs: int):
    repo = FakeTrainingRepository()
    coach = RecordingCoach()
    service = TrainingService(repo, RuleBasedScorer(), coach=coach, clock=lambda: 1000.0)
    service.save_preferences(USER_A, TODAY, STANDARD_PREFS)
    seed_history(repo, USER_A, MONDAY)
    for back in range(strava_logs):  # one a day, every day, today included, deliberately huge and intense
        log = workout(TODAY - timedelta(days=back), volume=500, avg_hr=195, source="strava", wid=f"strava-{back}")
        log = log.model_copy(update={"external_id": str(9000 + back), "activity_type": "cycling", "actual_duration_min": 240})
        repo.workouts[log.id] = (USER_A, log)
    return service, repo, coach


def what_the_user_is_told(service, repo, coach):
    plan = service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    sessions = [(s.date, s.activity_type, s.target_volume, s.target_duration_min, s.intensity_band)
                for s in repo.list_sessions(USER_A, plan.start_date, plan.end_date)]
    today = service.get_today(USER_A, TODAY)
    summary = service.get_summary(USER_A, TODAY)
    service.get_coach_message(USER_A, TODAY)
    adapted = service.recalculate_plan(USER_A, TODAY)
    return {
        "baseline": plan.baseline_volume,
        "sessions": sessions,
        "readiness": (today.readiness.score, today.readiness.classification,
                      [(f.key, f.impact, f.detail) for f in today.readiness.factors]),
        "recommendation": today.recommendation.model_dump() if today.recommendation else None,
        # the ids are made up fresh on every run, so they are left out of the comparison and nothing else is
        "summary": summary.model_dump(exclude={"readiness": True, "today": {"session": {"id", "plan_id"}}}),
        "summary_readiness": (summary.readiness.score, summary.readiness.classification) if summary.readiness else None,
        "coach_prompts": list(coach.prompts),
        "baseline_after_adapting": adapted.baseline_volume,
    }


def test_saved_strava_logs_change_nothing_the_plan_readiness_summary_or_coach_say():
    without = what_the_user_is_told(*service_with(0))
    with_strava = what_the_user_is_told(*service_with(40))
    assert with_strava == without
    assert without["coach_prompts"] and without["baseline"] > 0, "the comparison must really have computed things"


def test_the_schedule_does_show_them():
    """They are saved to be seen: the display path reads every log, and only the calculations drop Strava's."""
    service, repo, _ = service_with(5)
    shown = service.get_schedule(USER_A, TODAY, TODAY - timedelta(days=10), TODAY)
    assert sorted(w.external_id for w in shown.workouts if w.source == "strava") == [str(9000 + n) for n in range(5)]
    assert all(w.planned_session_id is None for w in shown.workouts if w.source == "strava")


def test_a_strava_log_never_completes_a_planned_session_or_counts_as_missed_work_done():
    service, repo, _ = service_with(40)
    service.generate_plan(USER_A, TODAY, GeneratePlanRequest(weeks=8))
    service.get_summary(USER_A, TODAY)  # reading brings the plan up to date: overdue sessions become missed
    statuses = {s.status for s in repo.list_sessions(USER_A, MONDAY, MONDAY + timedelta(days=6))}
    assert "completed" not in statuses and "partial" not in statuses


# ------------------------------------------------------------------ the backend


def training_modules():
    return sorted(TRAINING_PACKAGE.rglob("*.py"))


def test_the_checks_really_cover_the_training_backend():
    assert len(training_modules()) > 12  # a wrong path would make every test below pass for nothing
    assert STRAVA_BACKEND_FILES <= set(training_modules())


@pytest.mark.parametrize(
    "path",
    [p for p in training_modules() if p not in STRAVA_BACKEND_FILES],
    ids=lambda p: p.relative_to(TRAINING_PACKAGE).as_posix(),
)
def test_no_other_training_module_imports_anything_to_do_with_strava(path):
    assert touches_strava(path) == []


def test_the_package_installer_mounts_the_strava_router_and_nothing_more_of_it():
    assert touches_strava(PACKAGE_INIT) == [".strava_router"]


def test_the_strava_router_reaches_strava_only_through_the_sync_module():
    assert touches_strava(SYNC_ROUTER) == [".strava_sync"]
    assert not [m for m in python_modules(SYNC_ROUTER) if m.startswith("..services")], (
        "the router must not touch the team's Strava service"
    )


def test_the_sync_module_imports_only_what_it_needs_from_the_rest_of_the_package():
    relative = {module for module in python_modules(SYNC_MODULE) if module.startswith(".")}
    assert relative == {".config", ".errors", ".models", ".repository", "..services"}, (
        f"strava_sync.py now imports {sorted(relative)}: it must stay clear of the service (which awards XP), the "
        "readiness code, the planner and the coach"
    )
    assert python_names(SYNC_MODULE, "..services") == {"strava"}, "from the team's services it takes the Strava one only"


def test_only_the_sync_module_writes_a_strava_log():
    writers = sorted(
        p.relative_to(APP).as_posix()
        for p in APP.rglob("*.py")
        if re.search(r"""\bsource\s*=\s*["']strava["']|["']source["']\s*:\s*["']strava["']""", p.read_text(encoding="utf-8"))
    )
    assert writers == ["training/strava_sync.py"]


def test_the_sync_module_writes_only_to_the_training_log_and_never_the_teams_activity_tables():
    source = SYNC_MODULE.read_text(encoding="utf-8")
    assert re.search(r'^TABLE = "training_workout_logs"$', source, re.M)
    assert set(re.findall(r"""\.table\(\s*["']([a-z_]+)["']""", source)) <= {"users"}, "other literal table names"


# ------------------------------------------------------------------ the page


@frontend_present
def test_the_checks_really_cover_the_training_page():
    assert STRAVA_PANEL.exists() and all((LIB / name).exists() for name in STRAVA_LIB_FILES)
    assert len(list(LIB.glob("*.ts"))) > 8 and len(list(COMPONENTS.glob("*.tsx"))) > 6


@frontend_present
@pytest.mark.parametrize(
    "path",
    sorted(p for p in LIB.glob("*.ts") if p.name not in STRAVA_LIB_FILES),
    ids=lambda p: f"lib/{p.name}",
)
def test_the_training_api_client_never_imports_the_strava_modules(path):
    assert not [module for _, module in ts_imports(path) if names_strava(module)]


@frontend_present
@pytest.mark.parametrize(
    "path",
    sorted(p for p in COMPONENTS.glob("*.tsx") if p != STRAVA_PANEL),
    ids=lambda p: f"components/{p.name}",
)
def test_no_other_part_of_the_training_page_imports_the_strava_modules(path):
    assert not [module for _, module in ts_imports(path) if names_strava(module)]


@frontend_present
@pytest.mark.parametrize("path", sorted(ALLOWED_VALUE_IMPORTS), ids=lambda p: p.name)
def test_the_strava_tab_imports_only_what_it_is_allowed_to(path):
    extra_values = modules(path, types=False) - ALLOWED_VALUE_IMPORTS[path]
    extra_types = modules(path, types=True) - ALLOWED_TYPE_IMPORTS[path]
    assert not extra_values and not extra_types, (
        f"{path.name} now imports {sorted(extra_values | extra_types)}; if that is deliberate, say why in this test"
    )


@frontend_present
def test_the_strava_client_borrows_nothing_but_the_request_helper():
    source = (LIB / "strava.ts").read_text(encoding="utf-8")
    borrowed = re.findall(r"import\s*\{([^}]*)\}\s*from\s*[\"']\./http-api[\"']", source)
    assert [names.strip() for names in borrowed] == ["request"]


@frontend_present
def test_the_checks_notice_each_kind_of_import(tmp_path):
    sample = tmp_path / "sample.ts"
    sample.write_text(
        'import a from "./one";\n'
        'import { b,\n  c } from "./two";\n'
        'import type { D } from "./three";\n'
        'import "./four";\n'
        'const x = await import("./five");\n',
        encoding="utf-8",
    )
    assert modules(sample, types=False) == {"./one", "./two", "./four", "./five"}
    assert modules(sample, types=True) == {"./three"}


# ------------------------------------------------------------------ the database

# The gamification code pays 50 XP from a trigger on training_workout_logs for every row inserted, whatever its
# source. A saved Strava activity is shown on the schedule and isn't a workout the athlete logged, so the function
# behind that trigger has to skip it, or "Save all" pays up to 5,000 XP and saving again pays again. The behaviour
# was rehearsed on a throwaway Postgres loaded with the real migrations; this keeps a later migration from quietly
# putting the function back the way it was.
MIGRATIONS = REPO / "supabase" / "migrations"
XP_TRIGGER_FUNCTION = re.compile(
    r"CREATE OR REPLACE FUNCTION public\.gamification_award_logged_activity\(\).*?\n\$\$;", re.S | re.I
)
STRAVA_XP_GUARD = re.compile(r"IF\s+NEW\.source\s*=\s*'strava'\s+THEN\s+RETURN\s+NEW;\s+END\s+IF;", re.I)
WORKOUT_GETS_AN_AMOUNT = re.compile(r"item_source\s*:=\s*'workout'", re.I)

migrations_present = pytest.mark.skipif(not MIGRATIONS.exists(), reason="migrations not present")


def newest_xp_trigger_definition() -> tuple:
    """(file name, text) of the last migration, in the order a fresh install runs them, that defines the function."""
    found = [
        (path.name, match.group(0))
        for path in sorted(MIGRATIONS.glob("*.sql"))
        for match in XP_TRIGGER_FUNCTION.finditer(path.read_text(encoding="utf-8"))
    ]
    assert found, "no migration defines gamification_award_logged_activity() any more: update this check"
    return found[-1]


def pays_nothing_for_strava(definition: str) -> bool:
    """The guard is there, and it comes before the workout is given an amount to earn."""
    guard, amount = STRAVA_XP_GUARD.search(definition), WORKOUT_GETS_AN_AMOUNT.search(definition)
    return bool(guard and amount and guard.start() < amount.start())


@migrations_present
def test_the_newest_definition_of_the_workout_xp_trigger_pays_nothing_for_a_strava_log():
    name, definition = newest_xp_trigger_definition()
    assert pays_nothing_for_strava(definition), (
        f"{name} defines gamification_award_logged_activity() without the early return for source = 'strava'. "
        "Saved Strava activities would earn 50 XP each. Keep the guard from 20261011100000_gamification_skip_strava_xp.sql"
    )


def test_the_xp_guard_check_notices_a_missing_misplaced_or_wrong_guard():
    guarded = (
        "IF TG_TABLE_NAME = 'training_workout_logs' THEN\n"
        "    IF NEW.source = 'strava' THEN\n        RETURN NEW;\n    END IF;\n"
        "    item_source := 'workout'; item_id := NEW.id; item_amount := 50;\n"
        "END IF;"
    )
    assert pays_nothing_for_strava(guarded)
    assert not pays_nothing_for_strava(guarded.replace("IF NEW.source = 'strava' THEN\n        RETURN NEW;\n    END IF;", ""))
    assert not pays_nothing_for_strava(guarded.replace("'strava'", "'manual'"))
    assert not pays_nothing_for_strava(
        "item_source := 'workout';\nIF NEW.source = 'strava' THEN RETURN NEW; END IF;"
    ), "a guard after the workout is given an amount protects nothing"
