import { apiBaseURL } from "./api-base";

export type SleepSession = { id: string; startedAt: number; endedAt: number };

function isSession(value: unknown): value is SleepSession & Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id !== ""
    && typeof row.startedAt === "number" && Number.isFinite(row.startedAt)
    && typeof row.endedAt === "number" && Number.isFinite(row.endedAt)
    && row.endedAt > row.startedAt;
}

/**
 * Sleep that ended in [from, to), read from the cloud backup on every call.
 * Sleep is supplementary: a missing session, a failure or a malformed
 * response all give `undefined` so the day keeps rendering without it.
 */
export async function fetchSleepSessions(from: number, to: number): Promise<SleepSession[] | undefined> {
  try {
    const response = await fetch(`${apiBaseURL}/api/v1/sleep?from=${from}&to=${to}`, { credentials: "include" });
    if (response.status !== 200) return undefined;
    const body: unknown = await response.json();
    const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data) || !data.every(isSession)) return undefined;
    return data.map(({ id, startedAt, endedAt }) => ({ id, startedAt, endedAt }));
  } catch {
    return undefined;
  }
}
