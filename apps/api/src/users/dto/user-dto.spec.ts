import { describe, it, expect } from "vitest";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateUserDto } from "./create-user.dto.js";
import { UpdateUserDto } from "./update-user.dto.js";

/**
 * The rate-card rules, exercised through the *same* ValidationPipe options
 * main.ts installs. Constructing the pipe here rather than asserting on
 * class-validator directly is the point: the bug this guards against was a
 * validator that threw instead of returning false, which a direct
 * `validate()` assertion would have reported as a passing rejection while the
 * running API answered 500.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const create = (rateCard: unknown): Promise<unknown> =>
  pipe.transform(
    { mobile: "9876543210", name: "Asha", role: "EDITOR", rateCard },
    { type: "body", metatype: CreateUserDto },
  );

const update = (rateCard: unknown): Promise<unknown> =>
  pipe.transform(
    { rateCard },
    { type: "body", metatype: UpdateUserDto },
  );

describe("rateCard validation", () => {
  it.each([0, 1500, 1750.5, 1750.55, 0.01])("accepts %p", async (value) => {
    await expect(create(value)).resolves.toMatchObject({ rateCard: value });
    await expect(update(value)).resolves.toMatchObject({ rateCard: value });
  });

  it("accepts null, which is how a rate is cleared", async () => {
    await expect(update(null)).resolves.toMatchObject({ rateCard: null });
  });

  it("accepts an omitted rateCard", async () => {
    await expect(
      pipe.transform(
        { mobile: "9876543210", name: "Asha" },
        { type: "body", metatype: CreateUserDto },
      ),
    ).resolves.toMatchObject({ mobile: "9876543210", name: "Asha" });
  });

  /**
   * 1e-7 is the regression case: class-validator's own
   * `maxDecimalPlaces` reads `value.toString().split(".")[1].length`, and
   * "1e-7" has no "." — the TypeError escaped the pipe as a 500 rather than
   * being reported as a 400.
   */
  it.each([
    ["more than two decimals", 1500.555],
    ["a negative rate", -1],
    ["exponential-notation fractions", 1e-7],
    ["negative exponential-notation fractions", -1e-7],
    ["a numeric string", "1500"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s with a 400, never a thrown TypeError", async (_label, value) => {
    await expect(create(value)).rejects.toBeInstanceOf(BadRequestException);
    await expect(update(value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an undeclared key, because the pipe forbids non-whitelisted", async () => {
    await expect(
      pipe.transform(
        { mobile: "9876543210", name: "Asha", rate: 1500 },
        { type: "body", metatype: CreateUserDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
