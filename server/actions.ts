import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AssessmentResult } from "./assess.ts";
import { env } from "./env.ts";
import { isLiveId, refreshLive } from "./live.ts";
import {
  acceptClaimRefund,
  actionLink,
  evidenceInput,
  getDispute,
  makeRefundOffer,
  PayPalError,
  provideEvidence,
  sendMessage,
  type DisputeAction,
  type FulfillmentEvidence,
} from "./paypal.ts";
import { caseRevision, merchant, type ScenarioCase } from "./scenario.ts";

const APPROVAL_TTL_MS = 5 * 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;

/** Scenario case -> real sandbox dispute, e.g. SANDBOX_LINKS="SCN-1002:PP-R-KUK-10194971". */
const links = new Map(
  (process.env.SANDBOX_LINKS ?? "")
    .split(",")
    .map((pair) => pair.trim().split(":"))
    .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0] && p[1])),
);
/** The real sandbox dispute a case acts on: a live case is its own dispute; a scenario case may be linked. */
export const linkedDispute = (caseId: string) => links.get(caseId) ?? (isLiveId(caseId) ? caseId : null);

export type Target = { mode: "sandbox"; disputeId: string } | { mode: "simulated"; reason: string };

export function targetFor(caseId: string): Target {
  const disputeId = linkedDispute(caseId);
  if (disputeId && env.allowSandboxWrites) return { mode: "sandbox", disputeId };
  return {
    mode: "simulated",
    reason: disputeId
      ? `Linked to PayPal sandbox dispute ${disputeId}, but live actions are turned off on this deployment.`
      : "This case isn't linked to a PayPal dispute.",
  };
}

export interface Proposal {
  caseId: string;
  amount: { value: string; currency: string };
  revision: string;
  assessmentCreatedAt: string;
  target: Target;
  action: "PROVIDE_EVIDENCE";
  evidence: FulfillmentEvidence;
  digest: string;
}

export type Blocker = { reason: string };

/** Builds the exact action the seller would approve, or explains why there is nothing to approve yet. */
export function buildProposal(c: ScenarioCase, a: AssessmentResult | undefined): Proposal | Blocker {
  const past = attemptsFor(c.caseId);
  const refunded = past.findLast((t) => t.kind === "refund" && (t.state === "done" || t.state === "simulated"));
  if (refunded) return { reason: `This case was refunded (${refunded.id}), so there is nothing to contest.` };
  const done = past.findLast((t) => (t.kind ?? "evidence") === "evidence" && (t.state === "evidence_accepted" || t.state === "simulated"));
  if (done) return { reason: `Evidence was already submitted for this case (${done.id}). PayPal accepts one response per case.` };
  if (!a) return { reason: "Run an assessment first." };
  if (a.revision !== caseRevision(c)) return { reason: "Records changed since the assessment. Reassess before approving." };
  if (a.output.recommendation !== "prepare_response") {
    return { reason: "The assessment does not recommend contesting this case. Review it in PayPal instead." };
  }
  if (a.validation.unknownSourceIds.length > 0 || a.validation.uncitedDraftSentences > 0) {
    return { reason: "The draft has citation problems. Reassess before approving." };
  }
  const shipment = c.sources.find((s) => s.type === "shipment" && s.fields);
  if (!shipment?.fields) return { reason: "No shipment record with a carrier and tracking number." };

  const notes = a.output.draftResponse.map((d) => d.sentence).join(" ").slice(0, 2000);
  const unsigned = {
    merchant: merchant().id,
    caseId: c.caseId,
    amount: c.amount,
    revision: caseRevision(c),
    assessmentCreatedAt: a.createdAt,
    target: targetFor(c.caseId),
    action: "PROVIDE_EVIDENCE" as const,
    evidence: { carrier: shipment.fields.carrier, trackingNumber: shipment.fields.trackingNumber, notes },
  };
  const digest = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex").slice(0, 16);
  return { ...unsigned, digest };
}

export const isBlocker = (p: Proposal | Blocker): p is Blocker => "reason" in p;

// --- Approvals (one per case; replaced or consumed, never reused) ---

interface Approval {
  digest: string;
  approvedAt: string;
  expiresAt: number;
}
const approvals = new Map<string, Approval>();

export function approve(caseId: string, proposal: Proposal, digest: string): Approval {
  if (proposal.digest !== digest) throw new ActionError("This proposal changed before you approved it. Review it again.", 409);
  const approval = { digest, approvedAt: new Date().toISOString(), expiresAt: Date.now() + APPROVAL_TTL_MS };
  approvals.set(caseId, approval);
  return approval;
}

export function approvalState(caseId: string, proposal: Proposal | Blocker) {
  const a = approvals.get(caseId);
  if (!a) return { state: "none" as const };
  if (isBlocker(proposal) || a.digest !== proposal.digest) return { state: "review_changed" as const, approvedDigest: a.digest };
  if (Date.now() > a.expiresAt) return { state: "expired" as const, approvedDigest: a.digest };
  return { state: "approved" as const, approvedDigest: a.digest, expiresAt: new Date(a.expiresAt).toISOString() };
}

// --- Attempts (persisted so an unknown outcome survives a restart) ---

export type ActionKind = "evidence" | "message" | "refund" | "offer";

export interface Attempt {
  id: string;
  caseId: string;
  /** Older records have no kind; they are evidence submissions. */
  kind?: ActionKind;
  by?: "seller" | "autopilot";
  /** The autopilot rule that triggered this action, if any. */
  rule?: string;
  amount?: { value: string; currency: string };
  summary?: string;
  digest: string;
  target: Target;
  requestBody: unknown;
  state: "submitting" | "evidence_accepted" | "done" | "simulated" | "rejected" | "needs_reconciliation";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  debugId?: string | null;
  readBack?: { status: string; evidenceCount: number; observedAt: string } | { error: string };
}

const STORE = "private/attempts.json";
let attempts: Attempt[] = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : [];

function save() {
  mkdirSync("private", { recursive: true });
  writeFileSync(STORE, JSON.stringify(attempts, null, 2));
}

export const attemptsFor = (caseId: string) => attempts.filter((a) => a.caseId === caseId);
export const allAttempts = () => attempts;
export const unresolved = (caseId: string) => attemptsFor(caseId).find((a) => a.state === "submitting" || a.state === "needs_reconciliation");

export function resetSimulatedAttempts() {
  attempts = attempts.filter((a) => a.target.mode !== "simulated");
  approvals.clear();
  save();
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Executes exactly the approved proposal once. Every check runs again against fresh state first. */
export async function submit(caseId: string, proposal: Proposal | Blocker, digest: string): Promise<Attempt> {
  if (unresolved(caseId)) throw new ActionError(`An earlier action (${unresolved(caseId)!.id}) is unresolved. Reconcile it in PayPal first.`, 409);
  if (isBlocker(proposal)) throw new ActionError(proposal.reason, 409);

  const approval = approvals.get(caseId);
  if (!approval || approval.digest !== digest) throw new ActionError("No approval for this exact proposal.", 409);
  if (proposal.digest !== digest) throw new ActionError("The proposal changed after approval. Review it again.", 409);
  if (Date.now() > approval.expiresAt) throw new ActionError("The approval expired. Approve again.", 409);

  approvals.delete(caseId);
  return execute(
    { caseId, amount: proposal.amount },
    { kind: "evidence", evidence: proposal.evidence },
    { digest, target: proposal.target, by: "seller", summary: `Proof of delivery: ${proposal.evidence.carrier} ${proposal.evidence.trackingNumber}` },
  );
}

export type ActionSpec =
  | { kind: "evidence"; evidence: FulfillmentEvidence }
  | { kind: "message"; message: string }
  | { kind: "refund"; note: string }
  | { kind: "offer"; note: string; amount: { value: string; currency: string } };

const REL: Record<ActionKind, DisputeAction> = { evidence: "provide_evidence", message: "send_message", refund: "accept_claim", offer: "make_offer" };

function requestBody(spec: ActionSpec): unknown {
  switch (spec.kind) {
    case "evidence":
      return evidenceInput(spec.evidence);
    case "message":
      return { message: spec.message };
    case "refund":
      return { note: spec.note, accept_claim_type: "REFUND" };
    case "offer":
      return { note: spec.note, offer_type: "REFUND", offer_amount: { currency_code: spec.amount.currency, value: spec.amount.value } };
  }
}

/**
 * The one path every PayPal write takes, whether the seller clicked or the autopilot decided: record the
 * attempt, re-read the dispute, check the amount and that PayPal currently offers this action, send once,
 * then read the case back. A timeout leaves the case in Needs reconciliation and blocks further writes.
 */
export async function execute(
  c: { caseId: string; amount: { value: string; currency: string } },
  spec: ActionSpec,
  meta: { digest: string; target: Target; by: "seller" | "autopilot"; rule?: string; summary: string },
): Promise<Attempt> {
  const pending = unresolved(c.caseId);
  if (pending) throw new ActionError(`An earlier action (${pending.id}) is unresolved. Reconcile it in PayPal first.`, 409);

  const attempt: Attempt = {
    id: `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    caseId: c.caseId,
    kind: spec.kind,
    by: meta.by,
    rule: meta.rule,
    amount: c.amount,
    summary: meta.summary,
    digest: meta.digest,
    target: meta.target,
    requestBody: requestBody(spec),
    state: "submitting",
    startedAt: new Date().toISOString(),
  };
  attempts.push(attempt);
  save();

  if (meta.target.mode === "simulated") return finish(attempt, { state: "simulated" });

  const disputeId = meta.target.disputeId;
  let link;
  try {
    const live = await getDispute(disputeId);
    const paid = live.dispute_amount;
    if (!paid || paid.value !== c.amount.value || paid.currency_code !== c.amount.currency) {
      const shown = paid ? `${paid.value} ${paid.currency_code}` : "no amount";
      return finish(attempt, {
        state: "rejected",
        error: `PayPal dispute ${disputeId} is for ${shown}, but this case is for ${c.amount.value} ${c.amount.currency}. Check the case is linked to the right dispute.`,
      });
    }
    link = actionLink(live, REL[spec.kind]);
    if (spec.kind === "evidence" && live.status !== "WAITING_FOR_SELLER_RESPONSE") link = null;
    if (!link) return finish(attempt, { state: "rejected", error: `PayPal does not currently allow this action on ${disputeId} (status ${live.status}).` });
  } catch (err) {
    // Nothing was sent yet, so this is a clean failure rather than an unknown outcome.
    return finish(attempt, { state: "rejected", ...errorFields(err) });
  }

  const signal = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  try {
    if (spec.kind === "evidence") await provideEvidence(link, spec.evidence, signal);
    else if (spec.kind === "message") await sendMessage(link, spec.message, signal);
    else if (spec.kind === "refund") await acceptClaimRefund(link, spec.note, signal);
    else await makeRefundOffer(link, spec.note, spec.amount, signal);
  } catch (err) {
    // A PayPal error response means the request was refused. Anything else (timeout, network) may have reached PayPal.
    const state = err instanceof PayPalError ? "rejected" : "needs_reconciliation";
    return finish(attempt, { state, ...errorFields(err) });
  }

  finish(attempt, { state: spec.kind === "evidence" ? "evidence_accepted" : "done" });
  try {
    const after = await getDispute(disputeId);
    attempt.readBack = { status: after.status, evidenceCount: after.evidences?.length ?? 0, observedAt: new Date().toISOString() };
    if (isLiveId(disputeId)) await refreshLive(disputeId).catch(() => {});
  } catch (err) {
    attempt.readBack = { error: errorFields(err).error };
  }
  save();
  return attempt;
}

function finish(attempt: Attempt, update: Partial<Attempt>): Attempt {
  Object.assign(attempt, update, { finishedAt: new Date().toISOString() });
  save();
  return attempt;
}

function errorFields(err: unknown) {
  return { error: err instanceof Error ? err.message : String(err), debugId: err instanceof PayPalError ? err.debugId : null };
}
