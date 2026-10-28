// Generates the saved AI results the hosted demo serves when it has no AI Gateway key.
// Assesses every scenario case in every state the demo can reach (each pending record added in turn)
// with the live model, then writes fixtures/saved-assessments.json. Needs a gateway key in .env.
// Usage: npm run save-assessments
import { assessCase, type AssessmentResult } from "../server/assess.ts";
import { env } from "../server/env.ts";
import { writeSaved } from "../server/saved.ts";
import { advanceCase, cases, findCase, resetScenario } from "../server/scenario.ts";

if (!env.gatewayKey) {
  console.error("Set ASTRO_GATEWAY_URL and ASTRO_GATEWAY_API_KEY (npm run gateway-key) first.");
  process.exit(1);
}

resetScenario();
const results: AssessmentResult[] = [];

for (const { caseId } of cases()) {
  for (;;) {
    const c = findCase(caseId)!;
    process.stdout.write(`${caseId} (${c.sources.length} records) ... `);
    const result = await assessCase(c);
    console.log(result.output.recommendation);
    results.push(result);
    if (!advanceCase(caseId)) break;
  }
}

writeSaved(results);
resetScenario();
console.log(`Saved ${results.length} assessments to fixtures/saved-assessments.json`);
