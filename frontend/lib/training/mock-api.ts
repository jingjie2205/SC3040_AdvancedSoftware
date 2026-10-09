/**
 * In-memory fixtures behind TrainingApi. State lives for the browser session and resets on reload.
 * Open the page with `?scenario=new` to start with no preferences and no plan.
 *
 * Everything here is a stand-in: the real server owns generation, readiness and the rules.
 */
import { TRAINING_RULES as R } from "./config";
import { addDays, diffDays, startOfWeek, todayISO } from "./dates";
import {
  baselineFromHistory,
  buildSessions,
  firstUnsafeWeek,
  planEndDate,
  rescaleForBand,
  weeklyTargets,
} from "./mock-plan";
import { LOGGABLE_STATUSES, MOVABLE_STATUSES, checkMove } from "./rules";
import {
  fieldErrorsFrom,
  generatePlanSchema,
  logWorkoutSchema,
  sleepSchema,
  trainingPreferencesSchema,
} from "./schemas";
import type { LogWorkoutInput, TrainingPreferencesInput } from "./schemas";
import type { ApiError, ApiResult, LogResult, TrainingApi } from "./api";
import type {
  Goal,
  IntensityBand,
  ModelInfo,
  PlannedSession,
  ReadinessFactor,
  ReadinessScore,
  SessionRecommendation,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
  WorkoutSession,
} from "./types";

const PLAN_NOTICE =
  "This plan is a general training guide, not medical advice. Stop and speak to a qualified professional if you feel pain, dizziness or unusual fatigue.";

const SEED_PREFERENCES: TrainingPreferencesInput = {
  daysPerWeek: 4,
  sessionDurationMin: 45,
  activityTypes: ["run", "gym", "cycling"],
  restDays: ["tue", "thu", "sun"],
  examDates: [],
};

const RANK: Record<IntensityBand, number> = { deload: 0, light: 1, push: 2 };

interface MockState {
  preferences: TrainingPreferences | null;
  plan: TrainingPlan | null;
  sessions: PlannedSession[];
  workouts: WorkoutSession[];
  /** Last night's sleep as entered today. */
  sleepHours: number | null;
}

let state: MockState | null = null;
let counter = 0;

const nextId = (prefix: string) => `${prefix}-${++counter}`;
const clone = <T>(value: T): T => structuredClone(value);
const delay = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data: clone(data) });
const fail = (
  code: ApiError["code"],
  message: string,
  extra: Partial<ApiError> = {},
): ApiResult<never> => ({ ok: false, error: { code, message, ...extra } });

/**
 * The profile goal the fixtures pretend Settings holds. Open the page with `?goal=lose_weight`,
 * `?goal=build_muscle` or `?goal=none` to see the plan follow it. Maintenance is the default.
 */
function mockGoal(): Goal | null {
  const asked =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("goal") : null;
  if (asked === "none") return null;
  return asked === "lose_weight" || asked === "build_muscle" || asked === "maintain" ? asked : "maintain";
}

function makeWorkout(fields: Omit<WorkoutSession, "id" | "createdAt">): WorkoutSession {
  return { id: nextId("w"), createdAt: new Date().toISOString(), ...fields };
}

/** Three logged sessions a week for the 4 weeks before `endExclusive` (a Monday). */
function seedHistory(endExclusive: string): WorkoutSession[] {
  const pattern = [
    { day: 0, activityType: "run", volume: 34 },
    { day: 2, activityType: "gym", volume: 30 },
    { day: 5, activityType: "cycling", volume: 36 },
  ] as const;
  const history: WorkoutSession[] = [];
  for (let week = 4; week >= 1; week--) {
    const monday = addDays(endExclusive, -7 * week);
    for (const { day, activityType, volume } of pattern) {
      history.push(
        makeWorkout({
          plannedSessionId: null,
          date: addDays(monday, day),
          activityType,
          actualVolume: volume,
          actualDurationMin: Math.round(volume * 1.25),
          rpe: 6,
          avgHr: activityType === "gym" ? null : 141,
          source: "manual",
        }),
      );
    }
  }
  return history;
}

function seedState(scenario: "active" | "new"): MockState {
  const today = todayISO();
  const thisMonday = startOfWeek(today);
  if (scenario === "new") {
    return {
      preferences: null,
      plan: null,
      sessions: [],
      workouts: seedHistory(thisMonday),
      sleepHours: null,
    };
  }

  const planStart = addDays(thisMonday, -14);
  const weeks = 8;
  const workouts = seedHistory(planStart);
  const baseline = baselineFromHistory(workouts, planStart);
  const plan: TrainingPlan = {
    id: nextId("p"),
    startDate: planStart,
    endDate: planEndDate(planStart, weeks),
    weeks,
    status: "active",
    baselineVolume: baseline.volume,
    createdAt: new Date().toISOString(),
    notice: PLAN_NOTICE,
    goal: mockGoal(),
    lastAdaptation: null,
  };

  let pastIndex = 0;
  const drafts = buildSessions({
    prefs: SEED_PREFERENCES,
    startDate: planStart,
    targets: weeklyTargets(baseline.volume, weeks),
    fromDate: planStart,
    goal: plan.goal,
  });
  const sessions = drafts.map((draft): PlannedSession => {
    const session: PlannedSession = { ...draft, id: nextId("s"), planId: plan.id };
    if (session.date >= today) return session;

    const k = pastIndex++;
    if (k % 9 === 4) return { ...session, status: "missed" };
    const partial = k % 7 === 3;
    const ratio = partial ? 0.6 : 1;
    workouts.push(
      makeWorkout({
        plannedSessionId: session.id,
        date: session.date,
        activityType: session.activityType,
        actualVolume: Math.round(session.targetVolume * ratio),
        actualDurationMin: Math.round(session.targetDurationMin * ratio),
        rpe: session.intensityBand === "push" ? 8 : 5,
        avgHr: session.activityType === "gym" ? null : 148,
        source: "manual",
      }),
    );
    return { ...session, status: partial ? "partial" : "completed" };
  });

  return {
    preferences: { ...SEED_PREFERENCES, updatedAt: new Date().toISOString() },
    plan,
    sessions,
    workouts,
    sleepHours: null,
  };
}

function getState(): MockState {
  if (!state) {
    const scenario =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("scenario") === "new"
        ? "new"
        : "active";
    state = seedState(scenario);
  }
  return state;
}

/**
 * Fixture: high readiness on planned light days, low readiness otherwise,
 * so both reconciliation outcomes can be seen in the UI.
 */
function readinessFixture(date: string, plannedBand: IntensityBand | null): ReadinessScore {
  const computedAt = new Date().toISOString();
  if (plannedBand === "light") {
    return {
      date,
      score: 82,
      classification: "push",
      explanation: "Well recovered: training load is balanced and sleep was solid.",
      computedAt,
      factors: [
        { key: "load", label: "Training load", impact: "positive", detail: "Acute:chronic ratio 1.05, right in the productive range" },
        { key: "sleep", label: "Sleep", impact: "positive", detail: "8.1 h last night" },
        { key: "rhr", label: "Resting heart rate", impact: "positive", detail: "1 bpm below your 14-day baseline" },
        { key: "checkin", label: "Daily check-in", impact: "neutral", detail: "Muscle soreness 4 out of 5" },
      ],
    };
  }
  return {
    date,
    score: 58,
    classification: "light",
    explanation: "Recent load is high and sleep was short, so keep it easier today.",
    computedAt,
    factors: [
      { key: "load", label: "Training load", impact: "negative", detail: "Acute:chronic ratio 1.32, above your usual range" },
      { key: "sleep", label: "Sleep", impact: "negative", detail: "5.9 h last night" },
      { key: "rhr", label: "Resting heart rate", impact: "neutral", detail: "2 bpm above your 14-day baseline" },
      { key: "checkin", label: "Daily check-in", impact: "positive", detail: "Muscle soreness 4 out of 5" },
    ],
  };
}

const FIXTURE_SLEEP_HOURS = { push: 8.1, other: 5.9 };

/** The same rules as the backend's rule scorer, so the fixtures move the way the real score does. */
const sleepDelta = (hours: number) =>
  hours < 7 ? -Math.min(15, (7 - hours) * 7.5) : hours >= 8 ? 3 : 0;
const examDelta = (days: number) => (days > 7 ? 0 : -((7 - days) / 7) * 10);
const impactOf = (delta: number): ReadinessFactor["impact"] =>
  delta <= -1 ? "negative" : delta >= 1 ? "positive" : "neutral";

/**
 * The fixture's readiness, with its made-up sleep taken out and the user's own sleep and nearest
 * exam put in, so entering them visibly changes the score, the band and the factors.
 */
function readinessFor(
  date: string,
  plannedBand: IntensityBand | null,
  sleepHours: number | null,
  examDates: string[],
): ReadinessScore {
  const base = readinessFixture(date, plannedBand);
  const fixtureSleep =
    base.classification === "push" ? FIXTURE_SLEEP_HOURS.push : FIXTURE_SLEEP_HOURS.other;
  let score = base.score - sleepDelta(fixtureSleep);
  const factors = base.factors.filter((factor) => factor.key !== "sleep");
  const drags: { label: string; delta: number }[] = factors
    .filter((factor) => factor.impact === "negative")
    .map((factor) => ({ label: factor.label, delta: -1 }));

  if (sleepHours !== null) {
    const delta = sleepDelta(sleepHours);
    score += delta;
    factors.push({
      key: "sleep",
      label: "Sleep",
      impact: impactOf(delta),
      detail: `${sleepHours.toFixed(1)} h last night`,
    });
    if (delta <= -1) drags.push({ label: "Sleep", delta });
  }
  const nextExam = examDates.filter((day) => day >= date).sort()[0];
  if (nextExam !== undefined && diffDays(nextExam, date) <= 7) {
    const days = diffDays(nextExam, date);
    const delta = examDelta(days);
    score += delta;
    factors.push({
      key: "exam",
      label: "Academic load",
      impact: impactOf(delta),
      detail: days === 0 ? "Exam today" : `Exam in ${days} day${days === 1 ? "" : "s"}`,
    });
    if (delta <= -1) drags.push({ label: "Academic load", delta });
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const classification: IntensityBand =
    finalScore >= 70 ? "push" : finalScore >= 45 ? "light" : "deload";
  const drag = drags.sort((a, b) => a.delta - b.delta)[0];
  const explanation =
    classification === "deload"
      ? `Fatigue signals are stacking up, mainly ${(drag?.label ?? "several signals").toLowerCase()}. Prioritise recovery today.`
      : classification === "light"
        ? `${drag?.label ?? "Your recent signals"} is holding your score back, so keep it easier today.`
        : drag
          ? `Mostly recovered. Keep an eye on ${drag.label.toLowerCase()}.`
          : "Well recovered. Nothing is holding your score back today.";

  // The real scorer lists the biggest movers first and shows four, so a drag never hides below the fold.
  const rank = { negative: 0, positive: 1, neutral: 2 } as const;
  factors.sort((a, b) => rank[a.impact] - rank[b.impact]);
  return { ...base, score: finalScore, classification, explanation, factors: factors.slice(0, 4) };
}

/** One-directional: readiness can pull a session down a band, never up. */
function reconcile(planned: PlannedSession, readiness: ReadinessScore): SessionRecommendation {
  const band =
    RANK[readiness.classification] < RANK[planned.intensityBand]
      ? readiness.classification
      : planned.intensityBand;
  const downgraded = band !== planned.intensityBand;

  let explanation = "Readiness matches today's plan, so go ahead as scheduled.";
  if (downgraded) {
    explanation = `Readiness is ${readiness.classification} today (${readiness.score}/100), so your planned ${planned.intensityBand} session is dialled back to ${band}.`;
  } else if (readiness.classification === "push" && planned.intensityBand === "light") {
    explanation =
      "You're ready to push, but today is a planned light day. The plan stays as scheduled to protect your progression.";
  }

  return {
    activityType: planned.activityType,
    intensityBand: band,
    downgraded,
    explanation,
    ...(downgraded
      ? rescaleForBand(planned, band)
      : { targetVolume: planned.targetVolume, targetDurationMin: planned.targetDurationMin }),
  };
}

function validateLog(input: LogWorkoutInput): ApiResult<LogWorkoutInput> {
  const parsed = logWorkoutSchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", "Check the highlighted fields.", {
      fieldErrors: fieldErrorsFrom(parsed.error),
    });
  }
  return ok(parsed.data);
}

/** What a healthy backend reports: the shipped model and its measured agreement with the rules. */
const MOCK_MODEL: ModelInfo = {
  kind: "model",
  version: "mlp-v1",
  description:
    "Small neural network. It reproduces the rule-based scorer from data and was not trained on measured readiness, so it is no more accurate than the rules.",
  trainedOn:
    "synthetic cohort of 80,000 simulated athletes (seed 7), labelled by the rules-v1 rule-based scorer",
  metrics: { mae_points: 0.4939, r2: 0.9964, class_agreement: 0.9888, within_3_points: 0.9992 },
  fallbackReason: null,
};

export const mockTrainingApi: TrainingApi = {
  async getPreferences() {
    await delay();
    return clone(getState().preferences);
  },

  async savePreferences(input) {
    await delay();
    const parsed = trainingPreferencesSchema.safeParse(input);
    if (!parsed.success) {
      return fail("VALIDATION", "Check the highlighted fields.", {
        fieldErrors: fieldErrorsFrom(parsed.error),
      });
    }
    const s = getState();
    // Like the server: kept in order without repeats, and an exam that has passed is dropped.
    const today = todayISO();
    const examDates = [...new Set(parsed.data.examDates)].filter((day) => day >= today).sort();
    s.preferences = { ...parsed.data, examDates, updatedAt: new Date().toISOString() };
    return ok(s.preferences);
  },

  async getPlan() {
    await delay();
    return clone(getState().plan);
  },

  async generatePlan(request) {
    await delay(350);
    const s = getState();
    const today = todayISO();
    if (!s.preferences) {
      return fail("NO_PREFERENCES", "Set your training preferences before generating a plan.");
    }
    const parsed = generatePlanSchema.safeParse({ weeks: request.weeks });
    if (!parsed.success) {
      return fail("VALIDATION", "Check the plan length.", {
        fieldErrors: fieldErrorsFrom(parsed.error),
      });
    }
    if (s.plan && !request.confirmReplace) {
      return fail("PLAN_EXISTS", "You already have an active plan. Confirm to replace it.");
    }

    const baseline = baselineFromHistory(s.workouts, today);
    const targets = weeklyTargets(baseline.volume, parsed.data.weeks);
    const unsafeWeek = firstUnsafeWeek(targets);
    if (unsafeWeek !== -1) {
      return fail(
        "PLAN_UNSAFE",
        `Week ${unsafeWeek + 1} would raise volume by more than ${R.maxWeeklyIncreasePct}%, so no plan was saved.`,
      );
    }

    const startDate = startOfWeek(today);
    const plan: TrainingPlan = {
      id: nextId("p"),
      startDate,
      endDate: planEndDate(startDate, parsed.data.weeks),
      weeks: parsed.data.weeks,
      status: "active",
      baselineVolume: baseline.volume,
      createdAt: new Date().toISOString(),
      notice: PLAN_NOTICE,
      goal: mockGoal(),
      lastAdaptation: null,
    };
    // Only sessions still to do are dropped; anything already completed, partial or missed is history.
    const previous = s.plan;
    if (previous) {
      s.sessions = s.sessions.filter(
        (x) => x.planId !== previous.id || x.date < today || !MOVABLE_STATUSES.includes(x.status),
      );
    }
    const taken = new Set(s.sessions.map((x) => x.date));
    s.sessions.push(
      ...buildSessions({ prefs: s.preferences, startDate, targets, fromDate: today, goal: plan.goal })
        .filter((draft) => !taken.has(draft.date))
        .map((draft): PlannedSession => ({ ...draft, id: nextId("s"), planId: plan.id })),
    );
    s.plan = plan;
    return ok(plan);
  },

  async recalculatePlan() {
    await delay(350);
    const s = getState();
    const today = todayISO();
    const plan = s.plan;
    if (!plan || !s.preferences) return fail("NO_PLAN", "There's no active plan to adapt.");
    if (today > plan.endDate) {
      return fail("PLAN_ENDED", "Your plan has finished. Generate a new one instead.");
    }

    // Rebaseline on what was actually completed, never on what was planned.
    const baseline = baselineFromHistory(s.workouts, today);
    const monday = startOfWeek(today);
    const weeksElapsed = diffDays(monday, plan.startDate) / 7;
    const remainingWeeks = plan.weeks - weeksElapsed;
    const targets = weeklyTargets(baseline.volume, remainingWeeks, weeksElapsed);

    s.sessions = s.sessions.filter(
      (x) => !(x.planId === plan.id && x.date >= today && MOVABLE_STATUSES.includes(x.status)),
    );
    const taken = new Set(s.sessions.filter((x) => x.planId === plan.id).map((x) => x.date));
    s.sessions.push(
      ...buildSessions({ prefs: s.preferences, startDate: monday, targets, fromDate: today, goal: mockGoal() })
        .filter((draft) => !taken.has(draft.date))
        .map((draft): PlannedSession => ({ ...draft, id: nextId("s"), planId: plan.id })),
    );

    const previousBaseline = plan.baselineVolume;
    plan.baselineVolume = baseline.volume;
    plan.goal = mockGoal();
    plan.lastAdaptation = {
      trigger: "manual",
      adaptedAt: new Date().toISOString(),
      adaptedOn: today,
      acknowledged: false,
      reason: baseline.usedDefault
        ? `You have fewer than ${R.minHistoryWeeksForBaseline} weeks of completed training in the last 4 weeks, so a conservative default of ${baseline.volume} pts/week was used. Only the remaining ${remainingWeeks} week(s) were regenerated.`
        : `Rebaselined from your ${baseline.sessionCount} completed sessions in the last 4 weeks: ${previousBaseline} to ${baseline.volume} pts/week. Only the remaining ${remainingWeeks} week(s) were regenerated.`,
    };
    return ok(plan);
  },

  async acknowledgeAdaptation() {
    await delay(50);
    const adaptation = getState().plan?.lastAdaptation;
    if (adaptation) adaptation.acknowledged = true;
  },

  async getSchedule(from, to) {
    await delay();
    const s = getState();
    return clone({
      sessions: s.sessions.filter((x) => x.date >= from && x.date <= to),
      workouts: s.workouts.filter((x) => x.date >= from && x.date <= to),
    });
  },

  async rescheduleSession(id, newDate) {
    await delay();
    const s = getState();
    const plan = s.plan;
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return fail("NOT_FOUND", "That session no longer exists.");
    if (!plan || session.planId !== plan.id) {
      return fail("NOT_MOVABLE", "Sessions from a replaced plan can't be moved.");
    }
    const check = checkMove(session, newDate, {
      sessions: s.sessions.filter((x) => x.planId === plan.id),
      planStart: plan.startDate,
      planEnd: plan.endDate,
      today: todayISO(),
    });
    if (!check.ok) return fail(check.code, check.reason, { suggestedDate: check.suggestedDate });
    session.date = newDate;
    session.status = "moved";
    return ok(session);
  },

  async removeSession(id) {
    await delay();
    const s = getState();
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return fail("NOT_FOUND", "That session no longer exists.");
    if (!MOVABLE_STATUSES.includes(session.status)) {
      return fail("NOT_MOVABLE", "Completed, partial and missed sessions can't be removed.");
    }
    s.sessions = s.sessions.filter((x) => x.id !== id);
    const week = startOfWeek(session.date);
    const rest = s.sessions.filter(
      (x) =>
        x.planId === session.planId &&
        startOfWeek(x.date) === week &&
        MOVABLE_STATUSES.includes(x.status),
    );
    if (rest.length > 0) {
      const share = Math.round(session.targetVolume / rest.length);
      for (const x of rest) x.targetVolume += share;
    }
    return ok({ redistributedCount: rest.length });
  },

  async getToday() {
    await delay();
    const s = getState();
    const today = todayISO();
    const plan = s.plan;
    const planned = plan
      ? (s.sessions.find((x) => x.planId === plan.id && x.date === today) ?? null)
      : null;
    const readiness = readinessFor(
      today,
      planned?.intensityBand ?? null,
      s.sleepHours,
      s.preferences?.examDates ?? [],
    );
    const view: TodayView = {
      date: today,
      readiness,
      planned,
      recommendation: planned ? reconcile(planned, readiness) : null,
      logged: planned ? (s.workouts.find((w) => w.plannedSessionId === planned.id) ?? null) : null,
      sleepHours: s.sleepHours,
    };
    return clone(view);
  },

  async respondToSession(id, response) {
    await delay();
    const s = getState();
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return fail("NOT_FOUND", "That session no longer exists.");
    if (!MOVABLE_STATUSES.includes(session.status)) {
      return fail("INVALID_STATE", "This session has already been logged or missed.");
    }
    if (response.action === "accept") {
      session.status = "accepted";
    } else if (response.action === "swap") {
      if (s.preferences && !s.preferences.activityTypes.includes(response.activityType)) {
        return fail("INVALID_STATE", "Pick one of your preferred activity types.");
      }
      session.activityType = response.activityType;
      session.status = "accepted";
    } else {
      session.status = "missed";
    }
    return ok(session);
  },

  async logSession(id, input) {
    await delay();
    const s = getState();
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return fail("NOT_FOUND", "That session no longer exists.");
    if (!LOGGABLE_STATUSES.includes(session.status)) {
      return fail("INVALID_STATE", "That session has already been logged.");
    }
    const valid = validateLog(input);
    if (!valid.ok) return valid;

    const workout = makeWorkout({ plannedSessionId: session.id, ...valid.data, source: "manual" });
    s.workouts.push(workout);
    session.status =
      workout.actualVolume >= R.partialCompletionRatio * session.targetVolume
        ? "completed"
        : "partial";
    const result: LogResult = { workout, session };
    return ok(result);
  },

  async getReadinessModel() {
    await delay();
    return clone(MOCK_MODEL);
  },

  async logSleep(hours) {
    await delay();
    const parsed = sleepSchema.safeParse({ hours });
    if (!parsed.success) {
      return fail("VALIDATION", "Check the highlighted fields.", {
        fieldErrors: fieldErrorsFrom(parsed.error),
      });
    }
    const s = getState();
    s.sleepHours = Math.round(parsed.data.hours * 100) / 100;
    return ok({ date: todayISO(), hours: s.sleepHours });
  },

  async clearSleep() {
    await delay(50);
    getState().sleepHours = null;
    return ok(undefined);
  },

  async logAdHocSession(input) {
    await delay();
    const valid = validateLog(input);
    if (!valid.ok) return valid;
    const workout = makeWorkout({ plannedSessionId: null, ...valid.data, source: "manual" });
    getState().workouts.push(workout);
    const result: LogResult = { workout, session: null };
    return ok(result);
  },
};
