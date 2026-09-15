import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { CreateCampaignDto } from "./create-campaign.dto.js";

/** The same options main.ts installs, so a spec failure means a real 400. */
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function check(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateCampaignDto, { title: "A", ...body });
  return { dto, errors: validateSync(dto as object, OPTIONS) };
}

describe("CreateCampaignDto.duplicationThreshold", () => {
  it("is optional, so an omitted field falls back to the column default", () => {
    const { dto, errors } = check({});
    expect(errors).toHaveLength(0);
    expect(dto.duplicationThreshold).toBeUndefined();
  });

  it("accepts the string a number input posts, as a number", () => {
    const { dto, errors } = check({ duplicationThreshold: "20" });
    expect(errors).toHaveLength(0);
    expect(dto.duplicationThreshold).toBe(20);
  });

  it("accepts both ends of the range", () => {
    expect(check({ duplicationThreshold: 0 }).errors).toHaveLength(0);
    expect(check({ duplicationThreshold: 100 }).errors).toHaveLength(0);
  });

  it("rejects values outside it", () => {
    expect(check({ duplicationThreshold: 101 }).errors).toHaveLength(1);
    expect(check({ duplicationThreshold: -1 }).errors).toHaveLength(1);
  });

  it("rejects a value that is not a number", () => {
    expect(check({ duplicationThreshold: "abc" }).errors).toHaveLength(1);
  });

  it("rejects a tiny fraction rather than throwing", () => {
    // @IsNumber({ maxDecimalPlaces }) would TypeError here in class-validator
    // 0.15 — a 500 instead of a 400. See IsAtMostTwoDecimalPlaces in
    // users/dto/create-user.dto.ts. This asserts we did not reintroduce it.
    expect(() => check({ duplicationThreshold: 1e-7 })).not.toThrow();
    expect(check({ duplicationThreshold: 1e-7 }).errors).toHaveLength(0);
  });
});
