import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paypalConfigured } from "./env.ts";
import { getDispute, listDisputes, type DisputeDetail } from "./paypal.ts";
import type { ScenarioCase, Source } from "./scenario.ts";

// Live cases: the merchant's real PayPal sandbox disputes, turned into the same case shape the rest of
// the app uses. Their records come from PayPal itself (transaction, messages, refunds) plus shipment
// details the seller enters here, since PayPal doesn't know the seller's tracking for a plain payment.

export interface LiveMeta {
  stage: string | null;
  status: string;
  allowed: string[];
  sellerProtection: string | null;
  syncedAt: string;
}

export type LiveCase = ScenarioCase & { source: "paypal"; live: LiveMeta };

// --- Seller-entered records -------------------------------------------------------------

export interface ShipmentInput {
  carrier: string;
  trackingNumber: string;
  shippedOn: string;
  carrierStatus?: string;
}

interface SellerRecord {
  type: "shipment" | "carrier_event";
  recordedAt: string;
  content: string;
  fields?: { carrier: string; trackingNumber: string };
}

const RECORDS = "private/seller-records.json";
let sellerRecords: Record<string, SellerRecord[]> = existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, "utf8")) : {};

export function addShipment(caseId: string, s: ShipmentInput) {
  const now = new Date().toISOString();
  const records: SellerRecord[] = [
    {
      type: "shipment",
      recordedAt: now,
      content: `Entered by the seller: shipped with ${s.carrier}, tracking ${s.trackingNumber}, on ${s.shippedOn}.`,
      fields: { carrier: s.carrier, trackingNumber: s.trackingNumber },
    },
  ];
  if (s.carrierStatus?.trim()) {
    records.push({ type: "carrier_event", recordedAt: now, content: `Entered by the seller from the ${s.carrier} tracking page: ${s.carrierStatus.trim()}` });
  }
  sellerRecords[caseId] = [...(sellerRecords[caseId] ?? []), ...records];
  mkdirSync("private", { recursive: true });
  writeFileSync(RECORDS, JSON.stringify(sellerRecords, null, 2));
  const cached = live.get(caseId);
  if (cached) live.set(caseId, rebuild(cached));
}

// --- PayPal disputes -> cases -----------------------------------------------------------

const live = new Map<string, LiveCase>();
const details = new Map<string, DisputeDetail>();
let lastSync: { at: string; error: string | null } | null = null;

const mask = (name?: string) => {
  const parts = (name ?? "Buyer").trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.at(-1)![0]}*****` : `${parts[0][0]}*****`;
};

function sourcesFrom(d: DisputeDetail, caseId: string): Source[] {
  const raw: Omit<Source, "id">[] = [];
  for (const t of d.disputed_transactions ?? []) {
    const items = (t.items ?? []).map((i) => `${i.item_quantity ?? 1} x ${i.item_name ?? "item"}`).join(", ") || "not listed";
    const protection = t.seller_protection_eligible ? `eligible (${t.seller_protection_type ?? "type not given"})` : "not eligible";
    raw.push({
      type: "paypal_transaction",
      recordedAt: t.create_time ?? d.create_time ?? new Date(0).toISOString(),
      content: `PayPal transaction ${t.seller_transaction_id ?? "unknown"}: ${t.gross_amount?.value ?? "?"} ${t.gross_amount?.currency_code ?? ""}, status ${t.transaction_status ?? "unknown"}. Items: ${items}. Seller Protection: ${protection}.`,
    });
  }
  for (const m of d.messages ?? []) {
    if (!m.content?.trim()) continue;
    const who = m.posted_by === "SELLER" ? "Seller to buyer" : m.posted_by === "ARBITER" ? "PayPal to both parties" : "Buyer to seller";
    raw.push({ type: "message", recordedAt: m.time_posted ?? d.create_time ?? "", content: `${who}, through PayPal: ${m.content.trim()}` });
  }
  for (const e of d.evidences ?? []) {
    if (e.source === "SUBMITTED_BY_SELLER") {
      raw.push({ type: "message", recordedAt: e.date ?? "", content: `Evidence already sent to PayPal by the seller: ${e.evidence_type ?? "evidence"}${e.notes ? `. Notes: ${e.notes}` : ""}` });
    }
  }
  for (const r of sellerRecords[caseId] ?? []) raw.push(r);
  return raw
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .map((s, i) => ({ id: `S${i + 1}`, ...s }));
}

function toCase(d: DisputeDetail): LiveCase {
  const t = d.disputed_transactions?.[0];
  const firstBuyerWords =
    d.messages?.find((m) => m.posted_by === "BUYER" && m.content?.trim())?.content ??
    d.evidences?.find((e) => e.source === "SUBMITTED_BY_BUYER" && e.notes?.trim())?.notes ??
    "The buyer reports the item was not received.";
  const allowed = (d.links ?? []).filter((l) => l.method === "POST").map((l) => l.rel);
  return {
    source: "paypal",
    caseId: d.dispute_id,
    reason: d.reason,
    providerStatus: d.status,
    amount: { value: d.dispute_amount?.value ?? "0.00", currency: d.dispute_amount?.currency_code ?? "USD" },
    sellerResponseDue: d.seller_response_due_date ?? d.update_time ?? new Date().toISOString(),
    orderRef: t?.seller_transaction_id ?? d.dispute_id,
    buyerMasked: mask(t?.buyer?.name),
    buyerClaim: firstBuyerWords.trim(),
    sources: sourcesFrom(d, d.dispute_id),
    pendingSources: [],
    live: {
      stage: d.dispute_life_cycle_stage ?? null,
      status: d.status,
      allowed,
      sellerProtection: t?.seller_protection_eligible ? (t.seller_protection_type ?? "eligible") : null,
      syncedAt: new Date().toISOString(),
    },
  };
}

const rebuild = (c: LiveCase): LiveCase => {
  const d = details.get(c.caseId);
  return d ? { ...toCase(d), live: { ...toCase(d).live, syncedAt: c.live.syncedAt } } : c;
};

/** Re-reads every dispute for this merchant. Disputes PayPal has closed stay out of the queue. */
export async function syncLive(): Promise<void> {
  if (!paypalConfigured()) return;
  try {
    const items = await listDisputes();
    const open = items.filter((i) => i.status !== "RESOLVED");
    const fresh = await Promise.all(open.map((i) => getDispute(i.dispute_id)));
    live.clear();
    details.clear();
    for (const d of fresh) {
      details.set(d.dispute_id, d);
      live.set(d.dispute_id, toCase(d));
    }
    lastSync = { at: new Date().toISOString(), error: null };
  } catch (err) {
    lastSync = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
  }
}

/** Re-reads one dispute, e.g. after acting on it. */
export async function refreshLive(caseId: string): Promise<LiveCase | null> {
  const d = await getDispute(caseId);
  details.set(caseId, d);
  const c = toCase(d);
  live.set(caseId, c);
  return c;
}

export const liveCases = () => [...live.values()];
export const findLive = (id: string) => live.get(id) ?? null;
export const liveSyncState = () => lastSync;
export const isLiveId = (id: string) => live.has(id);
