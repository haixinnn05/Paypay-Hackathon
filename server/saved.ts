import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AssessmentResult } from "./assess.ts";

// Assessments generated once with the live model and saved, keyed by the exact case revision they
// were made for. The hosted demo serves these when it has no AI Gateway key; a saved result is only
// ever shown for the identical case state it was generated from.

const FILE = new URL("../fixtures/saved-assessments.json", import.meta.url);

export type SavedAssessment = AssessmentResult & { savedAt: string };

let saved: Record<string, SavedAssessment> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};

const key = (caseId: string, revision: string) => `${caseId}@${revision}`;

export function findSaved(caseId: string, revision: string): SavedAssessment | null {
  return saved[key(caseId, revision)] ?? null;
}

export function writeSaved(results: AssessmentResult[]) {
  const savedAt = new Date().toISOString();
  saved = Object.fromEntries(results.map((r) => [key(r.caseId, r.revision), { ...r, savedAt }]));
  writeFileSync(FILE, JSON.stringify(saved, null, 2) + "\n");
}
