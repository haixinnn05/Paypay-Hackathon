import express, { type Response } from "express";
import { existsSync } from "node:fs";
import { env, paypalConfigured } from "./env.ts";
import { ActionError, approvalState, approve, attemptsFor, buildProposal, isBlocker, linkedDispute, resetSimulatedAttempts, submit, type Attempt } from "./actions.ts";
import { allCases, findAny, type AnyCase } from "./cases.ts";
import { getLastRun, getRules, runAutopilot, setRules } from "./autopilot.ts";
import { allAttempts } from "./actions.ts";
import { addShipment, liveSyncState, refreshLive, syncLive } from "./live.ts";
import type { AssessmentResult } from "./assess.ts";
import { assess, clearAssessments, latestAssessment, NoSavedResult } from "./assessments.ts";
import { rateLimit } from "./limit.ts";
import { getDispute, listDisputes, PayPalError } from "./paypal.ts";
import { advanceCase, caseRevision, merchant, resetScenario } from "./scenario.ts";

const app = express();
app.set("trust proxy", 1); // Render and similar hosts sit behind one proxy; needed for per-visitor limits.
app.use(express.json({ limit: "2mb" }));

const assessLimit = rateLimit("assessment", Number(process.env.ASSESS_LIMIT ?? 15), Number(process.env.ASSESS_DAILY_LIMIT ?? 200));
// One assistant question makes several model calls, so this limit is per model call.
const aiLimit = rateLimit("assistant", Number(process.env.AI_LIMIT ?? 80), Number(process.env.AI_DAILY_LIMIT ?? 600));

// What PayPal last reported for linked cases, from "Refresh from PayPal" or a submission's read-back.
const observed = new Map<string, { status: string; observedAt: string }>();

function paypalObservation(caseId: string): { status: string; observedAt: string } | null {
  const fromRefresh = observed.get(caseId);
  const seen = attemptsFor(caseId).findLast((a) => a.target.mode === "sandbox" && a.readBack && "status" in a.readBack);
  const fromAttempt = seen?.readBack && "status" in seen.readBack ? { status: seen.readBack.status, observedAt: seen.readBack.observedAt } : null;
  if (!fromRefresh) return fromAttempt;
  if (!fromAttempt) return fromRefresh;
  return fromRefresh.observedAt > fromAttempt.observedAt ? fromRefresh : fromAttempt;
}

/** For a case linked to a real sandbox dispute, the status PayPal last reported beats the fixture's. */
function providerStatus(c: AnyCase): string {
  return paypalObservation(c.caseId)?.status ?? c.providerStatus;
}

const CLOSED_STEPS = new Set(["Evidence submitted", "Refunded", "Closed by PayPal", "Waiting for buyer", "Under PayPal review"]);

function queueRow(c: AnyCase) {
  const a = latestAssessment(c.caseId);
  const revision = caseRevision(c);
  const last = attemptsFor(c.caseId).findLast((t) => t.state !== "rejected");
  const step = nextStep(a, revision, last, providerStatus(c));
  const daysLeft = (new Date(c.sellerResponseDue).getTime() - Date.now()) / 86_400_000;
  const closed = CLOSED_STEPS.has(step);
  return {
    source: c.source,
    nextStep: step,
    needsAction: closed ? 0 : 1,
    answered: closed ? 1 : 0,
    dueThisWeek: !closed && daysLeft <= 7 ? 1 : 0,
    caseId: c.caseId,
    orderRef: c.orderRef,
    buyer: c.buyerMasked,
    amount: Number(c.amount.value),
    currency: c.amount.currency,
    providerStatus: providerStatus(c),
    sellerResponseDue: c.sellerResponseDue,
    sourceCount: c.sources.length,
    recommendation: a?.output.recommendation ?? null,
    assessmentState: !a ? "needs_assessment" : a.revision === revision ? "current" : "review_changed",
    approvalState: approvalState(c.caseId, buildProposal(c, a)).state,
    lastAttempt: last?.state ?? null,
    linkedDispute: linkedDispute(c.caseId),
    revision,
  };
}

/** One plain-language label per case, used to group the queue and the dashboard charts. */
function nextStep(a: AssessmentResult | undefined, revision: string, last: Attempt | undefined, status: string): string {
  if (last?.state === "needs_reconciliation") return "Reconcile in PayPal";
  const kind = last?.kind ?? "evidence";
  const happened = last && (last.state === "evidence_accepted" || last.state === "done" || last.state === "simulated");
  if (happened && kind === "refund") return "Refunded";
  if (happened && kind === "evidence") return "Evidence submitted";
  if (status === "RESOLVED") return "Closed by PayPal";
  // A live dispute that isn't waiting on the seller has nothing for the seller to do right now.
  if (status === "WAITING_FOR_BUYER_RESPONSE") return "Waiting for buyer";
  if (status === "UNDER_REVIEW") return "Under PayPal review";
  if (happened && kind === "offer") return "Refund offered";
  if (happened && kind === "message" && (!a || a.revision === revision)) return "Buyer messaged";
  if (!a) return "Needs assessment";
  if (a.revision !== revision) return "Review changed";
  return { prepare_response: "Prepare response", review_remedy: "Review remedy", need_more_information: "Need more information" }[
    a.output.recommendation
  ];
}

app.get("/api/scenario", (_req, res) => {
  res.json({ merchant: merchant(), cases: allCases().map(queueRow), live: { configured: paypalConfigured(), sync: liveSyncState() } });
});

// Re-read every dispute in the merchant's PayPal sandbox account.
app.post("/api/live/sync", async (_req, res) => {
  if (!paypalConfigured()) return res.status(503).json({ error: "PayPal isn't configured on this deployment." });
  await syncLive();
  res.json(liveSyncState());
});

// Seller-entered shipment details for a live case (PayPal doesn't know the seller's tracking for a plain payment).
app.post("/api/cases/:id/shipment", (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c || c.source !== "paypal") return res.status(404).json({ error: "Shipment details can be added to live PayPal cases only." });
  const { carrier, trackingNumber, shippedOn, carrierStatus } = req.body ?? {};
  const CARRIERS = ["USPS", "UPS", "FEDEX", "DHL", "OTHER"];
  if (!CARRIERS.includes(carrier)) return res.status(400).json({ error: `Carrier must be one of ${CARRIERS.join(", ")}.` });
  if (!/^[A-Za-z0-9]{8,40}$/.test(String(trackingNumber ?? ""))) return res.status(400).json({ error: "Tracking number should be 8 to 40 letters and digits." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shippedOn ?? ""))) return res.status(400).json({ error: "Shipped date should look like 2026-10-20." });
  addShipment(c.caseId, { carrier, trackingNumber: String(trackingNumber).toUpperCase(), shippedOn, carrierStatus: carrierStatus ? String(carrierStatus).slice(0, 300) : undefined });
  res.json({ ok: true });
});

app.get("/api/cases/:id", (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const { pendingSources, ...rest } = c;
  // live is internal sync metadata; the client gets the parts it needs below.
  const { live: liveMeta, ...shown } = rest as typeof rest & { live?: unknown };
  const assessment = latestAssessment(c.caseId);
  const proposal = buildProposal(c, assessment);
  res.json({
    ...shown,
    allowedActions: c.source === "paypal" ? c.live.allowed : null,
    sellerProtection: c.source === "paypal" ? c.live.sellerProtection : null,
    providerStatus: providerStatus(c),
    revision: caseRevision(c),
    hasPendingRecords: pendingSources.length > 0,
    assessment: assessment ?? null,
    proposal,
    approval: approvalState(c.caseId, proposal),
    attempts: attemptsFor(c.caseId),
    linkedDispute: linkedDispute(c.caseId),
    paypal: linkedDispute(c.caseId) ? { canRefresh: paypalConfigured(), last: paypalObservation(c.caseId) } : null,
  });
});

// Re-read the linked sandbox dispute so the case shows what PayPal says now.
app.post("/api/cases/:id/refresh", async (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const disputeId = linkedDispute(c.caseId);
  if (!disputeId) return res.status(409).json({ error: "This case isn't linked to a PayPal dispute." });
  if (!paypalConfigured()) return res.status(503).json({ error: "PayPal isn't configured on this deployment." });
  try {
    const d = c.source === "paypal" ? (await refreshLive(c.caseId))!.live : await getDispute(disputeId);
    const seen = { status: d.status, observedAt: new Date().toISOString() };
    observed.set(c.caseId, seen);
    res.json(seen);
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/approve", (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const proposal = buildProposal(c, latestAssessment(c.caseId));
  if (isBlocker(proposal)) return res.status(409).json({ error: proposal.reason });
  try {
    res.json(approve(c.caseId, proposal, String(req.body?.digest ?? "")));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/submit", async (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  try {
    res.json(await submit(c.caseId, buildProposal(c, latestAssessment(c.caseId)), String(req.body?.digest ?? "")));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/assess", assessLimit, async (req, res) => {
  const c = findAny(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  try {
    res.json(await assess(c));
  } catch (err) {
    if (err instanceof NoSavedResult) return res.status(503).json({ error: err.message });
    sendError(res, err);
  }
});

// --- Autopilot -------------------------------------------------------------------------

app.get("/api/autopilot", (_req, res) => res.json({ rules: getRules(), lastRun: getLastRun(), liveWrites: env.allowSandboxWrites }));

app.put("/api/autopilot/rules", (req, res) => res.json(setRules(req.body)));

// One request can assess every open case, so it counts against the assessment limit.
app.post("/api/autopilot/:mode", assessLimit, async (req, res) => {
  const mode = String(req.params.mode);
  if (mode !== "preview" && mode !== "run") return res.status(404).json({ error: "Use preview or run." });
  try {
    res.json(await runAutopilot(mode === "preview"));
  } catch (err) {
    sendError(res, err);
  }
});

// Every PayPal action taken or simulated, newest first, for the activity log.
app.get("/api/activity", (_req, res) => {
  res.json(
    allAttempts()
      .slice()
      .reverse()
      .map((a) => ({
        id: a.id,
        at: a.startedAt,
        caseId: a.caseId,
        action: { evidence: "Submit evidence", message: "Message buyer", refund: "Refund", offer: "Refund offer" }[a.kind ?? "evidence"],
        by: a.by === "autopilot" ? "Autopilot" : "You",
        rule: a.rule ?? "",
        result: { submitting: "Sending", evidence_accepted: "Accepted by PayPal", done: "Done in PayPal", simulated: "Simulated", rejected: "Not sent", needs_reconciliation: "Unknown, check PayPal" }[a.state],
        amount: Number(a.amount?.value ?? 0),
        mode: a.target.mode === "sandbox" ? "PayPal sandbox" : "Simulated",
        detail: a.error ?? a.summary ?? "",
        // Pre-computed numbers so dashboard tiles can sum them without per-widget filters.
        autopilotActions: a.by === "autopilot" && a.state !== "rejected" ? 1 : 0,
        autopilotRefunded: a.by === "autopilot" && a.kind === "refund" && a.state !== "rejected" ? Number(a.amount?.value ?? 0) : 0,
      })),
  );
});

// Scenario only: simulate a newly synced record arriving for a case.
app.post("/api/cases/:id/advance", (req, res) => {
  const added = advanceCase(String(req.params.id));
  if (!added) return res.status(409).json({ error: "No pending records for this case" });
  res.json({ added });
});

app.post("/api/scenario/reset", (_req, res) => {
  resetScenario();
  clearAssessments();
  resetSimulatedAttempts();
  observed.clear();
  res.json({ ok: true });
});

// Read-only view of the real sandbox merchant's disputes.
app.get("/api/sandbox/disputes", async (_req, res) => {
  if (!paypalConfigured()) return res.json({ configured: false, items: [] });
  try {
    res.json({ configured: true, items: await listDisputes() });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/sandbox/disputes/:id", async (req, res) => {
  try {
    res.json(await getDispute(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// AG Studio's AI assistant (Responses API) -> Astropods AI Gateway. The browser never sees the key, and
// only models on this list can be used.
const AI_MODELS = (process.env.STUDIO_AI_MODELS || "claude-opus-5-5").split(",").map((m) => m.trim());

app.get("/api/ai/models", (_req, res) => {
  if (env.aiMode !== "live" || !env.gatewayKey) return res.status(503).json({ error: "Live AI is off on this deployment" });
  res.json({ models: AI_MODELS });
});

app.get("/api/config", (_req, res) => {
  res.json({ aiMode: env.aiMode, sandboxWrites: env.allowSandboxWrites, paypalConfigured: paypalConfigured() });
});

app.post("/api/ai/responses", aiLimit, async (req, res) => {
  if (env.aiMode !== "live" || !env.gatewayUrl || !env.gatewayKey) return res.status(503).json({ error: "Live AI is off on this deployment" });
  const model = AI_MODELS.includes(req.body?.model) ? req.body.model : AI_MODELS[0];
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const upstream = await fetch(`${env.gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, model }),
      signal: abort.signal,
    });
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return;
    if (!res.headersSent) return sendError(res, err);
    res.end();
  }
});

function sendError(res: Response, err: unknown) {
  if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
  if (err instanceof PayPalError) {
    return res.status(502).json({ error: err.message, paypalStatus: err.status, debugId: err.debugId });
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

if (env.production && existsSync("dist")) {
  app.use(express.static("dist"));
  app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: "dist" }));
}

app.listen(env.port, () => {
  console.log(`Dispute Copilot API on http://localhost:${env.port}`);
  syncLive().then(() => {
    const s = liveSyncState();
    if (s) console.log(s.error ? `PayPal sync failed: ${s.error}` : "PayPal sandbox disputes synced");
  });
});
