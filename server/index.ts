import express, { type Response } from "express";
import { existsSync } from "node:fs";
import { env, paypalConfigured } from "./env.ts";
import { ActionError, approvalState, approve, attemptsFor, buildProposal, isBlocker, linkedDispute, resetSimulatedAttempts, submit } from "./actions.ts";
import { assessCase, type AssessmentResult } from "./assess.ts";
import { rateLimit } from "./limit.ts";
import { getDispute, listDisputes, PayPalError } from "./paypal.ts";
import { findSaved } from "./saved.ts";
import { advanceCase, caseRevision, cases, findCase, merchant, resetScenario } from "./scenario.ts";

const app = express();
app.set("trust proxy", 1); // Render and similar hosts sit behind one proxy; needed for per-visitor limits.
app.use(express.json({ limit: "2mb" }));

const assessLimit = rateLimit("assessment", Number(process.env.ASSESS_LIMIT ?? 15), Number(process.env.ASSESS_DAILY_LIMIT ?? 200));
// One assistant question makes several model calls, so this limit is per model call.
const aiLimit = rateLimit("assistant", Number(process.env.AI_LIMIT ?? 80), Number(process.env.AI_DAILY_LIMIT ?? 600));

// Latest assessment per case. An assessment is stale once the case revision moves past it.
const assessments = new Map<string, AssessmentResult>();

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
function providerStatus(c: ReturnType<typeof cases>[number]): string {
  return paypalObservation(c.caseId)?.status ?? c.providerStatus;
}

function queueRow(c: ReturnType<typeof cases>[number]) {
  const a = assessments.get(c.caseId);
  const revision = caseRevision(c);
  const lastAttempt = attemptsFor(c.caseId).at(-1)?.state ?? null;
  const step = nextStep(a, revision, lastAttempt);
  const daysLeft = (new Date(c.sellerResponseDue).getTime() - Date.now()) / 86_400_000;
  return {
    nextStep: step,
    needsAction: step === "Evidence submitted" ? 0 : 1,
    answered: step === "Evidence submitted" ? 1 : 0,
    dueThisWeek: step !== "Evidence submitted" && daysLeft <= 7 ? 1 : 0,
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
    lastAttempt,
    linkedDispute: linkedDispute(c.caseId),
    revision,
  };
}

/** One plain-language label per case, used to group the queue and the dashboard charts. */
function nextStep(a: AssessmentResult | undefined, revision: string, lastAttempt: string | null): string {
  if (lastAttempt === "needs_reconciliation") return "Reconcile in PayPal";
  if (lastAttempt === "evidence_accepted" || lastAttempt === "simulated") return "Evidence submitted";
  if (!a) return "Needs assessment";
  if (a.revision !== revision) return "Review changed";
  return { prepare_response: "Prepare response", review_remedy: "Review remedy", need_more_information: "Need more information" }[
    a.output.recommendation
  ];
}

app.get("/api/scenario", (_req, res) => {
  res.json({ merchant: merchant(), cases: cases().map(queueRow) });
});

app.get("/api/cases/:id", (req, res) => {
  const c = findCase(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const { pendingSources, ...rest } = c;
  const assessment = assessments.get(c.caseId);
  const proposal = buildProposal(c, assessment);
  res.json({
    ...rest,
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
  const c = findCase(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const disputeId = linkedDispute(c.caseId);
  if (!disputeId) return res.status(409).json({ error: "This case isn't linked to a PayPal dispute." });
  if (!paypalConfigured()) return res.status(503).json({ error: "PayPal isn't configured on this deployment." });
  try {
    const d = await getDispute(disputeId);
    const seen = { status: d.status, observedAt: new Date().toISOString() };
    observed.set(c.caseId, seen);
    res.json(seen);
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/approve", (req, res) => {
  const c = findCase(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown case" });
  const proposal = buildProposal(c, assessments.get(c.caseId));
  if (isBlocker(proposal)) return res.status(409).json({ error: proposal.reason });
  try {
    res.json(approve(c.caseId, proposal, String(req.body?.digest ?? "")));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/submit", async (req, res) => {
  const c = findCase(req.params.id);
  if (!c) return res.status(404).json({ error: "Unknown case" });
  try {
    res.json(await submit(c.caseId, buildProposal(c, assessments.get(c.caseId)), String(req.body?.digest ?? "")));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/cases/:id/assess", assessLimit, async (req, res) => {
  const c = findCase(String(req.params.id));
  if (!c) return res.status(404).json({ error: "Unknown case" });
  if (env.aiMode === "saved") {
    const saved = findSaved(c.caseId, caseRevision(c));
    if (!saved) return res.status(503).json({ error: "This demo has no saved AI result for this exact case state. Run it locally with live AI to assess it." });
    assessments.set(c.caseId, saved);
    return res.json(saved);
  }
  try {
    const result = await assessCase(c);
    assessments.set(c.caseId, result);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Scenario only: simulate a newly synced record arriving for a case.
app.post("/api/cases/:id/advance", (req, res) => {
  const added = advanceCase(req.params.id);
  if (!added) return res.status(409).json({ error: "No pending records for this case" });
  res.json({ added });
});

app.post("/api/scenario/reset", (_req, res) => {
  resetScenario();
  assessments.clear();
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

app.listen(env.port, () => console.log(`Dispute Copilot API on http://localhost:${env.port}`));
