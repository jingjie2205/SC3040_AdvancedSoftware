# FITRA — Two-Tier Smart nutritional and training platform.

> 1. **Frontend (`frontend/`):** Next.js 15+ App Router, React 19, TypeScript, Tailwind CSS
> 2. **Backend (`backend/`):** Python FastAPI, Google Gemini 3.8 for AI coaching, Supabase for database management.

---

## Overview

Fitra is an intelligent, full-stack web application designed to assist users in managing their personal health, fitness and nutrition. By centralising biological health data, manual inputs, and external athletic telemetry, the system leverages Artificial Intelligence (AI) & data analytics to generate dynamic training schedules, automate dietary tracking, and deliver personalised contextual coaching based on daily readiness

---

## Tech Stack

| Service             | Technologies                                                          |
| :------------------ | :-------------------------------------------------------------------- |
| **Frontend**        | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, Recharts |
| **Backend**         | Python 3.12, FastAPI, Uvicorn, Pydantic, NumPy, HTTPX, PyJWT          |
| **Database & Auth** | Supabase (PostgreSQL with Row Level Security)                         |
| **AI / LLM**        | Google Gemini 3.8 Flash via `google-genai`                            |
| **Activity Source** | Strava V3 API                                                         |

---

## Manual Local Development

### 1. Backend Setup (FastAPI)

```bash
cd backend

# Install Python dependencies
pip install -r requirements.txt

# Start development server with hot reloading
uvicorn app.main:app --reload --port 8000
```

### 2. Frontend Setup (Next.js 15)

```bash
cd frontend

# Install Node dependencies
npm install

# Start Next.js development server
npm run dev
```

---

## Tests

### Frontend — Vitest

Run all frontend tests and generate a coverage report:

```powershell
cd "frontend"
npm run test:coverage
```

Run individual page test with coverage:

```powershell
npm exec vitest run --coverage "tests/foldername/testname.test.tsx"
```

The HTML report is generated at `frontend/coverage/index.html`. Open it from
the `frontend` directory with:

```powershell
Start-Process ".\coverage\index.html"
```

### Backend — Pytest

Use Python 3.11 or newer. From a fresh checkout, create an environment and
install the backend requirements before running tests:

```powershell
cd "backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade -r requirements.txt
python -m pip check
python -m pip install pytest-cov
```

Tests use placeholder Supabase settings and mocked services; no `.env`, API
keys, or running database is required. A Git pull does not update installed
packages. If the HEIF test reports `HeifImageFile` has no attribute `_im`, update
the requirements in the same Python environment used to run pytest. Pillow
10.4.0 with pillow-heif 1.8.1 reproduces that error; a clean installation with
Pillow 13.0.0 and pillow-heif 1.8.1 passes.

Run all the backend tests and generate terminal and HTML coverage
reports:

```powershell
python -m pytest tests/ `
  --cov=app `
  --cov-report=term-missing `
  --cov-report=html:htmlcov
```

Run individual backend test with coverage:

```powershell
python -m pytest tests/foldername/testname.py `
  --cov=app `
  --cov-report=term-missing `
  --cov-report=html:htmlcov
```

The HTML report is generated at `backend/htmlcov/index.html`. Open it from the
`backend` directory with:

```powershell
Start-Process ".\htmlcov\index.html"
```
