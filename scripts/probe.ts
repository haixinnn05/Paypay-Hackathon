// Day-1 sandbox probe: can this merchant app see real sandbox disputes, and which actions does PayPal offer?
// Read-only. Usage: npm run probe list | npm run probe inspect [disputeId]
import { env, paypalConfigured } from "../server/env.ts";
import { getDispute, listDisputes, PayPalError } from "../server/paypal.ts";

const [command = "list", argId] = process.argv.slice(2);

async function main() {
  if (!paypalConfigured()) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox credentials only).");
    process.exit(1);
  }

  if (command === "list") {
    const items = await listDisputes();
    if (items.length === 0) {
      console.log("Authenticated, but this merchant has no disputes yet. Open one as the sandbox buyer, then rerun.");
      return;
    }
    console.table(
      items.map((d) => ({
        id: d.dispute_id,
        reason: d.reason,
        status: d.status,
        amount: d.dispute_amount ? `${d.dispute_amount.value} ${d.dispute_amount.currency_code}` : "",
        updated: d.update_time,
      })),
    );
    return;
  }

  if (command === "inspect") {
    const id = argId ?? env.paypalDisputeId;
    if (!id) throw new Error("Pass a dispute ID or set PAYPAL_DISPUTE_ID");
    const d = await getDispute(id);
    console.log({
      id: d.dispute_id,
      reason: d.reason,
      status: d.status,
      stage: d.dispute_life_cycle_stage,
      channel: d.dispute_channel,
      amount: d.dispute_amount,
      sellerResponseDue: d.seller_response_due_date,
      transactions: d.disputed_transactions?.map((t) => t.seller_transaction_id),
      evidenceCount: d.evidences?.length ?? 0,
    });
    console.log("\nActions PayPal currently offers for this case:");
    console.table((d.links ?? []).map((l) => ({ rel: l.rel, method: l.method, href: l.href.replace(/^https:\/\/[^/]+/, "") })));
    return;
  }

  throw new Error(`Unknown command "${command}". Use list or inspect.`);
}

main().catch((err) => {
  if (err instanceof PayPalError) {
    console.error(err.message);
    console.error(`PayPal debug ID: ${err.debugId ?? "none"}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
