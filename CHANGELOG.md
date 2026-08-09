# Changelog

## 0.4.0 — 2026-08-09

### Added
- **Idempotency keys.** `idempotencyKey?` on `CreatePaymentInput`,
  `CreateSubscriptionInput` and `refund()` opts, sent as Mollie's
  `Idempotency-Key` header — a retried mutating call (timeout, crash between
  your DB claim and the provider's response) returns the original result
  instead of acting twice. Previously `call()` sent no such header and callers
  could not inject one; the sharpest failure that closes: subscription-create
  timeout → app releases its DB claim → retry → two live monthly charges on
  the same mandate. Pair with a keyed row in your DB (insert key first, call
  with it) — the pattern thebest's financial-event ledger uses with Stripe.
- **Connect/OAuth readiness** (per `docs/plans/2026-08-07-mollie-connect-spec.md`):
  `mollie(apiKey, { testmode: true })` — OAuth tokens span live+test and need
  the explicit flag on every call (POST bodies get `testmode: true`, reads get
  `?testmode=true`); `CreatePaymentInput.profileId` /
  `CreateSubscriptionInput.profileId` — org-level OAuth tokens must name the
  profile per payment; `CreatePaymentInput.applicationFee` — integer minor
  units, converted to Mollie's amount object. All optional; API-key usage is
  byte-identical to 0.3.0.

### Fixed
- README webhook example now carries the SvelteKit CSRF caveat: Mollie's
  form-encoded, Origin-less webhook POST is 403'd by SvelteKit's built-in CSRF
  check *before any hook runs* — the built-in check must be disabled and
  re-implemented in hooks, with the webhook path handled first. The old
  example, followed literally, produced a webhook endpoint that fails every
  delivery.

## 0.3.0 — 2026-08-03

### Added
- `CreatePaymentInput.billingEmail` — forwarded to the provider so methods
  that ask for an e-mail (Przelewy24) prefill it instead of collecting a
  second, possibly different address.
- `Payment.consumerName` — the payer's real name as reported by the payment
  method (P24 `consumerName`, card `cardHolder`), for backfilling guest
  records created from an e-mail alone.

## 0.2.2 — 2026-08-03

### Added
- Demo site at https://svelte-payments.vercel.app/ — StripeConnectStatus in both
  states plus the server checkout API. `homepage` now points at it.

## 0.2.1 — 2026-08-03

### Changed
- `sideEffects: false` in package.json, so bundlers can tree-shake unused
  exports. Every module here is pure; without the declaration a consumer
  importing one helper had to ship the whole library.

### Added
- Standalone repo at github.com/nomideusz/svelte-payments with a Release & Publish
  workflow, so this package has a reproducible release path for the first time.

Backfilled 2026-08-02 from git history. Entries before that date are
reconstructed from commits, so they record what changed rather than a release
that was tagged at the time.

## 0.2.0 — 2026-07-29/30

### Added
- Provider-agnostic payment types and a **Mollie adapter** (`/server` subpath).
- `createCheckout` — checkout orchestration and refunds over the adapter.
- Customers and subscriptions in the Mollie adapter.
- `MollieCard` — embedded card form using Mollie Components.
- README, ahead of the first npm release.

### Note
Stripe is not yet behind this interface; thebest still holds its Stripe logic
app-locally. The abstraction is real but has so far been proven against one
provider — see `docs/plans/2026-08-02-v1-roadmap.md`.

## 0.1.0

### Added
- `StripeConnectStatus` component.
