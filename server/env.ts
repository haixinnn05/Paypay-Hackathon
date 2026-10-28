import { existsSync } from "node:fs";

// Load .env if present; real environment variables (e.g. on Render) take precedence.
if (existsSync(".env")) process.loadEnvFile(".env");

export const env = {
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? "",
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  paypalDisputeId: process.env.PAYPAL_DISPUTE_ID ?? "",
  gatewayUrl: process.env.ASTRO_GATEWAY_URL ?? "",
  gatewayKey: process.env.ASTRO_GATEWAY_API_KEY ?? "",
  port: Number(process.env.PORT ?? 8787),
  /** Real PayPal sandbox submissions happen only when this is "true"; otherwise linked cases are simulated. */
  allowSandboxWrites: process.env.ALLOW_SANDBOX_WRITES === "true",
  /** "live" calls the AI Gateway; "saved" serves pre-generated results only. Defaults to live when a key is set. */
  aiMode: (process.env.AI_MODE ?? (process.env.ASTRO_GATEWAY_API_KEY ? "live" : "saved")) as "live" | "saved",
  production: process.env.NODE_ENV === "production",
};

export const paypalConfigured = () => Boolean(env.paypalClientId && env.paypalClientSecret);
