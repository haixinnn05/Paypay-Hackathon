// The preset "Disputes" workspace, as AG Studio report state. Field ids refer to ./data.ts.
import type { AgReportState, AgWidgetLayoutState } from "ag-studio";
import type { DisputeRegistry } from "./widgets.tsx";

// Position on the canvas grid, in tracks: 24 columns wide, rows of studioCanvasRowHeight.
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });

const FONT = '"Geist Variable", ui-sans-serif, system-ui, sans-serif';
const typography = (fontSize: number, fontWeight: "normal" | "bold" = "normal") => ({
  fontFamily: FONT,
  fontSize,
  fontWeight,
  fontStyle: "normal" as const,
});

const kpi = (text: string, value: { id: string; aggregation: "sum" | "countd" }, caption = "") => ({
  type: "value" as const,
  dataMapping: { value: [value] },
  format: {
    title: { enabled: true, text, typography: typography(13) },
    caption: { enabled: Boolean(caption), text: caption, typography: typography(12) },
    style: { typography: typography(34, "bold") },
  },
});

export const disputesReport: AgReportState<DisputeRegistry> = {
  selectedPageId: "disputes",
  // The workspace has no filter widgets, so keep the side panels closed in view mode.
  panels: { filters: { collapsed: true }, data: { collapsed: true } },
  pages: [
    {
      id: "disputes",
      widgets: {
        "kpi-action": kpi("Need your action", { id: "cases.needsAction", aggregation: "sum" }, "cases not yet answered"),
        "kpi-week": kpi("Due this week", { id: "cases.dueThisWeek", aggregation: "sum" }, "unanswered, due in 7 days"),
        "kpi-amount": kpi("Disputed in total", { id: "cases.amount", aggregation: "sum" }, "across all open cases"),
        queue: { type: "case-queue", dataMapping: {} },
        inspector: { type: "evidence-inspector", dataMapping: {} },
        action: { type: "action-review", dataMapping: {} },
      },
      widgetLayout: {
        // The queue is a full-height rail; the numbers and the case workspace share the area to its right.
        queue: at(0, 0, 6, 44),
        "kpi-action": at(6, 0, 6, 8),
        "kpi-week": at(12, 0, 6, 8),
        "kpi-amount": at(18, 0, 6, 8),
        inspector: at(6, 8, 11, 36),
        action: at(17, 8, 7, 36),
      },
    },
    {
      id: "autopilot",
      widgets: {
        panel: { type: "autopilot-panel", dataMapping: {} },
        "kpi-auto-actions": kpi("Handled by autopilot", { id: "activity.autopilotActions", aggregation: "sum" }, "actions taken or simulated"),
        "kpi-auto-refunded": kpi("Refunded by autopilot", { id: "activity.autopilotRefunded", aggregation: "sum" }, "within your limits"),
        log: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "activity.at" },
              { id: "activity.caseId" },
              { id: "activity.action" },
              { id: "activity.by" },
              { id: "activity.result" },
              { id: "activity.amount", aggregation: "sum" },
              { id: "activity.mode" },
              { id: "activity.rule" },
              { id: "activity.detail" },
            ],
          },
          sort: [{ field: { id: "activity.at" }, direction: "desc" }],
          format: { title: { enabled: true, text: "Activity log: every action sent or simulated" } },
        },
      },
      widgetLayout: {
        panel: at(0, 0, 9, 44),
        "kpi-auto-actions": at(9, 0, 7, 8),
        "kpi-auto-refunded": at(16, 0, 8, 8),
        log: at(9, 8, 15, 36),
      },
    },
  ],
};
