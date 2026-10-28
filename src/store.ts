import { useSyncExternalStore } from "react";
import { api, type CaseDetail, type QueueRow } from "./api.ts";

// One small store shared by the page and every custom Studio widget (passed in as Studio's `context`),
// so selecting a case in the queue updates the inspector and the action review together.

interface State {
  merchantName: string;
  live: { configured: boolean; sync: { at: string; error: string | null } | null };
  rows: QueueRow[];
  selectedId: string | null;
  detail: CaseDetail | null;
  /** Source ID the inspector is focused on, e.g. after clicking a citation. */
  focusedSource: string | null;
  busy: boolean;
  error: string | null;
}

let state: State = { live: { configured: false, sync: null }, merchantName: "", rows: [], selectedId: null, detail: null, focusedSource: null, busy: false, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function refresh() {
  const s = await api.scenario();
  set({ merchantName: s.merchant.name, rows: s.cases, live: s.live });
  // ?case=SCN-1002 opens a specific case, which is handy for demos and screenshots.
  const fromUrl = new URLSearchParams(location.search).get("case");
  const id = state.selectedId ?? s.cases.find((c) => c.caseId === fromUrl)?.caseId ?? s.cases[0]?.caseId ?? null;
  if (id) set({ selectedId: id, detail: await api.caseDetail(id) });
}

/** Runs a server action for the selected case, then reloads the queue and the case. */
async function run(action: (id: string) => Promise<unknown>) {
  const id = state.selectedId;
  if (!id || state.busy) return;
  set({ busy: true, error: null });
  try {
    await action(id);
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    await refresh().catch(() => {});
    set({ busy: false });
  }
}

export const store = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  refresh,
  async select(id: string) {
    if (id === state.selectedId) return;
    set({ selectedId: id, detail: null, focusedSource: null, error: null });
    const detail = await api.caseDetail(id);
    if (state.selectedId === id) set({ detail });
  },
  focusSource: (id: string | null) => set({ focusedSource: id }),
  assess: () => run(api.assess),
  advance: () => run(api.advance),
  approve: (digest: string) => run((id) => api.approve(id, digest)),
  submit: (digest: string) => run((id) => api.submit(id, digest)),
  refreshPaypal: () => run(api.refreshPaypal),
  addShipment: (body: Parameters<typeof api.addShipment>[1]) => run((id) => api.addShipment(id, body)),
  async syncLive() {
    if (state.busy) return;
    set({ busy: true, error: null });
    try {
      await api.syncLive();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      await refresh().catch(() => {});
      set({ busy: false });
    }
  },
  async reset() {
    await api.reset();
    set({ selectedId: null, detail: null, focusedSource: null, error: null });
    await refresh();
  },
};

export type Store = typeof store;

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
