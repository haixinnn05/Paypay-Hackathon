import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat } from "ag-studio";
import type { ActivityRow, QueueRow } from "../api.ts";
import type { DisputeRegistry } from "./widgets.tsx";

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean, description?: string];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide, description]) => ({
    id,
    name,
    format,
    ...(description && { description }),
    ...(format === "currencyFormat" && { formatOptions: { format: usd } }),
    ...(hide && { hide }),
  }));

export function buildStudioData(rows: QueueRow[], activity: ActivityRow[]): AgDataSourcesDefinition<DisputeRegistry> {
  return {
    description:
      "PayPal 'item not received' disputes for one small seller. All records are fictional scenario data. " +
      "Amounts are USD. nextStep is the plain-language action each case needs.",
    sources: [
      {
        id: "cases",
        description: "One row per dispute case.",
        data: rows.map((r) => ({ ...r, sellerResponseDue: r.sellerResponseDue.slice(0, 10) })),
        fields: fields([
          ["caseId", "Case", "textFormat"],
          ["orderRef", "Order", "textFormat"],
          ["buyer", "Buyer", "textFormat"],
          ["amount", "Disputed amount", "currencyFormat", false, "Disputed amount in USD. Sum it when aggregating."],
          ["currency", "Currency", "textFormat", true],
          ["providerStatus", "PayPal status", "textFormat"],
          ["sellerResponseDue", "Response due", "dateFormat", false, "Date the seller must respond to PayPal by. To chart by due date, map this field as the category and sort by that same mapped field."],
          ["sourceCount", "Records", "integerFormat"],
          ["nextStep", "Next step", "textFormat", false, "The plain-language action the case needs next."],
          ["needsAction", "Needs action", "integerFormat"],
          ["answered", "Answered", "integerFormat"],
          ["dueThisWeek", "Due this week", "integerFormat"],
          ["recommendation", "Recommendation", "textFormat", true],
          ["assessmentState", "Assessment", "textFormat", true],
          ["approvalState", "Approval", "textFormat", true],
          ["lastAttempt", "Last submission", "textFormat", true],
          ["linkedDispute", "PayPal dispute", "textFormat", true],
          ["revision", "Revision", "textFormat", true],
        ]),
      },
      {
        id: "activity",
        description: "Every PayPal action taken or simulated, by the seller or the autopilot, newest first.",
        data: activity,
        fields: fields([
          ["at", "When", "dateTimeFormat"],
          ["caseId", "Case", "textFormat"],
          ["action", "Action", "textFormat"],
          ["by", "By", "textFormat"],
          ["rule", "Rule", "textFormat"],
          ["result", "Result", "textFormat"],
          ["amount", "Amount", "currencyFormat"],
          ["mode", "Where", "textFormat"],
          ["detail", "Detail", "textFormat"],
          ["autopilotActions", "Autopilot actions", "integerFormat", false, "1 for each action the autopilot took or simulated."],
          ["autopilotRefunded", "Refunded by autopilot", "currencyFormat", false, "Amount the autopilot refunded."],
          ["id", "Reference", "textFormat", true],
        ]),
      },
    ],
  };
}
