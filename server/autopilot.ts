import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { attemptsFor, buildProposal, execute, isBlocker, targetFor, unresolved, type Attempt } from "./actions.ts";
import { assess, currentAssessment } from "./assessments.ts";
import { allCases, type AnyCase } from "./cases.ts";
import { caseRevision } from "./scenario.ts";

// The autopilot handles routine disputes under rules the seller sets. The AI only supplies the
// assessment; every decision below is plain code over that assessment and the case records, and every
// PayPal write goes through the same execute() path as the seller's own buttons.

export interface Rules {
  refundSmall: { on: boolean; maxAmount: number };
  submitEvidence: { on: boolean; maxAmount: number };
  messageBuyer: { on: boolean };
  /** Most the autopilot may refund in a single run, across all cases. */
  refundBudgetPerRun: number;
}

const DEFAULT_RULES: Rules = {
  refundSmall: { on: true, maxAmount: 15 },
  submitEvidence: { on: false, maxAmount: 100 },
  messageBuyer: { on: true },
  refundBudgetPerRun: 50,
};

const FILE = "private/autopilot.json";
let rules: Rules = existsSync(FILE) ? { ...DEFAULT_RULES, ...JSON.parse(readFileSync(FILE, "utf8")) } : DEFAULT_RULES;

export const getRules = () => rules;

export function setRules(next: Rules) {
  const money = (n: unknown, max: number) => Math.min(Math.max(Number(n) || 0, 0), max);
  rules = {
    refundSmall: { on: Boolean(next.refundSmall?.on), maxAmount: money(next.refundSmall?.maxAmount, 500) },
    submitEvidence: { on: Boolean(next.submitEvidence?.on), maxAmount: money(next.submitEvidence?.maxAmount, 5000) },
    messageBuyer: { on: Boolean(next.messageBuyer?.on) },
    refundBudgetPerRun: money(next.refundBudgetPerRun, 1000),
  };
  mkdirSync("private", { recursive: true });
  writeFileSync(FILE, JSON.stringify(rules, null, 2));
  return rules;
}

export type Decision =
  | { caseId: string; action: "refund" | "evidence" | "message"; rule: string; why: string }
  | { caseId: string; action: "needs_you" | "skip"; why: string };

export interface PlanItem {
  decision: Decision;
  amount: string;
  buyer: string;
  source: AnyCase["source"];
  simulated: boolean;
  outcome?: { state: Attempt["state"]; attemptId: string; error?: string };
}

const RULE_NAMES = {
  refund: "Refund small claims without tracking",
  evidence: "Submit evidence when the records support it",
  message: "Message the buyer first",
};

const NEEDS_ASSESSMENT = "Couldn't assess this case.";

const waitingOnSeller = (c: AnyCase) => c.providerStatus === "WAITING_FOR_SELLER_RESPONSE";
const allows = (c: AnyCase, rel: string) => c.source !== "paypal" || c.live.allowed.includes(rel);

function alreadyHandled(c: AnyCase): string | null {
  const past = attemptsFor(c.caseId).filter((a) => a.state !== "rejected");
  if (past.some((a) => a.kind === "refund")) return "Already refunded.";
  if (past.some((a) => (a.kind ?? "evidence") === "evidence")) return "Evidence already submitted.";
  return null;
}

function decide(c: AnyCase, budgetLeft: number): Decision {
  const amount = Number(c.amount.value);
  if (!waitingOnSeller(c)) return { caseId: c.caseId, action: "skip", why: `PayPal isn't waiting on you (${c.providerStatus.toLowerCase().replace(/_/g, " ")}).` };
  if (unresolved(c.caseId)) return { caseId: c.caseId, action: "needs_you", why: "An earlier action has an unknown outcome. Check it in PayPal first." };
  const handled = alreadyHandled(c);
  if (handled) return { caseId: c.caseId, action: "skip", why: handled };

  const shipment = c.sources.find((s) => s.type === "shipment" && s.fields);
  const messaged =
    c.sources.some((s) => s.type === "message" && /^Seller to buyer/.test(s.content)) ||
    attemptsFor(c.caseId).some((a) => a.kind === "message" && a.state !== "rejected");

  if (rules.refundSmall.on && !shipment && amount <= rules.refundSmall.maxAmount) {
    if (amount > budgetLeft) return { caseId: c.caseId, action: "needs_you", why: `Would refund $${c.amount.value}, but this run's refund budget is used up.` };
    if (!allows(c, "accept_claim")) return { caseId: c.caseId, action: "needs_you", why: "Qualifies for an automatic refund, but PayPal doesn't currently allow accepting this claim." };
    return { caseId: c.caseId, action: "refund", rule: RULE_NAMES.refund, why: `No shipment record and $${c.amount.value} is within your $${rules.refundSmall.maxAmount} limit.` };
  }

  const a = currentAssessment(c);
  if (!a) return { caseId: c.caseId, action: "needs_you", why: NEEDS_ASSESSMENT };
  const rec = a.output.recommendation;
  const clean = a.validation.unknownSourceIds.length === 0 && a.validation.uncitedDraftSentences === 0;

  if (rec === "review_remedy") return { caseId: c.caseId, action: "needs_you", why: `The assessment suggests a refund ($${c.amount.value}), above your automatic limit. Your call.` };
  if (!shipment) return { caseId: c.caseId, action: "needs_you", why: "No shipment details yet. Add tracking, or refund." };

  if (rules.submitEvidence.on && rec === "prepare_response" && clean && amount <= rules.submitEvidence.maxAmount && allows(c, "provide_evidence")) {
    return { caseId: c.caseId, action: "evidence", rule: RULE_NAMES.evidence, why: `Records support a response, every sentence is cited, and $${c.amount.value} is within your $${rules.submitEvidence.maxAmount} limit.` };
  }
  if (rules.messageBuyer.on && !messaged && allows(c, "send_message") && (c.source !== "paypal" || c.live.stage === "INQUIRY")) {
    return { caseId: c.caseId, action: "message", rule: RULE_NAMES.message, why: "Tracking is on file and the buyer hasn't heard from you yet." };
  }
  if (rec === "need_more_information") return { caseId: c.caseId, action: "needs_you", why: "The assessment needs more information before anyone responds." };
  return { caseId: c.caseId, action: "needs_you", why: "Ready for your review in Respond to PayPal." };
}

function buyerMessage(c: AnyCase): string {
  const s = c.sources.find((x) => x.type === "shipment" && x.fields)!;
  const status = c.sources.findLast((x) => x.type === "carrier_event");
  return [
    "Hello, and thank you for getting in touch.",
    `Your order was shipped with ${s.fields!.carrier}, tracking number ${s.fields!.trackingNumber}.`,
    status ? `The latest carrier update we have: ${status.content.replace(/^Entered by the seller from the \S+ tracking page: /, "")}` : "",
    "Could you check around your address and with anyone who might have taken it in? If it still hasn't turned up, reply here and we'll sort it out with you.",
  ]
    .filter(Boolean)
    .join(" ");
}

let lastRun: { at: string; dryRun: boolean; plan: PlanItem[] } | null = null;
export const getLastRun = () => lastRun;

/** Plans (dryRun) or carries out the rules over every open case. */
export async function runAutopilot(dryRun: boolean): Promise<NonNullable<typeof lastRun>> {
  const plan: PlanItem[] = [];
  let budgetLeft = rules.refundBudgetPerRun;

  for (const c of allCases()) {
    // Only pay for an assessment when the decision actually depends on one.
    let decision = decide(c, budgetLeft);
    if (decision.action === "needs_you" && decision.why === NEEDS_ASSESSMENT) {
      await assess(c).catch(() => {});
      decision = decide(c, budgetLeft);
    }
    const target = targetFor(c.caseId);
    const item: PlanItem = { decision, amount: c.amount.value, buyer: c.buyerMasked, source: c.source, simulated: target.mode === "simulated" };
    plan.push(item);
    if (decision.action === "refund") budgetLeft -= Number(c.amount.value);
    if (decision.action === "needs_you" || decision.action === "skip") continue;
    if (dryRun) continue;

    try {
      const rule = "rule" in decision ? decision.rule : undefined;
      const meta = { digest: caseRevision(c), target, by: "autopilot" as const, rule };
      let attempt: Attempt;
      if (decision.action === "refund") {
        attempt = await execute(c, { kind: "refund", note: "Refunded in full by the seller." }, { ...meta, summary: `Full refund of $${c.amount.value}` });
      } else if (decision.action === "message") {
        const message = buyerMessage(c);
        attempt = await execute(c, { kind: "message", message }, { ...meta, summary: `Message: "${message}"` });
      } else {
        const proposal = buildProposal(c, currentAssessment(c));
        if (isBlocker(proposal)) throw new Error(proposal.reason);
        attempt = await execute(c, { kind: "evidence", evidence: proposal.evidence }, {
          ...meta,
          digest: proposal.digest,
          target: proposal.target,
          summary: `Proof of delivery: ${proposal.evidence.carrier} ${proposal.evidence.trackingNumber}`,
        });
      }
      item.outcome = { state: attempt.state, attemptId: attempt.id, error: attempt.error };
    } catch (err) {
      item.outcome = { state: "rejected", attemptId: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  lastRun = { at: new Date().toISOString(), dryRun, plan };
  return lastRun;
}
