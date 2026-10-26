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

Install the coverage plugin once if it is not already available:

```powershell
cd "backend"
python -m pip install pytest-cov
```

Run the backend tests and generate terminal and HTML coverage
reports:

```powershell
python -m pytest tests/dashboard/test_dashboard.py `
  --cov=app `
  --cov-report=term-missing `
  --cov-report=html:htmlcov
```

The HTML report is generated at `backend/htmlcov/index.html`. Open it from the
`backend` directory with:

```powershell
Start-Process ".\htmlcov\index.html"
```
