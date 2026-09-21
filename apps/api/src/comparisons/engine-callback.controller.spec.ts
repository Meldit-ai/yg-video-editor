import { createHmac } from "node:crypto";
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineCallbackController } from "./engine-callback.controller.js";
import { EngineJobNotifications } from "./engine-job-notifications.js";

const SECRET_ENV = "COMPARISON_ENGINE_CALLBACK_SECRET";
const SECRET = "engine-shared-secret";

/** Builds a valid `X-Engine-Signature` header for `rawBody`, same primitive as engine-callback.signature.spec.ts. */
function sign(rawBody: Buffer, secret = SECRET, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  const digest = createHmac("sha256", secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${t},v1=${digest}`;
}

function rawOf(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body));
}

describe("EngineCallbackController", () => {
  let notifications: EngineJobNotifications;
  let controller: EngineCallbackController;

  beforeEach(() => {
    process.env[SECRET_ENV] = SECRET;
    notifications = new EngineJobNotifications();
    controller = new EngineCallbackController(notifications);
  });

  afterEach(() => {
    delete process.env[SECRET_ENV];
  });

  it("answers 503 naming the missing secret when it is unset", () => {
    delete process.env[SECRET_ENV];
    const raw = rawOf({ job_id: "job-1" });

    expect(() => controller.receive(raw, sign(raw))).toThrow(
      ServiceUnavailableException,
    );
    expect(() => controller.receive(raw, sign(raw))).toThrow(
      "Engine callbacks are not configured. Missing: COMPARISON_ENGINE_CALLBACK_SECRET",
    );
  });

  it("answers 503 when the secret is only whitespace", () => {
    process.env[SECRET_ENV] = "   ";
    const raw = rawOf({ job_id: "job-1" });

    expect(() => controller.receive(raw, sign(raw))).toThrow(
      ServiceUnavailableException,
    );
  });

  it("answers 400 without a raw body", () => {
    const signature = sign(rawOf({ job_id: "job-1" }));

    expect(() => controller.receive(undefined, signature)).toThrow(
      BadRequestException,
    );
    expect(() => controller.receive(undefined, signature)).toThrow(
      "Expected a JSON body",
    );
  });

  it("answers 401 on a bad signature", () => {
    const raw = rawOf({ job_id: "job-1" });

    expect(() => controller.receive(raw, sign(raw, "wrong-secret"))).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.receive(raw, sign(raw, "wrong-secret"))).toThrow(
      "Invalid engine signature",
    );
  });

  it("answers 401 when the signature header is missing", () => {
    const raw = rawOf({ job_id: "job-1" });

    expect(() => controller.receive(raw, undefined)).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.receive(raw, undefined)).toThrow(
      "Invalid engine signature",
    );
  });

  it("answers 400 when the body is not JSON, even under a valid signature", () => {
    const raw = Buffer.from("not json");

    expect(() => controller.receive(raw, sign(raw))).toThrow(
      BadRequestException,
    );
    expect(() => controller.receive(raw, sign(raw))).toThrow(
      "Body is not valid JSON",
    );
  });

  it("answers 400 when job_id is missing", () => {
    const raw = rawOf({ status: "succeeded" });

    expect(() => controller.receive(raw, sign(raw))).toThrow(
      BadRequestException,
    );
    expect(() => controller.receive(raw, sign(raw))).toThrow("Missing job_id");
  });

  it("answers 400 when the payload is not an object", () => {
    const raw = rawOf(["job-1"]);

    expect(() => controller.receive(raw, sign(raw))).toThrow(
      BadRequestException,
    );
    expect(() => controller.receive(raw, sign(raw))).toThrow("Missing job_id");
  });

  it("resolves a waiting job and returns outcome resolved", async () => {
    const payload = { job_id: "job-1", status: "succeeded" };
    const raw = rawOf(payload);
    const waiting = notifications.waitFor("job-1");

    expect(controller.receive(raw, sign(raw))).toEqual({
      received: true,
      outcome: "resolved",
    });
    await expect(waiting).resolves.toEqual(payload);
  });

  it("buffers an unknown job and returns outcome buffered", () => {
    const payload = { job_id: "job-2", status: "succeeded" };
    const raw = rawOf(payload);

    expect(controller.receive(raw, sign(raw))).toEqual({
      received: true,
      outcome: "buffered",
    });
  });
});
