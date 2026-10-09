"""
Hard Rule 1: Strava data is for display only. It must never reach an AI feature, which here means never
reach the readiness score, the plan or the coach.

The training page's Strava tab shows activities straight from the Strava routes, and these tests pin that it
stays that way, by what each piece is allowed to import:

- the training backend never imports Strava code;
- the training API client, and every other part of the training page, never imports the Strava tab's modules
  (the client feeds Home, readiness and the coach);
- the Strava tab's own modules import only a short, fixed list, and never the training API client.

Adding an import to any of them fails a test until the change is deliberate. The filter that drops Strava
rows from the modelling inputs is tested in test_training_readiness.py and test_training_planner.py.
"""
import ast
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
TRAINING_PACKAGE = REPO / "backend" / "app" / "training"
LIB = REPO / "frontend" / "lib" / "training"
COMPONENTS = REPO / "frontend" / "app" / "(app)" / "dashboard" / "training" / "_components"

STRAVA_LIB_FILES = {"strava.ts", "strava-format.ts"}
STRAVA_PANEL = COMPONENTS / "strava-panel.tsx"

# What each of the Strava tab's files may import, and nothing else.
ALLOWED_IMPORTS = {
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

frontend_present = pytest.mark.skipif(not LIB.exists(), reason="frontend not present")

# import x from "m", import { x } from "m" (also across lines), import "m", and import("m")
IMPORT = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']""")


def ts_imports(path: Path) -> set:
    return set(IMPORT.findall(path.read_text(encoding="utf-8")))


def names_strava(specifier: str) -> bool:
    """True for "./strava", "@/lib/training/strava-format" and the like."""
    return specifier.rsplit("/", 1)[-1] in {"strava", "strava-format"}


def python_imports(path: Path) -> set:
    found = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            found.add("." * node.level + (node.module or ""))
            found.update(alias.name for alias in node.names)
    return found


# ------------------------------------------------------------------ the backend


def training_modules():
    return sorted(TRAINING_PACKAGE.rglob("*.py"))


def test_the_check_really_covers_the_training_backend():
    assert len(training_modules()) > 10  # a wrong path would make every test below pass for nothing


@pytest.mark.parametrize("path", training_modules(), ids=lambda p: p.relative_to(TRAINING_PACKAGE).as_posix())
def test_the_training_backend_never_imports_strava_code(path):
    assert not [name for name in python_imports(path) if "strava" in name.lower()]


# ------------------------------------------------------------------ the page


@frontend_present
def test_the_check_really_covers_the_training_page():
    assert STRAVA_PANEL.exists() and all((LIB / name).exists() for name in STRAVA_LIB_FILES)
    assert len(list(LIB.glob("*.ts"))) > 8 and len(list(COMPONENTS.glob("*.tsx"))) > 6


@frontend_present
@pytest.mark.parametrize(
    "path",
    sorted(p for p in LIB.glob("*.ts") if p.name not in STRAVA_LIB_FILES),
    ids=lambda p: f"lib/{p.name}",
)
def test_the_training_api_client_never_imports_the_strava_modules(path):
    assert not [name for name in ts_imports(path) if names_strava(name)]


@frontend_present
@pytest.mark.parametrize(
    "path",
    sorted(p for p in COMPONENTS.glob("*.tsx") if p != STRAVA_PANEL),
    ids=lambda p: f"components/{p.name}",
)
def test_no_other_part_of_the_training_page_imports_the_strava_modules(path):
    assert not [name for name in ts_imports(path) if names_strava(name)]


@frontend_present
@pytest.mark.parametrize("path", sorted(ALLOWED_IMPORTS), ids=lambda p: p.name)
def test_the_strava_tab_imports_only_what_it_is_allowed_to(path):
    extra = ts_imports(path) - ALLOWED_IMPORTS[path]
    assert not extra, f"{path.name} now imports {sorted(extra)}; if that is deliberate, say why in this test"


@frontend_present
def test_the_strava_client_borrows_nothing_but_the_request_headers():
    source = (LIB / "strava.ts").read_text(encoding="utf-8")
    borrowed = re.findall(r"import\s*\{([^}]*)\}\s*from\s*[\"']\./http-api[\"']", source)
    assert [names.strip() for names in borrowed] == ["buildHeaders"]
