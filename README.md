# FITRA — Two-Tier Endurance Intelligence & Recovery Platform

> **FITRA** is a production-grade, two-tier endurance training analytics and recovery platform:
> 1. **Frontend (`frontend/`):** Next.js 15+ App Router, React 19, TypeScript, Tailwind CSS, and Recharts delivering real-time workload matrixes, cardiac drift curves, and AI coaching summaries.
> 2. **Backend (`backend/`):** Python FastAPI service powered by NumPy-vectorized Banister TRIMP & ACWR physiological modeling, an integrated Redis task consumer, and Google Gemini 2.5 Flash recovery synthesis.

---

## 📑 Table of Contents

- [Overview](#overview)
- [Two-Tier System Architecture](#two-tier-system-architecture)
- [Directory Structure](#directory-structure)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Quickstart with Docker Compose](#quickstart-with-docker-compose)
- [Manual Local Development](#manual-local-development)
  - [1. Backend Setup (FastAPI & Redis)](#1-backend-setup-fastapi--redis)
  - [2. Frontend Setup (Next.js 15)](#2-frontend-setup-nextjs-15)
  - [3. Database Setup (Supabase)](#3-database-setup-supabase)
- [API Endpoints Reference](#api-endpoints-reference)
- [Physiological Models](#physiological-models)

---

## Overview

Endurance athletes walk a fine line between fitness gains and overtraining injuries. **FITRA** automates physiological analysis and recovery prescription:
- **Inbound Webhooks:** Strava activity events are accepted and queued into Redis in milliseconds.
- **Vectorized Telemetry Processing:** High-frequency heart rate and time streams are processed using NumPy vectorization for Banister's TRIMP.
- **Acute:Chronic Workload Ratio (ACWR):** 7-day fatigue vs. 28-day fitness rolling averages isolate overreaching and injury risk zones.
- **Google Gemini 2.5 Flash:** Generates structured workout recommendations with detailed sports-science rationales.

---

## Two-Tier System Architecture

```text
+-------------------------------------------------------------------------------+
|                               Browser / Client                                |
+---------------------------------------+---------------------------------------+
                                        |
                   +--------------------+--------------------+
                   |                                         |
                   v                                         v
+------------------------------------+    +------------------------------------+
|         Frontend Service           |    |          Backend Service           |
|            (frontend/)             |    |             (backend/)             |
|   Next.js 15 App Router (Port 3000)|    |       FastAPI (Port 8000)          |
|   - Athlete Analytics Dashboard    |    |   - Strava Webhook Verification    |
|   - Recharts Visualizations        |    |   - NumPy TRIMP & ACWR Engine      |
|   - Supabase Auth Integration      |    |   - Google Gemini 2.5 Flash Coach  |
+------------------+-----------------+    +------------------+-----------------+
                   |                                         |
                   | (Bearer JWT)                            | (Pushes / Pops)
                   +--------------------->                   v
                                          +------------------------------------+
                                          |            Redis Queue             |
                                          |            (Port 6379)             |
                                          |     Asynchronous Activity Worker   |
                                          +------------------+-----------------+
                                                             |
                                                             | (Persists Records)
                                                             v
+-------------------------------------------------------------------------------+
|                            Supabase Cloud (PostgreSQL)                        |
|                  RLS Policies, Athlete Profiles, Activities, Loads            |
+-------------------------------------------------------------------------------+
```

---

## Directory Structure

```text
.
├── docker-compose.yml          # Orchestrates frontend, backend, and redis
├── .env.example                # Unified environment variable template
├── README.md                   # System documentation and setup guide
├── frontend/
│   ├── app/
│   │   ├── layout.tsx          # Root Next.js layout and typography
│   │   ├── page.tsx            # Marketing and product landing page
│   │   ├── (auth)/login/       # Athlete sign-in with Supabase Auth
│   │   └── dashboard/          # Real-time TRIMP & ACWR load matrix
│   ├── lib/
│   │   ├── api.ts              # Type-safe client for FastAPI backend
│   │   └── supabase/           # Supabase client instances (SSR, Admin)
│   ├── Dockerfile              # Multi-stage standalone Next.js container
│   ├── package.json            # Node.js dependencies
│   └── tsconfig.json           # TypeScript configuration
├── backend/
│   ├── app/
│   │   ├── __init__.py         # Package entrypoint
│   │   ├── main.py             # FastAPI app, routes, and lifespan worker
│   │   ├── config.py           # Pydantic Settings environment configuration
│   │   ├── calculations.py     # NumPy-vectorized TRIMP, HR zones, and ACWR
│   │   ├── strava.py           # Strava OAuth token rotation & stream client
│   │   ├── worker.py           # Redis activity queue consumer & pipeline
│   │   └── coach.py            # Google Gemini 2.5 Flash recovery synthesis
│   ├── tests/
│   │   ├── test_calculations.py# Unit tests for physiological modeling
│   │   └── test_api.py         # Unit tests for FastAPI endpoints
│   ├── Dockerfile              # Python 3.12-slim production container
│   └── requirements.txt        # Python backend dependencies
└── supabase/
    └── schema.sql              # PostgreSQL tables, indexes, and RLS policies
```

---

## Key Features

- **Meal analysis and food logging:** Upload a meal photo, review ingredients and portions, and save daily nutrition totals at `/dashboard/nutrition`. See [Meal analysis setup](docs/meal-analysis-setup.md) for API keys, the database migration, and integration requirements.

- **Decoupled Two-Tier Design:** Clear separation of concerns between UI presentation and heavy scientific/AI computing.
- **NumPy Vectorization:** Replaces iterative telemetry loops with vectorized array calculations, dramatically accelerating TRIMP scoring.
- **Asynchronous Task Queue:** Built-in Redis queue and consumer pipeline ensures webhook ingestion satisfies Strava's strict 2-second timeout.
- **Google Gemini 2.5 Flash:** Employs the modern `google-genai` SDK with strict Pydantic schemas for structured workout and recovery protocols.
- **Resilient Fallback Modes:** Deterministic offline heuristics allow testing and evaluation even when external API keys are omitted.

---

## Tech Stack

| Service | Technologies |
| :--- | :--- |
| **Frontend** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, Recharts |
| **Backend** | Python 3.12, FastAPI, Uvicorn, Pydantic, NumPy, HTTPX, PyJWT |
| **Queue** | Redis 7 Alpine (`activity_queue`) |
| **Database & Auth** | Supabase (PostgreSQL with Row Level Security) |
| **AI / LLM** | Google Gemini 2.5 Flash via `google-genai` |
| **Activity Source** | Strava V3 API |

---

## Quickstart with Docker Compose

The fastest way to launch the complete system:

```bash
# 1. Clone repository
git clone https://github.com/GaryQuah/SC3040_AdvancedSoftware.git
cd SC3040_AdvancedSoftware

# 2. Configure environment variables
cp .env.example .env

# 3. Build and run all services
docker compose up --build
```

Once started:
- **Frontend:** [http://localhost:3000](http://localhost:3000) (Dashboard at `/dashboard`)
- **Backend API & Swagger Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Backend Healthcheck:** [http://localhost:8000/health](http://localhost:8000/health)

---

## Manual Local Development

### 1. Backend Setup (FastAPI)

> **Note:** Redis is **optional** for local development. If Redis is not detected, the backend automatically operates in standalone in-memory mode.

```bash
cd backend

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

### 3. Database Setup (Supabase)

1. Open your **Supabase Dashboard** and go to the **SQL Editor**.
2. Run the script in [`supabase/schema.sql`](file:///c:/Users/User/Desktop/SC3040/SC3040_AdvancedSoftware/supabase/schema.sql).
3. The schema sets up:
   - `athlete_profiles`: Physiological baselines (resting HR, max HR) and Strava tokens.
   - `activities`: Workout telemetry, TRIMP scores, and 5-zone HR distributions.
   - `daily_training_loads`: Daily TRIMP aggregates, Acute (7d), Chronic (28d), and ACWR.
   - `ai_recommendations`: Daily Gemini 2.5 Flash coaching plans.

---

## API Endpoints Reference

### Health & Probes
- `GET /health`: Healthcheck probe.

### Strava Webhooks & Sync
- `GET /api/v1/webhooks/strava`: Verification handshake (`hub.challenge`).
- `POST /api/v1/webhooks/strava`: Asynchronous activity event receiver.
- `POST /api/v1/activities/process`: Synchronous / simulated activity trigger.

### Analytics & AI Coaching
- `GET /api/v1/analytics/acwr`: Fetches 28-day ACWR history and acute/chronic loads.
- `POST /api/v1/recommendations/generate`: Synthesizes daily workout with Gemini 2.5 Flash.

---

## Physiological Models

### 1. Banister TRIMP (Training Impulse)
TRIMP weights duration ($D$, in minutes) against fractional heart rate reserve elevation ($\Delta\text{HR}$):

$$\text{TRIMP} = D \times \Delta\text{HR} \times y$$

Where:
- $\Delta\text{HR} = \frac{\text{HR} - \text{HR}_{\text{rest}}}{\text{HR}_{\text{max}} - \text{HR}_{\text{rest}}}$
- $y = 0.64 \times e^{1.92 \times \Delta\text{HR}}$ for males ($0.86 \times e^{1.67 \times \Delta\text{HR}}$ for females).

Implemented with NumPy vectorization in [`backend/app/calculations.py`](file:///c:/Users/User/Desktop/SC3040/SC3040_AdvancedSoftware/backend/app/calculations.py).

### 2. Acute:Chronic Workload Ratio (ACWR)
$$\text{ACWR} = \frac{\text{Acute Load (7-day average)}}{\text{Chronic Load (28-day average)}}$$

- **< 0.80:** Undertraining
- **0.80 – 1.30:** "Sweet Spot" (Optimal adaptation, minimized injury risk)
- **1.30 – 1.50:** Overreaching
- **> 1.50:** "Danger Zone" (Spike in relative injury likelihood)
