import { describe, expect, it } from "vitest";
import { previewUploadOutcome } from "./photo-api";

// A preview the server will not take must not stop the rest of the pass, but a
// rate limit or a server fault has to be retried later.
describe("photo preview upload results", () => {
  it("treats a 2xx as uploaded", () => {
    expect(previewUploadOutcome(200)).toBe("uploaded");
    expect(previewUploadOutcome(204)).toBe("uploaded");
  });

  it("stops the pass for a rate limit or a server fault", () => {
    for (const status of [429, 500, 502, 503]) expect(previewUploadOutcome(status)).toBe("retry");
  });

  it("skips a preview that cannot be uploaded now", () => {
    for (const status of [400, 404, 413, 415, 507]) expect(previewUploadOutcome(status)).toBe("skip");
  });
});
