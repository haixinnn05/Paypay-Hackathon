import { env, paypalConfigured } from "./env.ts";

// Sandbox only. There is deliberately no switch to the live host.
const BASE = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface DisputeLink {
  href: string;
  rel: string;
  method: string;
}

export interface DisputeSummary {
  dispute_id: string;
  reason: string;
  status: string;
  dispute_amount?: { currency_code: string; value: string };
  create_time?: string;
  update_time?: string;
  links?: DisputeLink[];
}

export interface DisputeDetail extends DisputeSummary {
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  seller_response_due_date?: string;
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    invoice_number?: string;
    gross_amount?: { currency_code: string; value: string };
  }>;
  evidences?: unknown[];
  offer?: unknown;
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (!paypalConfigured()) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set");
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;

  const basic = Buffer.from(`${env.paypalClientId}:${env.paypalClientSecret}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw toError("OAuth token request failed", res, body);

  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

function toError(what: string, res: Response, body: any): PayPalError {
  const debugId = res.headers.get("paypal-debug-id") ?? body?.debug_id ?? null;
  const detail = body?.message ?? body?.error_description ?? res.statusText;
  return new PayPalError(`${what}: ${res.status} ${detail}`, res.status, debugId, body);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw toError(`GET ${path}`, res, body);
  return body as T;
}

export async function listDisputes(): Promise<DisputeSummary[]> {
  const body = await get<{ items?: DisputeSummary[] }>("/v1/customer/disputes?page_size=50");
  return body.items ?? [];
}

export function getDispute(id: string): Promise<DisputeDetail> {
  return get<DisputeDetail>(`/v1/customer/disputes/${encodeURIComponent(id)}`);
}

export interface FulfillmentEvidence {
  carrier: string;
  trackingNumber: string;
  notes: string;
}

/** The provide-evidence link PayPal currently advertises for this dispute, or null if it offers none. */
export function evidenceLink(d: DisputeDetail): DisputeLink | null {
  const link = d.links?.find((l) => l.rel === "provide_evidence" && l.method === "POST");
  const expected = `${BASE}/v1/customer/disputes/${encodeURIComponent(d.dispute_id)}/provide-evidence`;
  return link && link.href === expected ? link : null;
}

export function evidenceInput(e: FulfillmentEvidence) {
  return {
    evidences: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: { tracking_info: [{ carrier_name: e.carrier, tracking_number: e.trackingNumber }] },
        notes: e.notes,
      },
    ],
  };
}

/**
 * POSTs evidence to the exact link PayPal advertised. PayPal expects multipart/form-data with a JSON part
 * named "input"; it is built by hand because FormData would add a filename to that part.
 */
export async function provideEvidence(link: DisputeLink, e: FulfillmentEvidence, signal?: AbortSignal): Promise<unknown> {
  const boundary = `----dispute-copilot-${crypto.randomUUID()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="input"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(evidenceInput(e))}\r\n` +
    `--${boundary}--\r\n`;

  const res = await fetch(link.href, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw toError("Provide evidence", res, json);
  return json;
}
