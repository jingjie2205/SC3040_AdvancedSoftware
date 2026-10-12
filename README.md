# FITRA — Two-Tier Endurance Intelligence & Recovery Platform

> **FITRA** is a smart platform for tracking your nutritional intake and training progress.
>
> 1. **Frontend (`frontend/`):** Next.js 15+ App Router, React 19, TypeScript, Tailwind CSS
> 2. **Backend (`backend/`):** Python FastAPI, Google Gemini 2.5 for AI coaching, Supabase for database management.

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
| **AI / LLM**        | Google Gemini 2.5 Flash via `google-genai`                            |
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
