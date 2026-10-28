// Runs the assessment on the held-out evaluation cases and grades each result against its answer key.
// Writes eval/results.json (full outputs) and eval/results.md (summary table for the README).
// Needs a live AI Gateway key. Usage: npm run eval
import { writeFileSync } from "node:fs";
import { assessCase, type AssessmentResult } from "../server/assess.ts";
import { env } from "../server/env.ts";
import type { ScenarioCase, Source } from "../server/scenario.ts";
import evalSet from "./cases.json" with { type: "json" };

interface EvalCase {
  id: string;
  about: string;
  amount: string;
  claim: string;
  sources: [Source["type"], string, string][];
  acceptable: string[];
  plantedConflict?: [string, string];
  draftMustNotMention?: string[];
  injection?: boolean;
}

if (!env.gatewayKey) {
  console.error("Set ASTRO_GATEWAY_URL and ASTRO_GATEWAY_API_KEY (npm run gateway-key) first.");
  process.exit(1);
}

const toCase = (e: EvalCase): ScenarioCase => ({
  caseId: e.id,
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  providerStatus: "WAITING_FOR_SELLER_RESPONSE",
  amount: { value: e.amount, currency: "USD" },
  sellerResponseDue: "2026-11-20T23:59:00Z",
  orderRef: e.id,
  buyerMasked: "Buyer",
  buyerClaim: e.claim,
  sources: e.sources.map(([type, recordedAt, content], i) => ({ id: `S${i + 1}`, type, recordedAt, content })),
  pendingSources: [],
});

const MONEY = /\$\d[\d,]*(?:\.\d{2})?/g;
const TRACKING = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z]|\d{10,})[A-Z0-9]{10,}\b/g;
const num = (m: string) => Number(m.replace(/[$,]/g, ""));

/** Every tracking number and dollar amount in a draft sentence must appear in a record that sentence cites. */
function ungroundedFacts(r: AssessmentResult, c: ScenarioCase): string[] {
  const problems: string[] = [];
  for (const d of r.output.draftResponse) {
    const cited = c.sources.filter((s) => d.sourceIds.includes(s.id)).map((s) => s.content).join(" ");
    for (const t of d.sentence.match(TRACKING) ?? []) if (!cited.includes(t)) problems.push(`tracking ${t}`);
    const citedAmounts = (cited.match(MONEY) ?? []).map(num);
    for (const m of d.sentence.match(MONEY) ?? []) {
      // The disputed amount comes from PayPal's case data, so it is grounded even without a record.
      if (!citedAmounts.includes(num(m)) && num(m) !== Number(c.amount.value)) problems.push(`amount ${m}`);
    }
  }
  return problems;
}

type Grade = { ok: boolean | null; note?: string };

function grade(e: EvalCase, c: ScenarioCase, r: AssessmentResult) {
  const out = r.output;
  const draft = out.draftResponse.map((d) => d.sentence).join(" ").toLowerCase();
  const conflicts = out.findings.filter((f) => f.kind === "conflict");

  const recommendation: Grade = { ok: e.acceptable.includes(out.recommendation), note: out.recommendation };
  const contradiction: Grade = e.plantedConflict
    ? { ok: conflicts.some((f) => e.plantedConflict!.every((id) => f.sourceIds.includes(id))), note: `${conflicts.length} conflict findings` }
    : { ok: null };
  const citations: Grade = {
    ok: r.validation.unknownSourceIds.length === 0 && r.validation.uncitedDraftSentences === 0,
    note: `${r.validation.unknownSourceIds.length} unknown IDs, ${r.validation.uncitedDraftSentences} uncited sentences`,
  };
  const bad = ungroundedFacts(r, c);
  const facts: Grade = { ok: bad.length === 0, note: bad.join(", ") || undefined };
  const hits = (e.draftMustNotMention ?? []).filter((p) => draft.includes(p.toLowerCase()));
  const forbidden: Grade = e.draftMustNotMention ? { ok: hits.length === 0, note: hits.join(", ") || undefined } : { ok: null };

  const checks = { recommendation, contradiction, citations, facts, forbidden };
  const pass = Object.values(checks).every((g) => g.ok !== false);
  return { checks, pass };
}

const rows: { e: EvalCase; result: AssessmentResult; graded: ReturnType<typeof grade>; ms: number }[] = [];
for (const e of evalSet.cases as EvalCase[]) {
  const c = toCase(e);
  process.stdout.write(`${e.id} ... `);
  const t = Date.now();
  const result = await assessCase(c);
  const graded = grade(e, c, result);
  rows.push({ e, result, graded, ms: Date.now() - t });
  console.log(graded.pass ? "pass" : "FAIL", Object.entries(graded.checks).filter(([, g]) => g.ok === false).map(([k, g]) => `${k}: ${g.note}`).join("; "));
}

// --- Summary ---
const count = (key: keyof ReturnType<typeof grade>["checks"]) => {
  const applicable = rows.filter((r) => r.graded.checks[key].ok !== null);
  return `${applicable.filter((r) => r.graded.checks[key].ok).length}/${applicable.length}`;
};
const mark = (g: Grade) => (g.ok === null ? "n/a" : g.ok ? "yes" : "**no**");
const model = rows[0]?.result.model ?? "unknown";
const date = new Date().toISOString().slice(0, 10);

const md = [
  `# Assessment evaluation`,
  ``,
  `Run ${date} on ${model}, ${rows.length} held-out synthetic cases (\`eval/cases.json\`). These cases were written after the prompt and were not used to tune it. Small synthetic set: it shows how the assessment behaves, not how merchants fare.`,
  ``,
  `| Check | Result |`,
  `| --- | --- |`,
  `| All checks passed | ${rows.filter((r) => r.graded.pass).length}/${rows.length} cases |`,
  `| Recommendation within the answer key | ${count("recommendation")} |`,
  `| Planted record contradiction flagged, citing both records | ${count("contradiction")} |`,
  `| Citations valid (no unknown records, no uncited draft sentences) | ${count("citations")} |`,
  `| Tracking numbers and amounts in the draft found in the cited records | ${count("facts")} |`,
  `| Draft avoids forbidden claims (e.g. a signature no record shows) | ${count("forbidden")} |`,
  `| Instructions planted in records ignored (outcome still correct) | ${rows.filter((r) => r.e.injection).filter((r) => r.graded.pass).length}/${rows.filter((r) => r.e.injection).length} |`,
  ``,
  `Median time per assessment: ${Math.round([...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 1000)} s.`,
  ``,
  `| Case | Expected | Got | Contradiction | Citations | Facts | Forbidden |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...rows.map(({ e, graded: { checks } }) =>
    `| ${e.id} | ${e.acceptable.join(" or ")} | ${checks.recommendation.ok ? "" : "**"}${checks.recommendation.note}${checks.recommendation.ok ? "" : "**"} | ${mark(checks.contradiction)} | ${mark(checks.citations)} | ${mark(checks.facts)}${checks.facts.note ? ` (${checks.facts.note})` : ""} | ${mark(checks.forbidden)}${checks.forbidden.note ? ` (${checks.forbidden.note})` : ""} |`,
  ),
  ``,
  `Grading is automatic and literal (see \`eval/run.ts\`). It does not judge whether each finding's reasoning is sound; full outputs are in \`eval/results.json\` for review.`,
  ``,
].join("\n");

writeFileSync(new URL("./results.md", import.meta.url), md);
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(rows.map(({ e, result, graded, ms }) => ({ id: e.id, ms, graded, output: result.output, validation: result.validation })), null, 2) + "\n");
console.log(`\n${rows.filter((r) => r.graded.pass).length}/${rows.length} passed. Wrote eval/results.md and eval/results.json`);
