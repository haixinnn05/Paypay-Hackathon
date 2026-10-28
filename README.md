# Dispute Copilot

A workspace for small PayPal sellers handling "item not received" disputes. AI reads the seller's records, explains what they support or contradict, and drafts a cited response. The seller reviews and decides. Built for the PayPal AI Hackathon with AG Studio.

**Status: early build.** Working today: synthetic scenario, AG Studio workspace with the case queue as a data source, Claude assessment with citation checks, assessments marked stale when records change, read-only PayPal sandbox probe. Not built yet: approval and submission to PayPal, custom Studio widgets, the Studio agent, hosting.

## Run locally

Requires Node.js 22+.

```sh
npm install
cp .env.example .env   # then fill it in (see below)
npm run dev            # API on :8787, app on http://localhost:5173
```

`.env`:

- `ASTRO_GATEWAY_URL` / `ASTRO_GATEWAY_API_KEY`: needed for **Run assessment**. Run `npm run gateway-key` to fill them (see below).
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: sandbox REST app credentials. Only needed for the probe and the sandbox endpoints. Never use live credentials; the client is hard-wired to the sandbox host.
- `VITE_AG_STUDIO_LICENSE_KEY`: optional. Without it AG Studio runs locally with a watermark.

## Scenario mode

All scenario records are fictional (`fixtures/scenario.json`). **SCN-1002** is the main demo case: assess it, click **Simulate new record arriving** (a carrier correction says the parcel was returned to sender), and the earlier assessment is marked **Review changed**. **Reset scenario** restores the fixtures. It never touches PayPal.

## PayPal sandbox probe (read-only)

1. In [PayPal Developer](https://developer.paypal.com/) > Testing Tools > Sandbox Accounts, use one **business** account (the merchant) and one **personal** account (the buyer).
2. Create a sandbox REST app for the business account and put its credentials in `.env`.
3. Log in to [sandbox.paypal.com](https://www.sandbox.paypal.com/) as the buyer, send a payment to the business account, then open an "item not received" dispute in the Resolution Center. See PayPal's [sandbox dispute guide](https://developer.paypal.com/disputes/test-go-live).
4. Run:

```sh
npm run probe list               # disputes this merchant app can see
npm run probe inspect <disputeId> # status, deadline and the actions PayPal currently allows
```

If a request fails, the probe prints PayPal's debug ID. Record it.

## AI Gateway (Astropods)

Assessments call Claude through the [Astropods](https://astropods.com) AI Gateway, an OpenAI-compatible endpoint that needs no model-provider key. For local development:

1. Install the CLI (`curl -fsSL https://astropods.com/install | sh`), then run `ast login` once.
2. Create the dev harness once: `ast project create astropods-gateway-dev --model gateway -y --path ~/projects`.
3. Run `npm run gateway-key` (Docker must be running). It starts the harness, copies a 24-hour development key into `.env` without printing it, and stops the harness again. Rerun it when the key expires.

## AI and tools

- **Claude Opus 5.5** via the Astropods AI Gateway, server-side: structured assessment of each case (findings, recommendation, cited draft, questions for the seller). The server rejects nothing silently: unknown source IDs and uncited draft sentences are reported in the UI. Refusals and malformed output show as errors, never as a fallback result.
- **AG Studio** (AG Grid): the workspace and case queue.
- **PayPal Disputes API** (sandbox): reading disputes; evidence submission is next.

## Licence

MIT. See [LICENSE](LICENSE).
