export interface QueueRow {
  caseId: string;
  orderRef: string;
  buyer: string;
  amount: number;
  currency: string;
  providerStatus: string;
  sellerResponseDue: string;
  sourceCount: number;
  recommendation: string | null;
  assessmentState: "needs_assessment" | "current" | "review_changed";
  nextStep: string;
  needsAction: number;
  answered: number;
  dueThisWeek: number;
  approvalState: "none" | "approved" | "expired" | "review_changed";
  lastAttempt: string | null;
  linkedDispute: string | null;
  revision: string;
}

export interface Source {
  id: string;
  type: string;
  recordedAt: string;
  content: string;
}

export interface Assessment {
  caseId: string;
  revision: string;
  model: string;
  createdAt: string;
  output: {
    recommendation: "prepare_response" | "review_remedy" | "need_more_information";
    summary: string;
    findings: { kind: "supported" | "conflict" | "missing" | "unverified"; statement: string; sourceIds: string[] }[];
    draftResponse: { sentence: string; sourceIds: string[] }[];
    questionsForMerchant: string[];
  };
  validation: { unknownSourceIds: string[]; uncitedDraftSentences: number };
  assessedSourceIds: string[];
  /** Set when this is a pre-generated result served without live AI. */
  savedAt?: string;
}

export interface Proposal {
  caseId: string;
  revision: string;
  target: { mode: "sandbox"; disputeId: string } | { mode: "simulated"; reason: string };
  action: "PROVIDE_EVIDENCE";
  evidence: { carrier: string; trackingNumber: string; notes: string };
  digest: string;
}

export interface Attempt {
  id: string;
  digest: string;
  target: Proposal["target"];
  state: "submitting" | "evidence_accepted" | "simulated" | "rejected" | "needs_reconciliation";
  startedAt: string;
  error?: string;
  debugId?: string | null;
  readBack?: { status: string; evidenceCount: number; observedAt: string } | { error: string };
}

export interface CaseDetail {
  caseId: string;
  reason: string;
  providerStatus: string;
  amount: { value: string; currency: string };
  sellerResponseDue: string;
  orderRef: string;
  buyerMasked: string;
  buyerClaim: string;
  sources: Source[];
  revision: string;
  hasPendingRecords: boolean;
  assessment: Assessment | null;
  proposal: Proposal | { reason: string };
  approval: { state: "none" | "approved" | "expired" | "review_changed"; approvedDigest?: string; expiresAt?: string };
  attempts: Attempt[];
  linkedDispute: string | null;
  /** Present for cases linked to a real sandbox dispute. */
  paypal: { canRefresh: boolean; last: { status: string; observedAt: string } | null } | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.debugId ? `${body.error} (PayPal debug ID ${body.debugId})` : body.error);
  return body as T;
}

const post = (path: string, body: unknown) =>
  call<unknown>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  scenario: () => call<{ merchant: { name: string; note: string }; cases: QueueRow[] }>("/api/scenario"),
  caseDetail: (id: string) => call<CaseDetail>(`/api/cases/${id}`),
  assess: (id: string) => call<Assessment>(`/api/cases/${id}/assess`, { method: "POST" }),
  advance: (id: string) => call<{ added: Source }>(`/api/cases/${id}/advance`, { method: "POST" }),
  approve: (id: string, digest: string) => post(`/api/cases/${id}/approve`, { digest }),
  submit: (id: string, digest: string) => post(`/api/cases/${id}/submit`, { digest }),
  refreshPaypal: (id: string) => post(`/api/cases/${id}/refresh`, {}),
  reset: () => call<{ ok: true }>("/api/scenario/reset", { method: "POST" }),
};
