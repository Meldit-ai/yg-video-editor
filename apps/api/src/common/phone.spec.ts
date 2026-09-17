import { describe, expect, it } from "vitest";
import { isWhatsAppReachable, toWhatsAppNumber } from "./phone.js";

describe("toWhatsAppNumber", () => {
  it("prefixes the country code onto a bare Indian mobile", () => {
    // The shape almost every stored vendor row actually has.
    expect(toWhatsAppNumber("8765432109")).toBe("918765432109");
    expect(toWhatsAppNumber("9999999999")).toBe("919999999999");
    expect(toWhatsAppNumber("6000000000")).toBe("916000000000");
  });

  it("drops a trunk zero before prefixing", () => {
    expect(toWhatsAppNumber("08765432109")).toBe("918765432109");
  });

  it("keeps a number that already carries the country code", () => {
    expect(toWhatsAppNumber("918765432109")).toBe("918765432109");
  });

  it("strips the plus from an international number and trusts it", () => {
    expect(toWhatsAppNumber("+918765432109")).toBe("918765432109");
    expect(toWhatsAppNumber("+14155550123")).toBe("14155550123");
  });

  it("tolerates separators that survived an import", () => {
    expect(toWhatsAppNumber("+91 87654-32109")).toBe("918765432109");
    expect(toWhatsAppNumber(" 8765432109 ")).toBe("918765432109");
  });

  it("refuses a ten-digit number that is not a mobile", () => {
    // Starts 1-5: a landline or junk. Prefixing +91 would dial a stranger.
    expect(toWhatsAppNumber("1234567890")).toBeNull();
    expect(toWhatsAppNumber("5000000000")).toBeNull();
  });

  it("refuses a bare number long enough to be another country's", () => {
    // 11-15 digits with no "+" could be anywhere. Guessing reaches a real
    // person who never asked to hear from us.
    expect(toWhatsAppNumber("441234567890")).toBeNull();
    expect(toWhatsAppNumber("12345678901234")).toBeNull();
  });

  it("refuses anything that is not a number", () => {
    expect(toWhatsAppNumber("not a phone")).toBeNull();
    expect(toWhatsAppNumber("")).toBeNull();
    expect(toWhatsAppNumber("   ")).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber(undefined)).toBeNull();
  });

  it("refuses a plus followed by too few or too many digits", () => {
    expect(toWhatsAppNumber("+123")).toBeNull();
    expect(toWhatsAppNumber("+1234567890123456")).toBeNull();
  });

  it("agrees with isWhatsAppReachable", () => {
    expect(isWhatsAppReachable("8765432109")).toBe(true);
    expect(isWhatsAppReachable("1234567890")).toBe(false);
  });
});
