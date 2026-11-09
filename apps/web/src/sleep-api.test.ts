import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSleepSessions } from "./sleep-api";

function mockFetch(response: Response | Error) {
  const fn = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSleepSessions", () => {
  it("returns validated sessions and sends the session cookie", async () => {
    const fn = mockFetch(Response.json({ data: [{ id: "a", startedAt: 1, endedAt: 5, updatedAt: 9 }] }));
    expect(await fetchSleepSessions(0, 10)).toEqual([{ id: "a", startedAt: 1, endedAt: 5 }]);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/v1/sleep?from=0&to=10");
    expect(init.credentials).toBe("include");
  });

  it("returns an empty list when nothing was recorded", async () => {
    mockFetch(Response.json({ data: [] }));
    expect(await fetchSleepSessions(0, 10)).toEqual([]);
  });

  it("is undefined when signed out", async () => {
    mockFetch(new Response("{}", { status: 401 }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
  });

  it("is undefined when the request fails", async () => {
    mockFetch(new Error("offline"));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
  });

  it("is undefined for server errors and malformed responses", async () => {
    mockFetch(new Response("{}", { status: 500 }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
    mockFetch(new Response("not json", { status: 200 }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
    mockFetch(Response.json({ data: [{ id: "a", startedAt: "x", endedAt: 5 }] }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
    mockFetch(Response.json({ data: [{ id: "a", startedAt: 5, endedAt: 1 }] }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
    mockFetch(Response.json({ nope: [] }));
    expect(await fetchSleepSessions(0, 10)).toBeUndefined();
  });
});
