import { createAiHarness, directLlmRunner, type AgAiHarness, type AgAiHarnessSetup, type AgAiPromptStarter, type AgStudioApi } from "ag-studio";
import { api as server } from "../api.ts";
import { store } from "../store.ts";
import { openaiAdapter } from "./openaiAdapter.tsx";

// Studio's AI: our Dispute agent fronts the conversation and hands dashboard work to AG's own agents.
// Every model call goes through this app's /api/ai proxy to the Astropods AI Gateway.
//
// The Dispute agent can read cases and open one on screen. It has no tool that approves or submits
// anything: those stay as the seller's own clicks in the Action review widget.

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: "What needs me first?", prompt: "Which cases should I deal with first, and why?" },
  { label: "Why did my approval change?", prompt: "Explain why the approval on the selected case is no longer valid, citing the records." },
  { label: "Chart deadlines", prompt: "Add a chart of disputed amount by response due date." },
];

const INSTRUCTIONS = `You are the Dispute agent in a workspace for a small online seller handling PayPal "item not received" disputes.
All records here are fictional scenario data in the PayPal sandbox.

Use list_cases and get_case to answer questions about cases. Quote record IDs (S1, S2, ...) for every fact you state, and say plainly when records conflict or something is missing. A carrier "delivered" scan is a carrier record, not proof of receipt.
Use open_case when the seller wants to look at a case.

You cannot approve, submit or refund anything. When the seller wants to act, tell them to review the exact proposal in the Action review widget and use its Approve and Submit buttons.

For anything that changes the dashboard itself (adding, moving or editing widgets, filters, pages), delegate to the "lead" agent with a clear description of what to build.

Be brief and concrete.`;

// The harness Studio builds, exposed so our own assistant drawer can open conversations on it.
let current: AgAiHarness | null = null;
const harnessListeners = new Set<() => void>();
export const harness = {
  get: () => current,
  subscribe(listener: () => void) {
    harnessListeners.add(listener);
    return () => harnessListeners.delete(listener);
  },
};

/**
 * Studio builds its harness lazily, only when its own chat panel first opens (edit mode). The app
 * calls `ensure` as soon as Studio's API is ready so the drawer works in view mode, and Studio is
 * handed the same instance whenever it asks.
 */
export function buildAi(models: string[]): { setup: AgAiHarnessSetup; ensure: (api: AgStudioApi) => AgAiHarness } {
  const adapter = openaiAdapter({ endpoint: "/api/ai", model: models[0] });

  const ensure = (api: AgStudioApi): AgAiHarness => {
    if (current) return current;
    current = createAiHarness(api, ({ tools, builtIn }) => ({
      agents: [
        directLlmRunner({
          id: "disputes",
          name: "Dispute agent",
          description: "Answers questions about the seller's dispute cases and their evidence.",
          instructions: () => INSTRUCTIONS,
          tools: () => [...disputeTools(api), tools.studio.viewPage(), tools.delegateTo(["lead"]), tools.renameThread()],
          adapter,
        }),
        ...Object.values(builtIn).map((definition) => directLlmRunner({ ...definition, adapter })),
      ],
      primary: "disputes",
      promptStarters: PROMPT_STARTERS,
      models: models.length > 1 ? models.map((id) => ({ id, label: id })) : undefined,
    }));
    harnessListeners.forEach((l) => l());
    return current;
  };

  return { setup: ({ api }) => ensure(api), ensure };
}

function disputeTools(api: AgStudioApi) {
  return [
    api.defineAiTool({
      name: "list_cases",
      description: "List every dispute case with amount, response deadline, next step, approval state and whether it is linked to a real PayPal sandbox dispute.",
      params: (s) => s.object({}),
      execute: async (_args, ctx) => {
        const { cases } = await server.scenario();
        return ctx.success(`${cases.length} cases.`, { cases });
      },
    }),
    api.defineAiTool({
      name: "get_case",
      description:
        "Get one case in full: the buyer's claim, every source record (S1, S2, ...), the latest AI assessment and whether it is stale, the proposed PayPal action or why there is none, the approval state, and past submissions.",
      params: (s) => s.object({ caseId: s.string({ description: "Case ID, e.g. SCN-1002." }) }),
      execute: async ({ caseId }, ctx) => {
        try {
          // hasPendingRecords is a demo-scenario control, not something a real seller would know.
          const { hasPendingRecords: _, ...d } = await server.caseDetail(caseId);
          const stale = d.assessment ? d.assessment.revision !== d.revision : null;
          return ctx.success(`Case ${caseId}.`, { ...d, assessmentIsStale: stale });
        } catch {
          return ctx.error(`No case ${caseId}. Call list_cases for valid IDs.`);
        }
      },
    }),
    api.defineAiTool({
      name: "open_case",
      description: "Open a case in the workspace so the seller sees it in the evidence inspector and action review widgets.",
      params: (s) => s.object({ caseId: s.string({ description: "Case ID, e.g. SCN-1002." }) }),
      execute: async ({ caseId }, ctx) => {
        if (!store.getState().rows.some((r) => r.caseId === caseId)) return ctx.error(`No case ${caseId}.`);
        await store.select(caseId);
        return ctx.success(`Opened ${caseId}.`);
      },
    }),
  ];
}
