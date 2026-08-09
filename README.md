# @nomideusz/svelte-payments

[![npm](https://badgen.net/npm/v/@nomideusz/svelte-payments)](https://www.npmjs.com/package/@nomideusz/svelte-payments) [![license](https://badgen.net/badge/license/MIT/blue)](https://github.com/nomideusz/svelte-payments/blob/main/LICENSE)

Provider-agnostic payments for Svelte 5 booking products — hosted checkout, embedded card fields, subscriptions, refunds, and a webhook-safe settlement state machine. Currently ships a **Mollie** adapter (zero dependencies, plain `fetch`); the interfaces are deliberately shaped to fit Stripe Checkout next.

## Installation

```bash
npm install @nomideusz/svelte-payments
```

## The model

Amounts are **always integer minor units** (cents/grosze). The provider's webhook body is never trusted — the authenticated re-fetch of the payment is the verification.

```ts
import { mollie, createCheckout } from '@nomideusz/svelte-payments/server';

const provider = mollie(MOLLIE_API_KEY);

const checkout = createCheckout(provider, {
  // your only integration point — all callbacks must be idempotent
  savePayment: async (p) => db.upsertPayment(p),
  onPaid: async (p) => confirmOrder(p.metadata?.orderId),
  onFailed: async (p) => releaseHold(p.metadata?.orderId),
});

// 1. start — create the payment, redirect the customer to checkoutUrl
const payment = await checkout.start({
  amount: 4900, currency: 'PLN',
  description: 'Morning Vinyasa — booking YG-ABC12345',
  redirectUrl: `${origin}/confirmed?payment=done`,
  webhookUrl: `${origin}/api/webhooks/mollie`,
  metadata: { orderId },
});

// 2. settle — from the webhook AND the customer's return trip (same function)
export const POST = ({ request }) => checkout.handleWebhook(request);
await checkout.settle(paymentId); // e.g. on the confirmation page
```

`handleWebhook` answers 400 for junk and forged ids (stop retrying) and rethrows real failures so your route 500s and the provider retries.

> **SvelteKit caveat:** a plain `+server.ts` POST route is NOT enough on its
> own. Mollie posts `application/x-www-form-urlencoded` with no `Origin`
> header, and SvelteKit's built-in CSRF protection 403s exactly that shape —
> and it runs **before any handle hook**, so neither a hook nor
> `csrf.trustedOrigins` can exempt the route (`trustedOrigins` matches Origin
> values; an Origin-less request never passes it). The pattern that works in
> production: disable the built-in check in `svelte.config.js`
> (`csrf: { checkOrigin: false }`, or `trustedOrigins: ['*']` on newer Kit),
> then in `hooks.server.ts` handle the webhook path first and re-implement the
> origin check yourself for every other mutating request — otherwise every
> webhook delivery fails and Mollie keeps retrying.

## Subscriptions

Customers, mandates and recurring charges (Mollie: card mandates via a `sequenceType: 'first'` payment):

```ts
const customer = await provider.createCustomer({ email });
await provider.createPayment({ ...input, customerId: customer.id, sequenceType: 'first' });
// once paid, the mandate exists:
await provider.createSubscription({
  customerId: customer.id, amount: 4900, currency: 'PLN',
  interval: '1 month', description: 'Premium', startDate: nextMonth,
});
```

## Refunds

```ts
await provider.refund(paymentId, { amount: 4900, currency: 'PLN' });
```

## Embedded card fields

`MollieCard` wraps Mollie Components (PCI SAQ-A hosted iframes) as a Svelte 5 component, themeable via `--asini-*` custom properties:

```svelte
<script>
  import { MollieCard } from '@nomideusz/svelte-payments';
  let card;
</script>

<MollieCard bind:this={card} profileId="pfl_..." testmode locale="pl_PL" />
<button onclick={async () => submit(await card.createToken())}>Pay</button>
```

Pass the token as `cardToken` to `createPayment` — the customer skips the provider's method-selection page entirely (only 3-D Secure may still redirect).

## License

MIT
