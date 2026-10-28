import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgAiChatMessage, AgAiChatSession, AgAiToolCallView } from "ag-studio";
import { ArrowUp, CheckCircle, CircleNotch, Stop, Warning, X } from "@phosphor-icons/react";
import { harness } from "./studio/ai.ts";
import { store, useStore } from "./store.ts";

// Our own chat drawer on Studio's AI harness. Studio shows its chat panel only in edit mode; this
// gives sellers the same agents from the normal view, with answers they can click through.

const TOOL_LABEL: Record<string, (args: Record<string, unknown>) => string> = {
  list_cases: () => "Looked through your cases",
  get_case: (a) => `Read case ${a.caseId ?? ""}`,
  open_case: (a) => `Opened ${a.caseId ?? "the case"}`,
  delegate_to: () => "Asked the dashboard agent to make the change",
  view_page: () => "Looked at the dashboard",
  rename_thread: () => "Named the conversation",
};

export function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ready = useSyncExternalStore(harness.subscribe, () => harness.get() !== null);
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [, rerender] = useState(0);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const detail = useStore((s) => s.detail);

  // Start one conversation the first time the drawer opens.
  useEffect(() => {
    const h = harness.get();
    if (!open || !ready || session || !h) return;
    let cancelled = false;
    h.createThread({ agentId: "disputes", title: "Disputes" }).then((s) => {
      if (cancelled) return s.close();
      s.addEventListener("changed", () => rerender((n) => n + 1));
      setSession(s);
      // Dev only: ?ask=... sends one question on open, for scripted screenshots.
      const ask = import.meta.env.DEV ? new URLSearchParams(location.search).get("ask") : null;
      if (ask) s.sendMessage(ask);
    });
    return () => {
      cancelled = true;
    };
  }, [open, ready, session]);

  useEffect(() => () => session?.close(), [session]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  });

  const running = session?.status === "running";
  const messages = (session?.messages ?? []).filter((m) => m.role !== "system");

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !session || running) return;
    session.sendMessage(trimmed);
    setDraft("");
  }

  const suggestions = [
    "Which case should I deal with first?",
    detail ? `What do the records show for ${detail.caseId}?` : null,
    detail?.assessment && detail.assessment.revision !== detail.revision ? `What changed on ${detail.caseId}?` : null,
    "Add a chart of disputed amount by due date",
  ].filter((s): s is string => Boolean(s));

  return (
    <aside className={`assistant ${open ? "open" : ""}`} aria-hidden={!open} aria-label="Assistant">
      <header className="assistant-head">
        <div>
          <strong>Assistant</strong>
          <p className="dc-small dc-muted">Reads your cases and can change the dashboard. It can't approve or send anything.</p>
        </div>
        <button className="ghost icon" onClick={onClose} aria-label="Close assistant">
          <X size={16} />
        </button>
      </header>

      <div className="assistant-body" ref={scroller}>
        {!ready && <p className="dc-muted">The assistant isn't available right now.</p>}
        {ready && messages.length === 0 && (
          <div className="assistant-empty">
            <p className="dc-muted">Ask about a case, a deadline or what to do next. Answers cite record IDs you can click.</p>
            <div className="assistant-suggestions">
              {suggestions.map((s) => (
                <button key={s} className="ghost" onClick={() => send(s)} disabled={!session}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {groupTurns(messages).map((turn) =>
          turn.role === "user" ? (
            <div key={turn.key} className="msg user">
              {turn.text}
            </div>
          ) : (
            <AssistantTurn key={turn.key} parts={turn.parts} />
          ),
        )}
        {running && (
          <p className="assistant-thinking dc-small dc-muted">
            <CircleNotch size={14} className="dc-spin" /> Working
          </p>
        )}
        {session?.status === "error" && (
          <p className="dc-error dc-inline">
            <Warning size={14} /> Something went wrong. Try asking again.
          </p>
        )}
      </div>

      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          ref={input}
          rows={2}
          value={draft}
          placeholder="Ask about your disputes"
          aria-label="Message the assistant"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {running ? (
          <button type="button" className="ghost icon" onClick={() => session?.cancel()} aria-label="Stop">
            <Stop size={16} weight="fill" />
          </button>
        ) : (
          <button type="submit" className="primary icon" disabled={!draft.trim() || !session} aria-label="Send">
            <ArrowUp size={16} weight="bold" />
          </button>
        )}
      </form>
    </aside>
  );
}

type Part = AgAiChatMessage["parts"][number];
type Turn = { key: string; role: "user"; text: string } | { key: string; role: "assistant"; parts: Part[] };

/** One bubble per assistant turn: a run's tool steps and text arrive as several messages. */
function groupTurns(messages: readonly AgAiChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ key: m.id, role: "user", text: m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") });
      continue;
    }
    const last = turns.at(-1);
    if (last?.role === "assistant") last.parts.push(...m.parts);
    else turns.push({ key: m.id, role: "assistant", parts: [...m.parts] });
  }
  return turns;
}

function AssistantTurn({ parts }: { parts: Part[] }) {
  const steps = parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
  const rest = parts.filter((p) => p.type === "text" || p.type === "error").filter((p) => p.type !== "text" || p.text.trim());
  if (steps.length === 0 && rest.length === 0) return null;
  return (
    <div className="msg assistant-msg">
      {steps.length > 0 && (
        <div className="tool-steps">
          {steps.map((p) => (
            <ToolStep key={p.toolCall.toolCallId} call={p.toolCall} />
          ))}
        </div>
      )}
      {rest.map((part, i) =>
        part.type === "text" ? <RichText key={i} text={part.text} /> : part.type === "error" ? <p key={i} className="dc-error">{part.message}</p> : null,
      )}
    </div>
  );
}

function ToolStep({ call }: { call: AgAiToolCallView }) {
  const label = TOOL_LABEL[call.name]?.(call.args as Record<string, unknown>) ?? `Used ${call.name.replace(/_/g, " ")}`;
  const done = call.status === "complete";
  const failed = call.status === "error" || call.status === "cancelled";
  return (
    <p className={`tool-step dc-small ${failed ? "dc-error" : "dc-muted"}`}>
      {done ? <CheckCircle size={13} weight="fill" /> : failed ? <Warning size={13} /> : <CircleNotch size={13} className="dc-spin" />}
      {label}
    </p>
  );
}

/** Paragraphs, "- " lists and **bold**, with record IDs (S3) and case IDs (SCN-1002) made clickable. */
function RichText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length)
      out.push(
        <ul key={out.length}>
          {list.map((item, j) => (
            <li key={j}>{inline(item)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of text.trim().split("\n")) {
    const line = raw.trim();
    const item = line.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (!line) {
      flushPara();
      flushList();
    } else if (item) {
      flushPara();
      list.push(item[2]);
    } else {
      flushList();
      para.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushPara();
  flushList();
  return <>{out}</>;
}

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|@widget\[[^\]]+\]|\bSCN-\d+\b|\bS\d+\b)/g).map((piece, i) => {
    // Studio's agents refer to widgets as @widget[id]; show the id as a readable name.
    const widget = piece.match(/^@widget\[([^\]]+)\]$/);
    if (widget) return <strong key={i}>"{widget[1].replace(/[-_]/g, " ")}"</strong>;
    if (/^\*\*[^*]+\*\*$/.test(piece)) return <strong key={i}>{inline(piece.slice(2, -2))}</strong>;
    if (/^SCN-\d+$/.test(piece))
      return (
        <button key={i} className="dc-cite" onClick={() => store.select(piece)} title={`Open ${piece}`}>
          {piece}
        </button>
      );
    if (/^S\d+$/.test(piece))
      return (
        <button key={i} className="dc-cite" onClick={() => store.focusSource(piece)} title={`Show record ${piece}`}>
          {piece}
        </button>
      );
    return <Fragment key={i}>{piece}</Fragment>;
  });
}
