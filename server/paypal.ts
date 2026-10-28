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
    create_time?: string;
    transaction_status?: string;
    gross_amount?: { currency_code: string; value: string };
    buyer?: { name?: string };
    items?: Array<{ item_name?: string; item_description?: string; item_quantity?: string }>;
    seller_protection_eligible?: boolean;
    seller_protection_type?: string;
  }>;
  messages?: Array<{ posted_by?: string; time_posted?: string; content?: string }>;
  evidences?: Array<{ evidence_type?: string; source?: string; notes?: string; date?: string }>;
  refund_details?: { allowed_refund_amount?: { currency_code: string; value: string } };
  allowed_response_options?: {
    accept_claim?: { accept_claim_types?: string[] };
    make_offer?: { offer_types?: string[] };
  };
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

export type DisputeAction = "provide_evidence" | "send_message" | "make_offer" | "accept_claim";

/** The link PayPal currently advertises for this action on this dispute, or null if it offers none. */
export function actionLink(d: DisputeDetail, rel: DisputeAction): DisputeLink | null {
  const link = d.links?.find((l) => l.rel === rel && l.method === "POST");
  const expected = `${BASE}/v1/customer/disputes/${encodeURIComponent(d.dispute_id)}/${rel.replace("_", "-")}`;
  return link && link.href === expected ? link : null;
}

export const evidenceLink = (d: DisputeDetail) => actionLink(d, "provide_evidence");

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
 * POSTs to the exact link PayPal advertised. Most dispute actions take multipart/form-data with a JSON
 * part named "input"; it is built by hand because FormData would add a filename to that part.
 */
async function postInput(link: DisputeLink, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const boundary = `----dispute-copilot-${crypto.randomUUID()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="input"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(input)}\r\n` +
    `--${boundary}--\r\n`;
  const res = await fetch(link.href, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw toError(link.rel, res, json);
  return json;
}

async function postJson(link: DisputeLink, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(link.href, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw toError(link.rel, res, json);
  return json;
}

export const provideEvidence = (link: DisputeLink, e: FulfillmentEvidence, signal?: AbortSignal) => postInput(link, evidenceInput(e), signal);

export const sendMessage = (link: DisputeLink, message: string, signal?: AbortSignal) => postInput(link, { message }, signal);

/** Full refund, closing the dispute in the buyer's favour. PayPal moves the money. */
export const acceptClaimRefund = (link: DisputeLink, note: string, signal?: AbortSignal) =>
  postInput(link, { note, accept_claim_type: "REFUND" }, signal);

export const makeRefundOffer = (link: DisputeLink, note: string, amount: { value: string; currency: string }, signal?: AbortSignal) =>
  postJson(link, { note, offer_type: "REFUND", offer_amount: { currency_code: amount.currency, value: amount.value } }, signal);
