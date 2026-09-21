export const ENGINE_CALLBACK_CONTROLLER = "comparisons";
export const ENGINE_CALLBACK_ACTION = "engine-callback";
/** Absolute path as seen from outside the API: the global prefix "api" (main.ts) + controller + action. */
export const ENGINE_CALLBACK_PATH = "/api/comparisons/engine-callback";

/**
 * The full callback URL to hand the engine, or `null` when callback mode is
 * off. Pure and env-driven (rather than a method on the client) so both
 * `ComparisonEngineClient.callbackUrl` and the boot-time log line in
 * `main.ts` compute the exact same value from the exact same rule.
 */
export function resolveEngineCallbackUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = (env.API_PUBLIC_URL ?? "").trim();
  if (configured.length === 0) return null;
  return `${configured.replace(/\/+$/, "")}${ENGINE_CALLBACK_PATH}`;
}
