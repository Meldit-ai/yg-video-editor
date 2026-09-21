import { describe, expect, it } from "vitest";
import {
  ENGINE_CALLBACK_ACTION,
  ENGINE_CALLBACK_CONTROLLER,
  ENGINE_CALLBACK_PATH,
  resolveEngineCallbackUrl,
} from "./engine-callback.route.js";

describe("engine callback route constants", () => {
  it("composes the absolute path from the global prefix, controller, and action", () => {
    expect(ENGINE_CALLBACK_PATH).toBe(
      `/api/${ENGINE_CALLBACK_CONTROLLER}/${ENGINE_CALLBACK_ACTION}`,
    );
  });
});

describe("resolveEngineCallbackUrl", () => {
  it("is null when API_PUBLIC_URL is unset (or blank)", () => {
    expect(resolveEngineCallbackUrl({})).toBeNull();
    expect(resolveEngineCallbackUrl({ API_PUBLIC_URL: "   " })).toBeNull();
  });

  it("strips a trailing slash before appending the callback path", () => {
    expect(resolveEngineCallbackUrl({ API_PUBLIC_URL: "https://editor.example/" })).toBe(
      `https://editor.example${ENGINE_CALLBACK_PATH}`,
    );
  });
});
