import type { ComponentType } from "react";
import { createElement } from "react";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";

// The fixture API answers after a short real delay (150 to 350 ms), so a test that does several things needs room.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });

/*
 * Shared set-up for the Training page tests.
 *
 * The page talks to `trainingApi` only. Without NEXT_PUBLIC_TRAINING_API=http that is the in-memory fixture API
 * (lib/training/mock-api.ts), which holds its state in module variables. Every test gets a fresh copy of it: each test
 * file replaces `@/lib/training/api` with `apiModule` (below), and `renderTrainingPage` points that at a newly
 * imported fixture API. The page and its components are imported once, so React is never loaded twice.
 */

/** The fixtures are built around "today", so the clock is pinned: Wednesday 4 November 2026, 09:00 local time. */
export const FIXED_NOW = new Date(2026, 10, 4, 9, 0, 0);
export const TODAY = "2026-11-04";

type ApiHolder = { api: Record<string | symbol, unknown> | null };
export const apiHolder: ApiHolder = { api: null };

/** Stands in for `@/lib/training/api`: forwards every call to whichever fixture API the current test is using. */
export const apiModule = {
  trainingApi: new Proxy(
    {},
    { get: (_target, property) => apiHolder.api?.[property as string | symbol] },
  ),
};

/** What jsdom doesn't have and the page needs: ResizeObserver (charts) and the <dialog> methods (every popup). */
export function installBrowserShims() {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // Assigned rather than stubbed with vi.stubGlobal: a chart can finish mounting after a test's last assertion, and by
  // then `vi.unstubAllGlobals()` has already run, so a stub that is put back would leave it without a ResizeObserver.
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverStub,
    configurable: true,
    writable: true,
  });

  const proto = HTMLDialogElement.prototype as HTMLDialogElement;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.show = function show(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/** Pins `new Date()` (and so the fixtures' "today") without touching timers, so waiting for the fixture API still works. */
export function useFixedClock(now: Date = FIXED_NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

/**
 * Days of the fixture week (Monday 2 to Sunday 8 November 2026) at 09:00, for tests that need a different "today".
 * Stay inside this week: the fixture plan is built around the current week (it began two Mondays ago), so a "today"
 * in another week gives a different plan.
 */
export const DAY = {
  mon: new Date(2026, 10, 2, 9, 0, 0),
  tue: new Date(2026, 10, 3, 9, 0, 0),
  wed: FIXED_NOW,
  sat: new Date(2026, 10, 7, 9, 0, 0),
};

export function restoreClock() {
  vi.useRealTimers();
}

export interface RenderOptions {
  /** "new" is a user with no preferences and no plan; the default is an athlete with a plan under way. */
  scenario?: "active" | "new";
  /** Extra query string for the fixtures, such as "goal=build_muscle". */
  query?: string;
  /** Sets up fixture state (an exam date, last night's sleep) before the page first loads. */
  before?: (api: import("@/lib/training/api").TrainingApi) => Promise<void>;
}

/** Renders the real page against a fresh fixture API and waits until it has loaded. */
export async function renderTrainingPage(Page: ComponentType, options: RenderOptions = {}) {
  const params = new URLSearchParams(options.query ?? "");
  if (options.scenario === "new") params.set("scenario", "new");
  const search = params.toString();
  window.history.replaceState(null, "", search ? `/?${search}` : "/");

  vi.resetModules();
  const { mockTrainingApi } = await import("@/lib/training/mock-api");
  apiHolder.api = mockTrainingApi as unknown as Record<string, unknown>;
  await options.before?.(mockTrainingApi);

  const view = render(createElement(Page));
  await waitFor(() => expect(screen.queryByText("Loading your training data…")).not.toBeInTheDocument(), {
    timeout: 3000,
  });
  return view;
}

/** The fixture API directly, for setting up a state the page then shows. */
export function fixtureApi() {
  return apiHolder.api as unknown as import("@/lib/training/api").TrainingApi;
}

const TAB_GROUP = "Training sections";

/** Opens one of the page's tabs ("Today", "Schedule", "Plan", "Preferences", "Strava"). */
export async function openTab(name: "Today" | "Schedule" | "Plan" | "Preferences" | "Strava") {
  const group = screen.getByRole("group", { name: TAB_GROUP });
  fireEvent.click(within(group).getByRole("button", { name }));
  await waitFor(() => expect(within(group).getByRole("button", { name })).toHaveAttribute("aria-pressed", "true"));
}

/** Sets a form field the way typing would. */
export function setField(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

/** The popup that is open right now. */
export function openDialog(name: string | RegExp) {
  return screen.getByRole("dialog", { name });
}
