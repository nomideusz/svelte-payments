// Provider-agnostic checkout orchestration — the state machine between
// "customer wants to pay" and "the app reacted to the outcome".
//
// The store is the app's seam: persist payment state and react to terminal
// transitions. The same settle() runs from the provider webhook AND from a
// return-trip/poll re-fetch (dev has no reachable webhook), so every store
// callback MUST be idempotent — onPaid can fire more than once for one payment.
import type { CreatePaymentInput, Payment, PaymentProvider } from '../types.js';
import { PaymentNotFoundError } from '../types.js';

export interface CheckoutStore {
	/** Persist the payment's current state (insert or update). Idempotent. */
	savePayment(payment: Payment): Promise<void>;
	/** Payment reached 'paid'. May fire more than once — guard within. */
	onPaid?(payment: Payment): Promise<void>;
	/** Payment reached a terminal non-paid state (failed/canceled/expired). */
	onFailed?(payment: Payment): Promise<void>;
}

export interface Checkout {
	/** Create the payment and persist it. Redirect the customer to checkoutUrl. */
	start(input: CreatePaymentInput): Promise<Payment>;
	/** Re-fetch the payment's authoritative status and run the store reactions. */
	settle(paymentId: string): Promise<Payment>;
	/**
	 * Full webhook handling: extract id → settle → appropriate HTTP response.
	 * 400 for malformed bodies and unknown payment ids (no retry),
	 * rethrows other errors so the route 500s and the provider retries.
	 */
	handleWebhook(request: Request): Promise<Response>;
}

const TERMINAL_FAILURES = new Set<Payment['status']>(['failed', 'canceled', 'expired']);

// ponytail: no open-session reuse yet (thebest reuses Stripe sessions per
// booking) — add a store.findOpenPayment hook when a consumer needs it.
export function createCheckout(provider: PaymentProvider, store: CheckoutStore): Checkout {
	async function settle(paymentId: string): Promise<Payment> {
		const payment = await provider.getPayment(paymentId);
		await store.savePayment(payment);
		if (payment.status === 'paid') await store.onPaid?.(payment);
		else if (TERMINAL_FAILURES.has(payment.status)) await store.onFailed?.(payment);
		return payment;
	}

	return {
		async start(input) {
			const payment = await provider.createPayment(input);
			await store.savePayment(payment);
			return payment;
		},

		settle,

		async handleWebhook(request) {
			const id = await provider.webhookPaymentId(request);
			if (!id) return new Response('ignored', { status: 400 });
			try {
				await settle(id);
			} catch (e) {
				// Forged/unknown id → tell the provider to stop retrying.
				if (e instanceof PaymentNotFoundError) {
					return new Response('unknown payment', { status: 400 });
				}
				throw e;
			}
			return new Response('ok');
		},
	};
}
