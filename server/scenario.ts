import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Source {
  id: string;
  type: "order" | "shipment" | "carrier_event" | "message" | "refund";
  recordedAt: string;
  content: string;
  /** Structured values the action layer may use; the model only ever sees `content`. */
  fields?: { carrier: string; trackingNumber: string };
}

export interface ScenarioCase {
  caseId: string;
  reason: string;
  providerStatus: string;
  amount: { value: string; currency: string };
  sellerResponseDue: string;
  orderRef: string;
  buyerMasked: string;
  buyerClaim: string;
  sources: Source[];
  pendingSources: Source[];
}

interface Scenario {
  merchant: { id: string; name: string; note: string };
  cases: ScenarioCase[];
}

const fixture = readFileSync(new URL("../fixtures/scenario.json", import.meta.url), "utf8");

let state: Scenario = JSON.parse(fixture);

export const merchant = () => state.merchant;
export const cases = () => state.cases;
export const findCase = (id: string) => state.cases.find((c) => c.caseId === id);

export function resetScenario() {
  state = JSON.parse(fixture);
}

/** Reveal the next pending record for a case, as if it had just been synced. */
export function advanceCase(id: string): Source | null {
  const c = findCase(id);
  const next = c?.pendingSources.shift();
  if (!c || !next) return null;
  c.sources.push(next);
  return next;
}

/** Revision of everything an assessment or approval depends on. Any change produces a new value. */
export function caseRevision(c: ScenarioCase): string {
  const bound = { caseId: c.caseId, status: c.providerStatus, amount: c.amount, claim: c.buyerClaim, sources: c.sources };
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex").slice(0, 16);
}
