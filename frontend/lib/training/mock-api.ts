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
  planWeekTarget,
  rescaleForBand,
  sessionsPerWeek,
  shareWeek,
  weekPool,
  weeklyTargets,
  weightOf,
} from "./mock-plan";
import {
  LOGGABLE_STATUSES,
  MOVABLE_STATUSES,
  bandRefusal,
  checkMove,
  checkPlacement,
  defaultDurationMin,
  isDeloadWeek,
} from "./rules";
import {
  addSessionSchema,
  fieldErrorsFrom,
  generatePlanSchema,
  logWorkoutSchema,
  sessionChangeSchema,
  sleepSchema,
  trainingPreferencesSchema,
} from "./schemas";
import type { LogWorkoutInput, TrainingPreferencesInput } from "./schemas";
import type { ApiError, ApiResult, LogResult, TrainingApi } from "./api";
import type {
  CoachMessage,
  Goal,
  IntensityBand,
  ModelInfo,
  NextSession,
  PlannedSession,
  ReadinessFactor,
  ReadinessScore,
  SessionRecommendation,
  TodayState,
  TodayView,
  TrainingPlan,
  TrainingPreferences,
  TrainingSummary,
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

/** Every workout the fixtures make is the athlete's own: Strava logs only come from the real backend. */
function makeWorkout(
  fields: Omit<WorkoutSession, "id" | "createdAt" | "externalId" | "distanceM"> & { distanceM?: number | null },
): WorkoutSession {
  return { id: nextId("w"), createdAt: new Date().toISOString(), externalId: null, distanceM: null, ...fields };
}

const toMetres = (km: number | null) => (km === null ? null : Math.round(km * 10000) / 10);

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
          calories: Math.round(volume * 1.25 * 8),
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
        calories: Math.round(session.targetDurationMin * ratio * 8),
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

/** Every session the fixtures hold, whichever plan it belongs to: a finished session of an old plan still takes its day. */
function placementContext(s: MockState, plan: TrainingPlan) {
  return { sessions: s.sessions, planStart: plan.startDate, planEnd: plan.endDate, today: todayISO() };
}

const weightsOf = (sessions: PlannedSession[]) =>
  sessions.map((x) => ({ id: x.id, volume: x.targetVolume, weight: weightOf(x.intensityBand, x.targetDurationMin) }));

/** A hand-planned session uses one of the athlete's own activities and an intensity its week allows. */
function detailProblems(
  plan: TrainingPlan,
  preferences: TrainingPreferences,
  weekMonday: string,
  activityType: PlannedSession["activityType"] | undefined,
  band: IntensityBand | undefined,
): ApiResult<never> | null {
  const fieldErrors: Record<string, string> = {};
  if (activityType !== undefined && !preferences.activityTypes.includes(activityType)) {
    fieldErrors.activityType = "Pick one of your preferred activity types";
  }
  if (band !== undefined) {
    const why = bandRefusal(band, isDeloadWeek(plan, weekMonday));
    if (why) fieldErrors.intensityBand = why;
  }
  return Object.keys(fieldErrors).length > 0
    ? fail("VALIDATION", "Check the highlighted fields.", { fieldErrors })
    : null;
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

/** The plan side of "how is today going", with no readiness in it (the coach is built from this alone). */
function planSnapshot(s: MockState) {
  const today = todayISO();
  const plan = s.plan;
  const monday = startOfWeek(today);
  const sunday = addDays(monday, 6);
  const mine = (plan ? s.sessions.filter((x) => x.planId === plan.id) : []).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const session = mine.find((x) => x.date === today) ?? null;
  const week = mine.filter((x) => x.date >= monday && x.date <= sunday);
  const state: TodayState = !plan
    ? "no_plan"
    : !session
      ? "rest_day"
      : session.status === "completed" || session.status === "partial"
        ? "done"
        : session.status === "missed"
          ? "missed"
          : "to_do";
  const following = mine.find((x) => x.date > today && MOVABLE_STATUSES.includes(x.status));
  const next: NextSession | null = following
    ? {
        date: following.date,
        activityType: following.activityType,
        intensityBand: following.intensityBand,
        targetDurationMin: following.targetDurationMin,
      }
    : null;
  return {
    today,
    plan,
    session,
    state,
    next,
    logged: session ? (s.workouts.find((w) => w.plannedSessionId === session.id) ?? null) : null,
    week: {
      start: monday,
      end: sunday,
      plannedSessions: week.length,
      completedSessions: week.filter((x) => x.status === "completed" || x.status === "partial").length,
      missedSessions: week.filter((x) => x.status === "missed").length,
      loggedMinutes: s.workouts
        .filter((w) => w.date >= monday && w.date <= sunday)
        .reduce((sum, w) => sum + w.actualDurationMin, 0),
    },
  };
}

/** The built-in coach text, the same wording the backend falls back to. */
function coachFallback(snapshot: ReturnType<typeof planSnapshot>): string {
  const { state, session, week } = snapshot;
  if (state === "no_plan") {
    return "There's no training plan yet. Generate one on the Plan tab and today's workout will show up here.";
  }
  const progress =
    week.plannedSessions > 0
      ? `You've done ${week.completedSessions} of ${week.plannedSessions} planned sessions this week.`
      : "";
  const advice = { push: "Warm up well and make the hard part count.", light: "Keep it easy and conversational.", deload: "Take it gently, this week is about recovery." };
  const lead =
    state === "rest_day"
      ? "Rest day today: nothing is planned, so recovery is the workout."
      : state === "done"
        ? "Nice work, today's session is done."
        : state === "missed"
          ? "Today's session was marked as missed. If you did it after all, you can still log it."
          : `Today is a ${session?.intensityBand} ${session?.activityType} session of about ${session?.targetDurationMin} minutes. ${session ? advice[session.intensityBand] : ""}`;
  return [lead.trim(), progress].filter(Boolean).join(" ");
}

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
    const check = checkMove(session, newDate, placementContext(s, plan));
    if (!check.ok) return fail(check.code, check.reason, { suggestedDate: check.suggestedDate });
    session.date = newDate;
    session.status = "moved";
    return ok(session);
  },

  async addSession(input) {
    await delay();
    const s = getState();
    const plan = s.plan;
    if (!plan) return fail("NO_PLAN", "Generate a training plan first, then you can plan sessions in it.");
    if (!s.preferences) return fail("NO_PREFERENCES", "Set your training preferences before planning sessions.");
    const parsed = addSessionSchema.safeParse(input);
    if (!parsed.success) {
      return fail("VALIDATION", "Check the highlighted fields.", { fieldErrors: fieldErrorsFrom(parsed.error) });
    }
    const { date, activityType, intensityBand, targetDurationMin } = parsed.data;
    const monday = startOfWeek(date);
    const unsuitable = detailProblems(plan, s.preferences, monday, activityType, intensityBand);
    if (unsuitable) return unsuitable;

    const duration = targetDurationMin ?? defaultDurationMin(s.preferences.sessionDurationMin, intensityBand);
    const draft: PlannedSession = {
      id: nextId("s"),
      planId: plan.id,
      date,
      activityType,
      targetVolume: 0,
      targetDurationMin: duration,
      intensityBand,
      status: "planned",
    };
    const check = checkPlacement(draft, date, placementContext(s, plan));
    if (!check.ok) return fail(check.code, check.reason, { suggestedDate: check.suggestedDate });

    const week = s.sessions.filter((x) => x.planId === plan.id && startOfWeek(x.date) === monday);
    const movable = week.filter((x) => MOVABLE_STATUSES.includes(x.status));
    const pool = weekPool(
      planWeekTarget(plan, monday) ?? 0,
      week.filter((x) => !MOVABLE_STATUSES.includes(x.status)).reduce((sum, x) => sum + x.targetVolume, 0), // done or missed
      movable.reduce((sum, x) => sum + x.targetVolume, 0),
      movable.length + 1,
      sessionsPerWeek(s.preferences),
    );
    if (pool < movable.length + 1) {
      return fail(
        "WEEK_FULL",
        "That week's training load is already planned or done, so there's nothing left to share with another session. Pick another week, or log it as an extra workout once you've done it.",
      );
    }

    const share = shareWeek(pool, weightsOf(movable), weightOf(intensityBand, duration));
    const adjusted = movable.filter((x) => share.others[x.id] !== x.targetVolume);
    for (const x of adjusted) x.targetVolume = share.others[x.id];
    const added: PlannedSession = { ...draft, targetVolume: share.newVolume };
    s.sessions.push(added);
    return ok({ session: added, adjustedCount: adjusted.length });
  },

  async updateSession(id, change) {
    await delay();
    const s = getState();
    const plan = s.plan;
    const parsed = sessionChangeSchema.safeParse(change);
    if (!parsed.success) {
      return fail("VALIDATION", "Check the highlighted fields.", { fieldErrors: fieldErrorsFrom(parsed.error) });
    }
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return fail("NOT_FOUND", "That session no longer exists.");
    if (!plan || session.planId !== plan.id) {
      return fail("NOT_MOVABLE", "Sessions from a replaced plan can't be changed.");
    }
    if (!MOVABLE_STATUSES.includes(session.status)) {
      return fail("NOT_MOVABLE", "Completed, partial and missed sessions can't be changed.");
    }

    const activityType = parsed.data.activityType ?? session.activityType;
    const intensityBand = parsed.data.intensityBand ?? session.intensityBand;
    const targetDurationMin = parsed.data.targetDurationMin ?? session.targetDurationMin;
    const newActivity = activityType !== session.activityType;
    const newBand = intensityBand !== session.intensityBand;
    const newLength = targetDurationMin !== session.targetDurationMin;
    if (!newActivity && !newBand && !newLength) {
      return fail("NO_CHANGE", "That session already looks like that.");
    }
    if (!s.preferences) {
      return fail("NO_PREFERENCES", "Set your training preferences before changing a session.");
    }

    const monday = startOfWeek(session.date);
    const unsuitable = detailProblems(
      plan,
      s.preferences,
      monday,
      newActivity ? activityType : undefined,
      newBand ? intensityBand : undefined,
    );
    if (unsuitable) return unsuitable;
    if (newBand) {
      // Only the intensity can break a day rule where the session already stands: a push beside a push.
      const check = checkPlacement({ ...session, intensityBand }, session.date, placementContext(s, plan));
      if (!check.ok) return fail(check.code, check.reason);
    }

    let volume = session.targetVolume;
    if (newBand || newLength) {
      // A different weight changes this session's share of the week; the week's total stays what it was.
      const movable = s.sessions.filter(
        (x) => x.planId === plan.id && startOfWeek(x.date) === monday && MOVABLE_STATUSES.includes(x.status),
      );
      const others = movable.filter((x) => x.id !== session.id);
      const share = shareWeek(
        movable.reduce((sum, x) => sum + x.targetVolume, 0),
        weightsOf(others),
        weightOf(intensityBand, targetDurationMin),
      );
      for (const x of others) x.targetVolume = share.others[x.id];
      volume = share.newVolume;
    }
    Object.assign(session, { activityType, intensityBand, targetDurationMin, targetVolume: volume });
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

  async getSummary() {
    await delay();
    const s = getState();
    const snap = planSnapshot(s);
    const readiness = readinessFor(
      snap.today,
      snap.session?.intensityBand ?? null,
      s.sleepHours,
      s.preferences?.examDates ?? [],
    );
    const summary: TrainingSummary = {
      date: snap.today,
      hasPlan: snap.plan !== null,
      goal: snap.plan?.goal ?? null,
      readiness,
      today: {
        state: snap.state,
        session: snap.session,
        recommendation:
          snap.state === "to_do" && snap.session ? reconcile(snap.session, readiness) : null,
        logged: snap.logged,
      },
      week: snap.week,
      nextSession: snap.next,
    };
    return clone(summary);
  },

  async getCoachMessage() {
    await delay(250);
    const snap = planSnapshot(getState());
    const message: CoachMessage = {
      date: snap.today,
      message: coachFallback(snap),
      source: "fallback",
      model: null,
      cached: false,
      notice: PLAN_NOTICE,
    };
    return ok(message);
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

    const { distanceKm, ...logged } = valid.data;
    const workout = makeWorkout({
      plannedSessionId: session.id,
      ...logged,
      distanceM: toMetres(distanceKm),
      source: "manual",
    });
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
    const { distanceKm, ...logged } = valid.data;
    const workout = makeWorkout({
      plannedSessionId: null,
      ...logged,
      distanceM: toMetres(distanceKm),
      source: "manual",
    });
    getState().workouts.push(workout);
    const result: LogResult = { workout, session: null };
    return ok(result);
  },
};