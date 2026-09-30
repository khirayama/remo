import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("health endpoint", () => {
  it("returns ok", async () => {
    const response = await app.request(
      "/api/v1/health",
      {},
      { APP_ENV: "development", CORS_ALLOWED_ORIGINS: "" } as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ok", environment: "development" } });
  });
});
