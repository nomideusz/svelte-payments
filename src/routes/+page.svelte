<script lang="ts">
	import { StripeConnectStatus } from '$lib/index.js';

	let connected = $state(false);
</script>

<svelte:head>
	<title>@nomideusz/svelte-payments — provider-agnostic payments for Svelte 5</title>
	<meta
		name="description"
		content="Provider-agnostic payments for Svelte 5 — Mollie server adapter, checkout orchestration with webhooks and refunds, Stripe Connect UI."
	/>
</svelte:head>

<main>
	<header>
		<h1>@nomideusz/svelte-payments</h1>
		<p class="lede">
			A payment provider behind one interface, plus the orchestration around it — start a payment,
			settle it from a webhook, refund it. Mollie is implemented server-side; the Stripe piece is
			currently the Connect onboarding UI.
		</p>
		<p class="install"><code>pnpm add @nomideusz/svelte-payments</code></p>
	</header>

	<section>
		<h2>StripeConnectStatus</h2>
		<p class="muted">
			Onboarding state for a provider's Stripe Connect account. Pure presentation — you supply the
			connected flag and the onboarding URL.
		</p>

		<label class="check">
			<input type="checkbox" bind:checked={connected} />
			connected
		</label>

		<div class="stage">
			<StripeConnectStatus {connected} onboardingHref="/api/stripe/connect" />
		</div>

		<pre><code>{`<StripeConnectStatus
  connected={account.chargesEnabled}
  onboardingHref="/api/stripe/connect"
  connectLabel="Connect with Stripe"
/>`}</code></pre>
	</section>

	<section>
		<h2>MollieCard</h2>
		<p class="muted">
			An embedded card form built on Mollie Components. It is not rendered here because it loads
			Mollie's SDK against a real <code>profileId</code>, and a demo profile would take live card
			input — not something to put on a public page.
		</p>
		<pre><code>{`<MollieCard
  profileId={PUBLIC_MOLLIE_PROFILE_ID}
  testmode={dev}
  locale="pl_PL"
  labels={{ cardNumber: 'Numer karty', cardHolder: 'Imię i nazwisko' }}
/>`}</code></pre>
	</section>

	<section>
		<h2>Server: checkout orchestration</h2>
		<p class="muted">
			<code>createCheckout</code> wraps any <code>PaymentProvider</code> with a store you supply, so
			persistence stays in your app. Import from the <code>/server</code> subpath — it never reaches
			the browser.
		</p>
		<pre><code>{`import { mollie, createCheckout } from '@nomideusz/svelte-payments/server';

const checkout = createCheckout(mollie(env.MOLLIE_API_KEY), {
  savePayment: (p) => db.update(payments).set(p).where(eq(payments.id, p.id)),
  onPaid:      (p) => confirmBooking(p.metadata.bookingId),
  onFailed:    (p) => releaseHold(p.metadata.bookingId),
});

// 1. Start — redirect the customer to payment.checkoutUrl
const payment = await checkout.start({
  amount: 12000, currency: 'PLN',
  description: 'Sunrise Hatha class',
  redirectUrl, webhookUrl,
  billingEmail: guest.email,   // methods that ask (Przelewy24) prefill it
  metadata: { bookingId },
});

// 2. Settle — from your webhook route
export const POST = ({ request }) => checkout.handleWebhook(request);

// 3. The settled Payment carries the payer's real name when the
//    method reports one (P24 consumerName, card holder) — backfill
//    guest records created from an e-mail alone:
onPaid: async (p) => {
  if (p.consumerName) await adoptRealName(p.metadata.bookingId, p.consumerName);
}`}</code></pre>
		<p class="muted">
			The provider interface is small on purpose — <code>createPayment</code>,
			<code>getPayment</code>, <code>refund</code>, <code>webhookPaymentId</code> — so a second
			provider is a new adapter rather than a new integration.
		</p>
	</section>

	<footer>
		<a href="https://github.com/nomideusz/svelte-payments">GitHub</a>
		<a href="https://www.npmjs.com/package/@nomideusz/svelte-payments">npm</a>
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #fbfbfa;
		color: #1a1a1a;
		font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
		line-height: 1.6;
	}
	main {
		max-width: 52rem;
		margin: 0 auto;
		padding: 3rem 1.5rem 4rem;
	}
	h1 {
		font-size: 1.75rem;
		margin: 0 0 0.5rem;
		letter-spacing: -0.02em;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.4rem;
	}
	.lede {
		margin: 0 0 1rem;
		color: #4a4a4a;
	}
	.muted {
		color: #666;
		font-size: 0.92rem;
	}
	code {
		background: #f0efec;
		padding: 0.15em 0.4em;
		border-radius: 4px;
		font-size: 0.9em;
	}
	a {
		color: #1a1a1a;
	}
	section {
		margin-top: 2.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid #e6e4df;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.9rem;
		margin: 0.5rem 0 0.75rem;
	}
	.stage {
		background: #fff;
		border: 1px solid #e6e4df;
		border-radius: 10px;
		padding: 1.25rem;
		margin-bottom: 1rem;
	}
	pre {
		background: #1e1e1c;
		color: #eceae4;
		padding: 1rem 1.15rem;
		border-radius: 10px;
		overflow-x: auto;
		font-size: 0.82rem;
		line-height: 1.55;
	}
	pre code {
		background: none;
		padding: 0;
		font-size: inherit;
	}
	footer {
		margin-top: 3rem;
		padding-top: 1.25rem;
		border-top: 1px solid #e6e4df;
		display: flex;
		gap: 1.25rem;
		font-size: 0.9rem;
	}
	@media (prefers-color-scheme: dark) {
		:global(body) {
			background: #17171a;
			color: #e8e6e3;
		}
		a {
			color: #e8e6e3;
		}
		.stage {
			background: #1f1f23;
			border-color: #33333a;
		}
		.lede,
		.muted {
			color: #a8a5a0;
		}
		code {
			background: #2a2a30;
		}
		section,
		footer {
			border-color: #33333a;
		}
	}
</style>
