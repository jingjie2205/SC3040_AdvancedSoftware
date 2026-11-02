import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();

async function loadApi() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000/api");
  return import("@/lib/checkin/api");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("getMyCheckIns", () => {
  it("returns check-in dates from the API", async () => {
    const responseBody = {
      user_id: "user-1",
      dates: ["2026-11-01", "2026-11-02"],
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );
    const { getMyCheckIns } = await loadApi();

    await expect(getMyCheckIns("test-token")).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/checkin/me/dates",
      {
        headers: { Authorization: expect.any(String) },
      },
    );
  });

  it("returns an empty result when the API reports no check-ins", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { getMyCheckIns } = await loadApi();

    await expect(getMyCheckIns("test-token")).resolves.toEqual({
      user_id: "",
      dates: [],
    });
  });

  it("throws when the API request fails", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const { getMyCheckIns } = await loadApi();

    await expect(getMyCheckIns("test-token")).rejects.toThrow(
      "Failed to fetch check-in dates",
    );
  });
});
