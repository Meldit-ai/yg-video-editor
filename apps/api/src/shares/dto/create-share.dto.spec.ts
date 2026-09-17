import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import {
  CreateShareDto,
  MAX_SHARE_MEDIA,
  MAX_SHARE_MESSAGE,
  MAX_SHARE_VENDORS,
  WHATSAPP_BODY_LIMIT,
} from "./create-share.dto.js";

function validate(body: Record<string, unknown>): string[] {
  const dto = plainToInstance(CreateShareDto, body);
  return validateSync(dto).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `id_${index}`);
}

describe("CreateShareDto", () => {
  it("accepts a share at exactly the limits", () => {
    expect(
      validate({
        message: "Please review these.",
        submissionIds: ids(MAX_SHARE_MEDIA),
        vendorIds: ids(MAX_SHARE_VENDORS),
      }),
    ).toEqual([]);
  });

  it("refuses more videos than one share may carry", () => {
    // The dialog blocks this too, but the server is the authority: the same
    // request can arrive from anything holding a token.
    const errors = validate({
      message: "hi",
      submissionIds: ids(MAX_SHARE_MEDIA + 1),
      vendorIds: ids(1),
    });

    expect(errors).toContain(`Share at most ${MAX_SHARE_MEDIA} videos at a time`);
  });

  it("refuses more vendors than one send may reach", () => {
    const errors = validate({
      message: "hi",
      submissionIds: ids(1),
      vendorIds: ids(MAX_SHARE_VENDORS + 1),
    });

    expect(errors).toContain(
      `Send to at most ${MAX_SHARE_VENDORS} vendors at a time`,
    );
  });

  it("refuses a share with nothing selected", () => {
    const errors = validate({
      message: "hi",
      submissionIds: [],
      vendorIds: [],
    });

    expect(errors).toContain("Select at least one video to share");
    expect(errors).toContain("Select at least one vendor");
  });

  /**
   * These numbers are mirrored by hand in apps/web/src/lib/types.ts, which is
   * what the share dialog checks before it will send. Pinning them here means
   * a change on this side fails the suite rather than silently leaving the
   * browser refusing shares the server would have accepted, or the reverse.
   */
  it("keeps the limits the web app mirrors", () => {
    expect(MAX_SHARE_MEDIA).toBe(24);
    expect(MAX_SHARE_VENDORS).toBe(250);
  });

  it("derives the video cap from the body WhatsApp will accept", () => {
    // The point of deriving it: the largest legal share, with a full-length
    // note, still has to fit inside Meta's limit rather than near it.
    const worstCase = MAX_SHARE_MEDIA * 130 + MAX_SHARE_MESSAGE;
    expect(worstCase).toBeLessThanOrEqual(WHATSAPP_BODY_LIMIT);
  });
});
