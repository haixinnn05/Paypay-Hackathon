# Dispute Copilot

A dispute desk for small PayPal sellers, with an autopilot. It loads the seller's open "item not received" disputes straight from PayPal, has AI read the records (what they support, contradict or leave open, with every claim cited), and then handles the routine cases under rules the seller sets: refund small claims that never shipped, message the buyer first, or submit evidence when the records clearly support it. Everything else waits for the seller, who approves the exact version that goes to PayPal. The AI reads; the seller's rules decide; PayPal carries it out; every action lands in an activity log.

Built for the PayPal AI Hackathon with the PayPal Disputes API, Claude (through the Astropods AI Gateway) and AG Studio.

**Live demo: https://dispute-copilot-dvp8.onrender.com**

## Try it in two minutes

The demo opens on a fictional pottery shop with five open disputes. All records are synthetic.

1. Pick **M. O\*\*\*\*\*, SCN-1002** in the case list on the left (due soonest).
2. Click **Assess this case**. The verdict says the records support a response, and the red box shows where the buyer's claim and the carrier record disagree.
3. Click a citation such as **S3**. The matching record lights up in the timeline below.
4. In **Respond to PayPal**, read the exact message and tracking that would be sent, then click **Approve this version**.
5. Click **Add next record (demo)**. A carrier correction arrives saying the parcel went back to the sender. The case turns **Review changed**, the old assessment fades, and **Submit is no longer offered**: the approval was tied to the records that just changed.
6. Click **Reassess**. The verdict changes to **Consider a refund instead**.
7. Open the **Autopilot** tab and click **Preview**. Each open case gets a plain decision: the $12 order that never shipped (SCN-1006) would be refunded under the "refund small claims" rule, the $61 case is left for you because a refund there is above your limit, and so on. Nothing is sent until you click **Run**, which carries out exactly what the preview showed and records it in the activity log.
8. Click **Reset demo** to start over.

On the hosted demo:

- **AI results are saved, not live.** Each assessment was generated in advance with the live model for that exact case state, and is labelled "Saved AI result". No AI key lives on the server, and the chat assistant is switched off.
- **PayPal actions are simulated,** including the autopilot's. Nothing is sent to PayPal from the public site, and it shows only the demo cases.
- **The demo is shared.** If someone else has been clicking around, press **Reset demo**.

To see live AI, the assistant and a real PayPal sandbox submission, run it locally (below) or watch the demo video.

## What it does

| Part | What happens |
| --- | --- |
| **Case queue** | Cases grouped by urgency (due this week, later, answered), with deadline countdowns and the next step for each. |
| **Assessment** | Claude reads the buyer's claim and the seller's records and returns structured findings (supported, conflicting, missing, unconfirmed), a recommendation, a cited draft and questions for the seller. The server rejects citations to records that don't exist and flags uncited sentences. |
| **Evidence inspector** | Conflicts first, then gaps. Records appear as a timeline; anything that arrived after the assessment is marked **New**. |
| **Respond to PayPal** | The exact payload: proof of delivery with carrier and tracking, plus the message. Approve and Submit are separate clicks. |
| **Approval binding** | An approval covers one version of the case, records, draft and action, and expires after five minutes. Any change invalidates it. Before submitting, the server re-reads the PayPal dispute, checks it still accepts evidence and that its amount matches the case, records the attempt, then sends exactly once. |
| **Live PayPal cases** (local) | The seller's real sandbox disputes load from PayPal, built from PayPal's own data: the disputed transaction, Seller Protection status, buyer messages and evidence already sent. PayPal doesn't know the seller's tracking for a plain payment, so the seller can add shipment details; they are shown to the AI as entered by the seller. |
| **Autopilot** | Rules the seller switches on, with dollar limits: refund small claims with no shipment record, message the buyer first with the tracking, submit evidence when the records support it. A per-run refund budget caps the total. Decisions are plain code over the AI assessment, never the model's own call. Preview always comes first; Run does exactly what the preview showed, with a warning when real sandbox disputes would be touched. |
| **Activity log** | An AG Grid table of every PayPal action, by the seller or the autopilot, real or simulated, with the rule that triggered it. |
| **Assistant** (local, live AI) | A chat drawer on AG Studio's agent framework. Our Dispute agent reads cases and opens them on screen; for dashboard changes ("add a chart of disputed amount by due date") it hands off to AG Studio's built-in agents. It has no tool that can approve, submit or refund. |

## How PayPal is used

PayPal Disputes API, sandbox only (the client has no live host):

- `GET /v1/customer/disputes` and `GET /v1/customer/disputes/{id}` to load live cases: transaction, Seller Protection, messages, evidence requests and the actions PayPal currently allows.
- `POST .../provide-evidence` with `PROOF_OF_FULFILLMENT` (carrier and tracking) and notes.
- `POST .../send-message` to message the buyer, `POST .../accept-claim` for a full refund, `POST .../make-offer` for a refund offer.
- Every write, whether the seller clicked or the autopilot decided, takes the same path: record the attempt, re-read the dispute, check the amount matches and that PayPal currently advertises that action, send once, read the case back. A timeout leaves the case in **Needs reconciliation** and blocks further writes.

We tested this end to end on a real sandbox dispute: PayPal accepted the evidence and moved the case to `UNDER_REVIEW`, then `WAITING_FOR_BUYER_RESPONSE`. An accepted submission is shown as **Evidence accepted by PayPal**, never as a won case.

## AI and tools used

- **Claude Opus 5.5** through the **Astropods AI Gateway** (OpenAI-compatible endpoint, structured JSON-schema output). Used for case assessments (server-side, `server/assess.ts`) and for the agents behind the assistant.
- **AG Studio** (AG Grid): the whole workspace. Custom widgets (case queue, evidence inspector, action review), a custom theme with frosted-glass panels, a preset layout, built-in value widgets, and the **Studio Agent Framework**: a custom primary agent with its own tools that delegates dashboard work to Studio's built-in agents, plus our own chat drawer built on Studio's AI harness.
- **Render** for hosting.
- Built with **Claude Code** as the coding assistant.

## Evaluation

The assessment step was run on 15 held-out synthetic cases (`eval/cases.json`), written after the prompt and not used to tune it, and graded automatically (`npm run eval`, grader in `eval/run.ts`). Run on Oct 28, 2026 with Claude Opus 5.5:

| Check | Result |
| --- | --- |
| Recommendation within the answer key | 15/15 |
| Planted contradiction between two records flagged, citing both | 4/4 |
| Tracking numbers and amounts in the draft found in the records each sentence cites | 15/15 |
| Instructions planted inside records ignored | 2/2 |
| Draft avoids claims no record supports (e.g. a signature) | 2/2 |
| Every draft sentence cites a record | 13/15 |
| **All checks passed** | **13/15 cases** |

Both misses are holding sentences in cases where the assessment correctly said not to respond yet ("We are checking the current status with USPS and will update this case"). They promise an action rather than state a fact, but they still have no source, so they count as failures; the app already refuses to approve a draft with an uncited sentence. Full per-case results are in [`eval/results.md`](eval/results.md).

This is a small synthetic set. It shows how the assessment behaves on known situations, not how real disputes turn out.

## Run it locally with live AI

Requires Node.js 22+ and Docker (only for minting AI keys).

```sh
git clone https://github.com/haixinnn05/Paypay-Hackathon.git
cd Paypay-Hackathon
npm install
cp .env.example .env
```

**1. Live AI (Astropods AI Gateway, free account)**

```sh
curl -fsSL https://astropods.com/install | sh   # installs the ast CLI
ast login
ast project create astropods-gateway-dev --model gateway -y --path ~/projects
npm run gateway-key   # writes a 24-hour development key into .env without printing it
```

Rerun `npm run gateway-key` when the key expires. Without a key the app falls back to the saved results, like the hosted demo.

**2. PayPal sandbox (optional, for real submissions)**

1. In [PayPal Developer](https://developer.paypal.com/) (Sandbox), create a REST app for your sandbox **business** account and put its client ID and secret in `.env`.
2. Sign in to [sandbox.paypal.com](https://www.sandbox.paypal.com/) as the sandbox **personal** account, send a payment to the business account as goods and services, and open an "item not received" dispute in the Resolution Center.
3. `npm run probe list` shows the disputes the app can see; `npm run probe inspect <id>` shows the actions PayPal currently allows. New disputes can take a few minutes to appear.
4. Start the app: your disputes appear in the case list tagged **Live PayPal**. Set `ALLOW_SANDBOX_WRITES=true` to let your clicks and the autopilot act on them; otherwise those actions are simulated. Open a dispute of $15 or less to see the autopilot refund one.

**3. Start**

```sh
npm run dev   # http://localhost:5173
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `ASTRO_GATEWAY_URL`, `ASTRO_GATEWAY_API_KEY` | AI Gateway. Filled by `npm run gateway-key`. |
| `AI_MODE` | `live` or `saved`. Defaults to `live` when a key is set. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app. Optional. |
| `SANDBOX_LINKS` | Optional `CASE:DISPUTE` pairs linking demo cases to real sandbox disputes. Not needed for live cases. |
| `ALLOW_SANDBOX_WRITES` | Real PayPal actions (evidence, messages, refunds) happen only when `true`. Leave unset on a public deployment. |
| `STUDIO_AI_MODELS` | Models the assistant may use. Default `claude-opus-5-5`. |
| `ASSESS_LIMIT`, `AI_LIMIT`, and their `_DAILY_` variants | Per-visitor and daily limits on AI use. |
| `VITE_AG_STUDIO_LICENSE_KEY` | Optional. Without it AG Studio shows a watermark. |

`npm run save-assessments` regenerates `fixtures/saved-assessments.json` with the live model.

## Project layout

```
server/      Express API: PayPal client, assessments, approvals and submissions, AI proxy, limits
src/         React app: store, assistant drawer, styles
src/studio/  AG Studio theme, data source, preset layout, custom widgets, agents
fixtures/    Synthetic scenario and saved AI results
scripts/     Sandbox probe, saved-result generator, gateway key helper
eval/        Held-out evaluation cases, grader and latest results
```

## Limits

- One fictional merchant and one dispute reason (item not received). Other reasons and refund offers are left to PayPal.
- Assessments are a reading of the records, not a prediction. A carrier "delivered" scan is shown as a carrier record, not as proof the buyer received the parcel.
- Submission attempts are stored in a local JSON file. A timeout leaves the case in **Needs reconciliation** and blocks further submissions until it is checked in PayPal.
- No seller has used it yet; time savings and dispute outcomes are not measured. The evaluation above covers the assessment step only.

## Licence

MIT. See [LICENSE](LICENSE).
