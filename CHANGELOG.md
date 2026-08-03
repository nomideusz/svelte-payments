# Changelog

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
