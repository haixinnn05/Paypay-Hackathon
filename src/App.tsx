import { useEffect, useMemo, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { ArrowCounterClockwise, ChatCircleText, PencilSimple, ShieldCheck, X } from "@phosphor-icons/react";
import { Assistant } from "./Assistant.tsx";
import { store, useStore } from "./store.ts";
import { buildAi } from "./studio/ai.ts";
import { buildStudioData } from "./studio/data.ts";
import { disputesReport } from "./studio/report.ts";
import { disputeTheme } from "./studio/theme.ts";
import { disputeWidgets, type DisputeRegistry } from "./studio/widgets.tsx";

if (import.meta.env.DEV) enableStudioDevValidations();

export function App() {
  const rows = useStore((s) => s.rows);
  const merchantName = useStore((s) => s.merchantName);
  // Studio shows its AI panel only in edit mode. ?mode=edit opens straight into it.
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<AgStudioMode>(params.get("mode") === "edit" ? "edit" : "view");
  const [assistantOpen, setAssistantOpen] = useState(params.get("assistant") === "open");
  // undefined while loading; null if the assistant is unavailable, in which case Studio runs without it.
  const [ai, setAi] = useState<ReturnType<typeof buildAi> | null | undefined>(undefined);

  useEffect(() => {
    store.refresh();
    // The server decides which gateway models the assistant may use.
    // Only ask for models when the server runs live AI; the public demo serves saved results instead.
    fetch("/api/config")
      .then((r) => r.json())
      .then(async ({ aiMode }: { aiMode: "live" | "saved" }) => {
        if (aiMode !== "live") return setAi(null);
        const { models }: { models: string[] } = await fetch("/api/ai/models").then((r) => r.json());
        setAi(buildAi(models));
      })
      .catch(() => setAi(null));
  }, []);

  // Studio re-reads data when this object changes, so rebuild it only when the queue does.
  const studioData = useMemo(() => buildStudioData(rows), [rows]);

  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">
            <ShieldCheck size={17} weight="bold" />
          </span>
          Dispute Copilot
        </span>
        <span className="merchant">{merchantName}</span>
        <span className="sandbox-badge">PayPal sandbox, synthetic data</span>
        <span className="spacer" />
        {ai && (
          <button className={assistantOpen ? "primary" : "ghost"} onClick={() => setAssistantOpen(!assistantOpen)} aria-expanded={assistantOpen}>
            {assistantOpen ? <X size={16} /> : <ChatCircleText size={16} />}
            {assistantOpen ? "Close assistant" : "Ask assistant"}
          </button>
        )}
        <button className="ghost" onClick={() => setMode(mode === "view" ? "edit" : "view")} title="Studio's layout editor, with its own AI panel">
          <PencilSimple size={16} />
          {mode === "view" ? "Edit layout" : "Done editing"}
        </button>
        <button className="ghost" onClick={store.reset} title="Restores the demo cases. Never touches PayPal.">
          <ArrowCounterClockwise size={16} />
          Reset demo
        </button>
      </header>
      <main>
        {rows.length > 0 && ai !== undefined && (
          <AgStudioProvider licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY || undefined} modules={ai ? [AgStudioAiModule] : []}>
            <AgStudio<DisputeRegistry>
              style={{ height: "100%", width: "100%" }}
              theme={disputeTheme}
              data={studioData}
              widgets={disputeWidgets}
              initialState={disputesReport}
              context={store}
              ai={ai?.setup}
              onApiReady={({ api }) => ai?.ensure(api)}
              // No filters in this workspace, so view mode shows no side panels. Edit mode keeps the
              // assistant on the left and Studio's editing panels on the right.
              panels={{ view: { left: [], right: [] }, edit: { left: ["ai"], right: ["edit", "data", "filters"] } }}
              mode={mode}
            />
          </AgStudioProvider>
        )}
        {ai && <Assistant open={assistantOpen} onClose={() => setAssistantOpen(false)} />}
      </main>
    </div>
  );
}
