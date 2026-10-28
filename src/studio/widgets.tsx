import { useEffect, useRef, type ComponentType } from "react";
import type { AgDefaultRegistry, AgDefaultWidgetDefinition, AgWidgetApi, AgWidgetData, AgWidgetDataFormat, AgWidgetParams, AgWidgetsConfig } from "ag-studio";
import { createWidgets, type AgWidgetDefinition } from "ag-studio-react";
import {
  ArrowClockwise,
  ArrowUUpLeft,
  ChatText,
  CheckCircle,
  CircleNotch,
  Clock,
  Info,
  LockSimple,
  MapPin,
  Package,
  PaperPlaneTilt,
  Plus,
  Question,
  SealCheck,
  Truck,
  Warning,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { Assessment, Attempt, CaseDetail, QueueRow, Source } from "../api.ts";
import { store, useStore } from "../store.ts";

// Custom Studio widgets. They hold no data mappings: each reads the shared store (also passed to
// Studio as `context`), so selecting a case in the queue drives the other two.

type DisputeWidgetType = "case-queue" | "evidence-inspector" | "action-review";
type DisputeWidgetState<T extends DisputeWidgetType> = AgWidgetData<Record<string, never>, AgWidgetDataFormat<unknown>> & { type: T };
type DisputeWidgetDefinition<T extends DisputeWidgetType> = AgWidgetDefinition<T, DisputeWidgetState<T>>;
type Params<T extends DisputeWidgetType> = AgWidgetParams<DisputeWidgetState<T>>;
type Finding = Assessment["output"]["findings"][number];

export interface DisputeRegistry extends Omit<AgDefaultRegistry, "widgets"> {
  widgets: readonly (
    | DisputeWidgetDefinition<"case-queue">
    | DisputeWidgetDefinition<"evidence-inspector">
    | DisputeWidgetDefinition<"action-review">
    | AgDefaultWidgetDefinition
  )[];
}

/** Custom widgets render their own content, so tell Studio to drop its loading overlay. */
function useDisplayed(params: { widgetApi: AgWidgetApi }) {
  useEffect(() => params.widgetApi.setDisplayState("displayed"), [params.widgetApi]);
}

const money = (value: number | string, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function dueLabel(iso: string) {
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (d < 0) return { text: `${-d} days overdue`, urgent: true };
  if (d === 0) return { text: "Due today", urgent: true };
  if (d === 1) return { text: "Due tomorrow", urgent: true };
  return { text: `${d} days left`, urgent: d <= 3 };
}

const STEP_TONE: Record<string, string> = {
  "Prepare response": "accent",
  "Evidence submitted": "good",
  "Review remedy": "warn",
  "Need more information": "warn",
  "Review changed": "alert",
  "Reconcile in PayPal": "alert",
  "Needs assessment": "neutral",
};

// --- Case queue -----------------------------------------------------------------------

function CaseQueue(params: Params<"case-queue">) {
  useDisplayed(params);
  const rows = useStore((s) => s.rows);
  const selectedId = useStore((s) => s.selectedId);

  if (rows.length === 0) return <div className="dc-widget dc-empty">No open disputes.</div>;

  const sorted = [...rows].sort((a, b) => a.sellerResponseDue.localeCompare(b.sellerResponseDue));
  const groups = (
    [
      ["Due this week", sorted.filter((r) => r.dueThisWeek)],
      ["Later", sorted.filter((r) => r.needsAction && !r.dueThisWeek)],
      ["Answered", sorted.filter((r) => !r.needsAction)],
    ] as const
  ).filter(([, items]) => items.length > 0);

  const open = rows.filter((r) => r.needsAction).length;
  return (
    <div className="dc-widget queue">
      <div className="dc-rail-head">
        <h3>Cases</h3>
        <span className="dc-small dc-muted">{open} open</span>
      </div>
      {groups.map(([label, items], i) => (
        <section key={label} className="dc-queue-group">
          <div className="dc-section-label" style={i === 0 ? { marginTop: 4 } : undefined}>
            {label}
          </div>
          <ul className="dc-queue">
            {items.map((r) => (
              <QueueItem key={r.caseId} row={r} selected={r.caseId === selectedId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function QueueItem({ row, selected }: { row: QueueRow; selected: boolean }) {
  const due = dueLabel(row.sellerResponseDue);
  return (
    <li>
      <button className={`dc-queue-item ${selected ? "selected" : ""}`} onClick={() => store.select(row.caseId)} aria-pressed={selected}>
        <span className="dc-row">
          <strong>{row.buyer}</strong>
          <span className="amount">{money(row.amount, row.currency)}</span>
        </span>
        <span className="dc-row dc-small dc-muted">
          <span className="mono">{row.caseId}</span>
          {row.needsAction ? (
            <span className={`dc-inline dc-due ${due.urgent ? "urgent" : ""}`}>
              <Clock size={13} />
              {due.text}
            </span>
          ) : null}
        </span>
        <span className="dc-row">
          <span className={`dc-chip ${STEP_TONE[row.nextStep] ?? "neutral"}`}>{row.nextStep}</span>
          {row.linkedDispute && (
            <span className="dc-small dc-muted" title={`Linked to PayPal sandbox dispute ${row.linkedDispute}`}>
              PayPal sandbox
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

// --- Evidence inspector -----------------------------------------------------------------

const RECOMMENDATION = {
  prepare_response: { label: "Records support a response", tone: "good" },
  review_remedy: { label: "Consider a refund instead", tone: "warn" },
  need_more_information: { label: "More information needed", tone: "warn" },
} as const;

const FINDING: Record<Finding["kind"], { icon: Icon; label: string }> = {
  conflict: { icon: XCircle, label: "Records disagree" },
  missing: { icon: Question, label: "Missing" },
  unverified: { icon: Warning, label: "Not independently confirmed" },
  supported: { icon: CheckCircle, label: "Supported" },
};

const SOURCE: Record<string, { icon: Icon; label: string }> = {
  order: { icon: Package, label: "Order" },
  shipment: { icon: Truck, label: "Shipment" },
  carrier_event: { icon: MapPin, label: "Carrier update" },
  message: { icon: ChatText, label: "Message" },
  refund: { icon: ArrowUUpLeft, label: "Refund" },
};

function EvidenceInspector(params: Params<"evidence-inspector">) {
  useDisplayed(params);
  const detail = useStore((s) => s.detail);
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.error);
  const focused = useStore((s) => s.focusedSource);

  if (!detail) return <div className="dc-widget dc-empty">Choose a case from the queue.</div>;

  const a = detail.assessment;
  const stale = Boolean(a && a.revision !== detail.revision);
  const newIds = new Set(a ? detail.sources.filter((s) => !a.assessedSourceIds?.includes(s.id)).map((s) => s.id) : []);
  const byKind = (kind: Finding["kind"]) => (a?.output.findings ?? []).filter((f) => f.kind === kind);
  const supported = byKind("supported");
  const due = dueLabel(detail.sellerResponseDue);

  return (
    <div className="dc-widget reading">
      <header className="dc-case-head">
        <div>
          <h3 className="dc-title">
            {detail.buyerMasked}, order {detail.orderRef}
          </h3>
          <span className={`dc-inline dc-small ${due.urgent ? "dc-due urgent" : "dc-muted"}`}>
            <Clock size={13} />
            Respond by {shortDate(detail.sellerResponseDue)} ({due.text.toLowerCase()})
          </span>
        </div>
        <span className="amount">{money(detail.amount.value, detail.amount.currency)}</span>
      </header>

      <blockquote className="dc-claim">
        <span className="dc-small dc-muted">The buyer says</span>
        <p>{detail.buyerClaim}</p>
      </blockquote>

      <div className="dc-actions">
        <button className={!a || stale ? "primary" : "ghost"} disabled={busy} onClick={store.assess}>
          {busy && <CircleNotch size={15} className="dc-spin" />}
          {busy ? "Reading records" : a ? "Reassess" : "Assess this case"}
        </button>
        {detail.hasPendingRecords && (
          <button className="ghost" disabled={busy} onClick={store.advance} title="Scenario only: adds the next synthetic record for this case">
            <Plus size={15} />
            Add next record (demo)
          </button>
        )}
      </div>
      {error && <p className="dc-error">{error}</p>}

      {busy && !a && <AssessmentSkeleton count={detail.sources.length} />}

      {a && (
        <section className={`dc-appear ${stale ? "dc-stale" : ""}`}>
          {stale && (
            <div className="dc-note alert">
              <Warning size={16} weight="fill" />
              <span>
                {newIds.size === 1 ? "A record arrived after this assessment. " : newIds.size > 1 ? `${newIds.size} records arrived after this assessment. ` : "This case changed after the assessment. "}
                Reassess before you act on it.
              </span>
            </div>
          )}
          <div className="dc-verdict">
            <span className="dc-inline">
              <span className={`dc-chip ${RECOMMENDATION[a.output.recommendation].tone}`}>{RECOMMENDATION[a.output.recommendation].label}</span>
              {a.savedAt && (
                <span className="dc-small dc-muted" title="This demo serves AI results generated in advance for this exact case state.">
                  Saved AI result from {new Date(a.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              )}
            </span>
            <p>{a.output.summary}</p>
          </div>

          {(["conflict", "missing", "unverified"] as const).map((kind) =>
            byKind(kind).length > 0 ? (
              <div key={kind}>
                <div className="dc-section-label">
                  {FINDING[kind].label} ({byKind(kind).length})
                </div>
                <FindingList kind={kind} items={byKind(kind)} focused={focused} />
              </div>
            ) : null,
          )}
          {supported.length > 0 && (
            <details className="dc-supported">
              <summary>
                {supported.length} supported {supported.length === 1 ? "fact" : "facts"}
              </summary>
              <FindingList kind="supported" items={supported} focused={focused} />
            </details>
          )}

          {a.output.questionsForMerchant.length > 0 && (
            <>
              <div className="dc-section-label">Check before you respond</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {a.output.questionsForMerchant.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="dc-section-label">Records, oldest first</div>
      <ol className="dc-timeline">
        {[...detail.sources]
          .sort((x, y) => x.recordedAt.localeCompare(y.recordedAt))
          .map((s) => (
            <TimelineEvent key={s.id} source={s} focused={focused === s.id} isNew={newIds.has(s.id)} />
          ))}
      </ol>
      <p className="dc-small dc-muted">All records in this scenario are synthetic.</p>
    </div>
  );
}

function AssessmentSkeleton({ count }: { count: number }) {
  return (
    <div aria-live="polite">
      <p className="dc-small dc-muted">
        Reading {count} {count === 1 ? "record" : "records"} and checking them against the buyer's claim.
      </p>
      <div className="dc-skeleton">
        <span style={{ width: "40%" }} />
        <span style={{ width: "92%" }} />
        <span style={{ width: "78%" }} />
        <span style={{ width: "85%" }} />
      </div>
    </div>
  );
}

function FindingList({ kind, items, focused }: { kind: Finding["kind"]; items: Finding[]; focused: string | null }) {
  const IconFor = FINDING[kind].icon;
  return (
    <ul className="dc-findings">
      {items.map((f, i) => (
        <li key={i} className={kind}>
          <IconFor size={16} weight={kind === "conflict" ? "fill" : "regular"} />
          <span>
            {f.statement}
            <Cites ids={f.sourceIds} focused={focused} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function TimelineEvent({ source, focused, isNew }: { source: Source; focused: boolean; isNew: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);
  const kind = SOURCE[source.type] ?? { icon: Info, label: source.type };
  return (
    <li ref={ref} className={`dc-event ${focused ? "focused" : ""} ${isNew ? "new dc-appear" : ""}`} onClick={() => store.focusSource(focused ? null : source.id)}>
      <span className="dc-event-icon">
        <kind.icon size={14} />
      </span>
      <div className="dc-event-body">
        <div className="dc-row dc-small">
          <span className="dc-inline">
            <strong>{kind.label}</strong>
            <span className="mono dc-muted">{source.id}</span>
            {isNew && <span className="dc-chip alert">New</span>}
          </span>
          <span className="dc-muted">{new Date(source.recordedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        </div>
        <p>{source.content}</p>
      </div>
    </li>
  );
}

function Cites({ ids, focused }: { ids: string[]; focused: string | null }) {
  return (
    <>
      {ids.map((id) => (
        <button
          key={id}
          className={`dc-cite ${focused === id ? "active" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.focusSource(focused === id ? null : id);
          }}
          title={`Show record ${id}`}
        >
          {id}
        </button>
      ))}
    </>
  );
}

// --- Action review ----------------------------------------------------------------------

const ATTEMPT: Record<Attempt["state"], { label: string; icon: Icon }> = {
  submitting: { label: "Sending to PayPal", icon: CircleNotch },
  evidence_accepted: { label: "PayPal accepted the evidence", icon: SealCheck },
  simulated: { label: "Simulated: nothing was sent to PayPal", icon: Info },
  rejected: { label: "Not sent", icon: XCircle },
  needs_reconciliation: { label: "Outcome unknown. Check the case in PayPal before doing anything else.", icon: Warning },
};

function ActionReview(params: Params<"action-review">) {
  useDisplayed(params);
  const detail = useStore((s) => s.detail);
  const busy = useStore((s) => s.busy);
  const focused = useStore((s) => s.focusedSource);
  if (!detail) return <div className="dc-widget dc-empty">Choose a case from the queue.</div>;

  const { proposal, approval, attempts, assessment } = detail;
  const last = attempts.at(-1);
  const sent = last?.state === "evidence_accepted" || last?.state === "simulated";
  const assessed = Boolean(assessment && assessment.revision === detail.revision);
  const approved = approval.state === "approved";
  const stage = sent ? 3 : approved ? 2 : assessed ? 1 : 0;

  return (
    <div className="dc-widget reading">
      <h3 className="dc-title">Respond to PayPal</h3>
      <ol className="dc-progress" aria-label="Progress">
        {["Assess", "Approve", "Submit"].map((label, i) => (
          <li key={label} className={i < stage ? "done" : i === stage ? "current" : ""}>
            {i < stage && <CheckCircle size={14} weight="fill" />}
            {label}
          </li>
        ))}
      </ol>

      {"reason" in proposal ? (
        !sent && (
          <>
            {approval.state === "review_changed" && (
              <div className="dc-note alert">
                <Warning size={16} weight="fill" />
                <span>Your approval no longer matches this case and can't be used.</span>
              </div>
            )}
            <div className="dc-note neutral">
              <LockSimple size={16} />
              <span>{proposal.reason}</span>
            </div>
          </>
        )
      ) : (
        <>
          <dl className="dc-proposal">
            <dt>Sends</dt>
            <dd>Proof of delivery</dd>
            <dt>Tracking</dt>
            <dd>
              {proposal.evidence.carrier} <code>{proposal.evidence.trackingNumber}</code>
            </dd>
            <dt>To</dt>
            <dd>
              {proposal.target.mode === "sandbox" ? (
                <>
                  PayPal sandbox case <code>{proposal.target.disputeId}</code>
                </>
              ) : (
                `Simulated. ${proposal.target.reason}`
              )}
            </dd>
          </dl>

          <div className="dc-section-label">Your message to PayPal</div>
          <div className="dc-letter">
            {assessment?.output.draftResponse.map((d, i) => (
              <p key={i}>
                {d.sentence}
                <Cites ids={d.sourceIds} focused={focused} />
              </p>
            ))}
          </div>

          <div className="dc-actions">
            {approved ? (
              <>
                <button className="primary" disabled={busy} onClick={() => store.submit(proposal.digest)}>
                  <PaperPlaneTilt size={15} />
                  {proposal.target.mode === "sandbox" ? "Submit to PayPal" : "Submit (simulated)"}
                </button>
                <span className="dc-small dc-muted">
                  Approval valid until {new Date(approval.expiresAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </>
            ) : (
              <>
                <button className="primary" disabled={busy} onClick={() => store.approve(proposal.digest)}>
                  <CheckCircle size={15} />
                  Approve this version
                </button>
                {approval.state === "expired" && <span className="dc-chip warn">Approval expired</span>}
                {approval.state === "review_changed" && <span className="dc-chip alert">Changed since approval</span>}
              </>
            )}
          </div>
          <p className="dc-small dc-muted">Approval covers exactly this message and tracking. If a record changes, you'll be asked to approve again.</p>
        </>
      )}

      {last && <Receipt attempt={last} />}
      {detail.paypal && <PaypalStatus paypal={detail.paypal} busy={busy} />}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  WAITING_FOR_SELLER_RESPONSE: "Waiting for your response",
  WAITING_FOR_BUYER_RESPONSE: "Waiting for the buyer",
  UNDER_REVIEW: "Under PayPal review",
  RESOLVED: "Resolved",
  OTHER: "Other",
};

function PaypalStatus({ paypal, busy }: { paypal: NonNullable<CaseDetail["paypal"]>; busy: boolean }) {
  return (
    <div className="dc-paypal-status">
      <div className="dc-small">
        <span className="dc-muted">PayPal says </span>
        {paypal.last ? (
          <>
            <strong>{STATUS_TEXT[paypal.last.status] ?? paypal.last.status}</strong>
            <span className="dc-muted">, checked {new Date(paypal.last.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          </>
        ) : (
          <span className="dc-muted">not checked yet</span>
        )}
      </div>
      {paypal.canRefresh && (
        <button className="ghost" disabled={busy} onClick={store.refreshPaypal}>
          <ArrowClockwise size={15} />
          Refresh from PayPal
        </button>
      )}
    </div>
  );
}

function Receipt({ attempt }: { attempt: Attempt }) {
  const { label, icon: IconFor } = ATTEMPT[attempt.state];
  return (
    <div className={`dc-receipt ${attempt.state}`}>
      <strong className="dc-inline">
        <IconFor size={16} weight="fill" className={attempt.state === "submitting" ? "dc-spin" : undefined} />
        {label}
      </strong>
      {attempt.readBack &&
        ("error" in attempt.readBack ? (
          <p className="dc-error">Couldn't read the case back: {attempt.readBack.error}</p>
        ) : (
          <p className="dc-small">
            Right after sending, PayPal said: {STATUS_TEXT[attempt.readBack.status] ?? attempt.readBack.status}
          </p>
        ))}
      {attempt.error && (
        <p className="dc-error">
          {attempt.error}
          {attempt.debugId ? ` (PayPal debug ID ${attempt.debugId})` : ""}
        </p>
      )}
      <p className="dc-small dc-muted">
        {new Date(attempt.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, reference{" "}
        <span className="mono">{attempt.id}</span>
      </p>
    </div>
  );
}

// --- Registration -----------------------------------------------------------------------

const definition = <T extends DisputeWidgetType>(
  id: T,
  label: string,
  comp: ComponentType<Params<T>>,
  description: string,
): DisputeWidgetDefinition<T> => ({
  id,
  label,
  comp,
  form: (params) => params.createDefaults({ dataMappingItems: [] }),
  defaultSize: { width: 420, height: 600 },
  minSize: { width: 280, height: 280 },
  ai: { description },
});

export const disputeWidgets = (defaults: AgWidgetsConfig<AgDefaultRegistry>): AgWidgetsConfig<DisputeRegistry> =>
  createWidgets<DisputeRegistry>({
    additionalTypes: [
      definition("case-queue", "Case queue", CaseQueue, "Lists every dispute case grouped by urgency; selecting one opens it in the other dispute widgets."),
      definition("evidence-inspector", "Evidence inspector", EvidenceInspector, "Shows the selected case's buyer claim, the AI assessment's findings with citations, and a timeline of the source records."),
      definition("action-review", "Action review", ActionReview, "Shows the exact evidence and message that would be sent to PayPal for the selected case, with separate approve and submit controls and the PayPal receipt."),
    ],
    menu: [...defaults.menu, { label: "Disputes", widgetIds: ["case-queue", "evidence-inspector", "action-review"] }],
  });
