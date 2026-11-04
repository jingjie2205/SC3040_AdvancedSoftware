import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * API-5: which implementation of the Training API the page gets. The other test files replace this module with the
 * fixtures, so this is the one place it is loaded as it ships. It is read once when the page loads, so each case
 * resets the module cache and sets the environment first.
 */

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

async function loadSelector(env: string | undefined) {
  vi.resetModules();
  if (env === undefined) vi.stubEnv("NEXT_PUBLIC_TRAINING_API", "");
  else vi.stubEnv("NEXT_PUBLIC_TRAINING_API", env);
  const [{ trainingApi }, { mockTrainingApi }, { httpTrainingApi }] = await Promise.all([
    import("@/lib/training/api"),
    import("@/lib/training/mock-api"),
    import("@/lib/training/http-api"),
  ]);
  return { trainingApi, mockTrainingApi, httpTrainingApi };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API-5 choosing the Training API", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["mock", "mock"],
    ["HTTP in capitals", "HTTP"],
    ["anything else", "backend"],
  ])("API-5.01: with NEXT_PUBLIC_TRAINING_API %s the page runs on the in-memory fixtures", async (_label, env) => {
    const { trainingApi, mockTrainingApi, httpTrainingApi } = await loadSelector(env);
    expect(trainingApi).toBe(mockTrainingApi);
    expect(trainingApi).not.toBe(httpTrainingApi);
  });

  it("API-5.02: with NEXT_PUBLIC_TRAINING_API set to exactly 'http' the page talks to the backend", async () => {
    const { trainingApi, mockTrainingApi, httpTrainingApi } = await loadSelector("http");
    expect(trainingApi).toBe(httpTrainingApi);
    expect(trainingApi).not.toBe(mockTrainingApi);
  });
});
