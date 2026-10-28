import { assessCase, type AssessmentResult } from "./assess.ts";
import type { AnyCase } from "./cases.ts";
import { env } from "./env.ts";
import { findSaved } from "./saved.ts";
import { caseRevision } from "./scenario.ts";

// Latest assessment per case, shared by the routes and the autopilot. An assessment is stale once the
// case revision moves past it.

const assessments = new Map<string, AssessmentResult>();

export const latestAssessment = (caseId: string) => assessments.get(caseId);

export function currentAssessment(c: AnyCase): AssessmentResult | undefined {
  const a = assessments.get(c.caseId);
  return a && a.revision === caseRevision(c) ? a : undefined;
}

export class NoSavedResult extends Error {}

/** Assesses with the live model, or serves the saved result for this exact case state in saved mode. */
export async function assess(c: AnyCase): Promise<AssessmentResult> {
  if (env.aiMode === "saved") {
    const saved = findSaved(c.caseId, caseRevision(c));
    if (!saved) throw new NoSavedResult("This demo has no saved AI result for this exact case state. Run it locally with live AI to assess it.");
    assessments.set(c.caseId, saved);
    return saved;
  }
  const result = await assessCase(c);
  assessments.set(c.caseId, result);
  return result;
}

export const clearAssessments = () => assessments.clear();
