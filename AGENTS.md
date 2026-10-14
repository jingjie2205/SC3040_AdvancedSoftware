# AGENTS.md — Autonomous Coding Agent Directives & Guardrails

> **Purpose:** This file defines non-negotiable operational rules, coding standards, and architectural boundaries for autonomous AI coding agents (Claude Code, Cursor, Codex, Aider, Devin, Copilot Workspace, etc.) operating within this repository.

---

## 1. Core Operating Philosophy

1. **Simplicity Over Cleverness:** Prefer standard, idiomatic code over hyper-generalized abstractions. Write code for human maintainability first.
2. **Minimal Blast Radius:** Touch only the files strictly required to fulfill the prompt. Never perform unsolicited refactors, renames, or style reformatting outside the target scope.
3. **No Gratuitous Dependencies:** Never install a new third-party library or package if the problem can be solved cleanly with existing repository dependencies or standard language libraries.
4. **Zero AI Slop:** Reject defensive over-engineering, self-narrating comments, redundant type aliases, and speculative single-use abstraction layers.

---

## 2. Anti-Slop & Anti-Overengineering Rules

### A. Prohibited Code Patterns (Never Do This)
* **Single-use abstractions:** Do not create factories, builders, generic wrappers, or interface hierarchies for logic executed in only one place.
* **Speculative feature scaffolding:** Do not add parameters, interfaces, or config fields for "future extensibility" unless explicitly instructed.
* **Defensive try/catch abuse:** Do not blanket-wrap normal logic in empty or generic `try...catch` / `except` blocks that swallow errors or hide root causes.
* **Redundant type assertions:** In TypeScript/Python/Go, rely on type inference where clear. Avoid unnecessary manual casts (e.g., `as unknown as Type`) or excessive generic parameter chaining.
* **Boilerplate duplications:** Before writing a utility or helper function, search the repository (`src/utils`, `src/lib`, etc.) for existing implementations. Reuse them.

### B. Commenting & Documentation Hygiene
* **NO narrative comments:** Never write comments that merely restate what the code does (e.g., `// loop through users and filter active ones`).
* **NO AI self-attributions:** Never add comments like `// Added by AI Agent to fix bug X` or `// Auto-generated helper`.
* **Focus on "Why", Not "What":** Only add comments for non-obvious business logic, workarounds for known upstream bugs, or performance trade-offs.
* **Docstrings:** Keep function docstrings concise. Document edge cases, expected exceptions, and parameter semantics—do not write paragraphs explaining standard logic.

---

## 3. Workflow & Execution Loop

When given a task, execute strictly in this order:

┌─────────────────────────────────────────────────────────────┐
│ 1. Discovery & Search (Grep existing utilities, tests, types)│
├─────────────────────────────────────────────────────────────┤
│ 2. Minimal Edit (Target specific files, preserve conventions)│
├─────────────────────────────────────────────────────────────┤
│ 3. Automated Validation (Typecheck, Lint, Test execution)   │
├─────────────────────────────────────────────────────────────┤
│ 4. Diff Inspection & Self-Correction (Max 3 retry cycles)   │
├─────────────────────────────────────────────────────────────┤
│ 5. Structured Summary Generation (Files changed + rationale)│
└─────────────────────────────────────────────────────────────┘


### Self-Correction Limits
- If tests or linters fail, analyze the exact error message and apply targeted fixes.
- **Max Retry Budget:** You have a maximum of **3 automated retry cycles** to resolve build/test failures. If unresolved, revert changes, report the blocker, and request human guidance rather than churning erratic patches.

---

## 4. Architectural Boundaries & Safe Zones

| Path / Scope | Permission Level | Guidelines |
| :--- | :--- | :--- |
| `src/core/`, `src/domain/` | **Restricted** | Requires explicit prompt permission to change core domain logic or data models. |
| `src/features/`, `src/modules/` | **Standard** | Follow existing co-located directory structure (e.g., `components/`, `hooks/`, `tests/`). |
| `package.json`, `pnpm-lock.yaml`, `pyproject.toml` | **Guarded** | Never alter lockfiles manually. Never add dependencies without clear justification. |
| `.github/`, `infra/`, `Dockerfile` | **Strict / Read-Only** | Do not mutate CI/CD pipelines or infrastructure configurations unless explicitly requested. |

---

## 5. Code Quality & Formatting Checklist

Before reporting completion, verify that the following checks pass:

- [ ] **Type Safety:** Type-checker passes cleanly with zero warnings/errors (`tsc --noEmit`, `mypy --strict`, `cargo check`).
- [ ] **Linting & Formatting:** Linter and formatter pass without manual overrides (`ruff check`, `biome check`, `eslint`).
- [ ] **Test Coverage:** Added or modified logic is covered by automated unit/integration tests following the repository's testing pattern.
- [ ] **No Dead Code:** No unused variables, commented-out dead code blocks, or orphan imports remain.
- [ ] **Clean Git Diff:** `git diff` contains only minimal, relevant modifications.

---

## 6. Response & Commit Format

When presenting the completed task to the user:
1. **Summary:** 2–3 bullet points explaining the core change and design decisions.
2. **Impacted Files:** Explicit list of modified/created files.
3. **Verification Output:** Output showing successful test runs and lint passes.
4. **Commit Message Format:** Use Conventional Commits (`feat: ...`, `fix: ...`, `refactor: ...