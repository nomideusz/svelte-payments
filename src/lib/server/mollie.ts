// Mollie adapter — plain fetch against api.mollie.com, no SDK dependency.
// Server-only (holds the API key): import from '@nomideusz/svelte-payments/server'.
//
// Mollie's webhook security model: the webhook body carries only a payment id,
// and you re-fetch the payment over the authenticated API for the real status.
// There is no signature to verify — the API round-trip IS the verification.
import type {
	CreatePaymentInput,
	Payment,
	PaymentProvider,
	PaymentStatus,
	Refund,
	RefundStatus,
	Subscription,
	SubscriptionStatus,
} from '../types.js';
import { PaymentNotFoundError } from '../types.js';

const API = 'https://api.mollie.com/v2';

// https://docs.mollie.com/docs/status-changes — 'authorized' means a card hold
// awaiting capture; from the customer's perspective it's still in flight.
const STATUS: Record<string, PaymentStatus> = {
	open: 'pending',
	pending: 'pending',
	authorized: 'pending',
	paid: 'paid',
	failed: 'failed',
	canceled: 'canceled',
	expired: 'expired',
};

// ponytail: assumes 2-decimal currencies (PLN/EUR/GBP…); add a decimals map if a
// zero-decimal currency (JPY/ISK) ever shows up.
const toValue = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (value: string) => Math.round(Number(value) * 100);

export interface MollieOptions {
	/** OAuth (Connect) tokens span live+test and require an explicit testmode on
	 *  every call — POST bodies get `testmode: true`, reads get `?testmode=true`.
	 *  Irrelevant for plain test_/live_ API keys (the key decides the mode). */
	testmode?: boolean;
}

export function mollie(apiKey: string, options: MollieOptions = {}): PaymentProvider {
	const { testmode } = options;
	// Mode flag placement per Mollie's API: request body for mutations
	// (POST *and* DELETE — cancel-subscription takes it as a body parameter),
	// query string for reads.
	const modeBody = testmode ? { testmode: true } : {};
	const q = (path: string) =>
		testmode ? `${path}${path.includes('?') ? '&' : '?'}testmode=true` : path;

	async function call(path: string, init?: RequestInit, idempotencyKey?: string): Promise<any> {
		const res = await fetch(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				// A retried mutating call with the same key returns the original
				// result instead of acting twice.
				...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
			},
		});
		if (res.status === 404) throw new PaymentNotFoundError(path);
		if (!res.ok) throw new Error(`mollie ${path} → ${res.status}: ${await res.text()}`);
		return res.json();
	}

	const normalize = (p: any): Payment => ({
		id: p.id,
		provider: 'mollie',
		status: STATUS[p.status] ?? 'pending', // unknown status must never grant access
		amount: toMinor(p.amount.value),
		currency: p.amount.currency,
		checkoutUrl: p._links?.checkout?.href,
		metadata: p.metadata ?? undefined,
		customerId: p.customerId ?? undefined,
		subscriptionId: p.subscriptionId ?? undefined,
		// Method-dependent field names: P24/bank transfers report consumerName,
		// card payments cardHolder. Absent until the method learns it.
		consumerName: p.details?.consumerName ?? p.details?.cardHolder ?? undefined,
	});

	const SUB_STATUSES: SubscriptionStatus[] = ['pending', 'active', 'suspended', 'canceled', 'completed'];
	const normalizeSub = (s: any): Subscription => ({
		id: s.id,
		customerId: s.customerId,
		// unknown status must never read as 'active'
		status: SUB_STATUSES.includes(s.status) ? s.status : 'pending',
		amount: toMinor(s.amount.value),
		currency: s.amount.currency,
		interval: s.interval,
		nextPaymentDate: s.nextPaymentDate ?? undefined,
		metadata: s.metadata ?? undefined,
	});

	return {
		name: 'mollie',

		async createPayment(input: CreatePaymentInput) {
			if (!Number.isInteger(input.amount) || input.amount <= 0) {
				throw new Error(`amount must be a positive integer in minor units, got ${input.amount}`);
			}
			if (input.applicationFee && (!Number.isInteger(input.applicationFee.amount) || input.applicationFee.amount <= 0)) {
				throw new Error(`applicationFee.amount must be a positive integer in minor units, got ${input.applicationFee.amount}`);
			}
			return normalize(
				await call(
					'/payments',
					{
						method: 'POST',
						body: JSON.stringify({
							amount: { currency: input.currency, value: toValue(input.amount) },
							description: input.description,
							redirectUrl: input.redirectUrl,
							webhookUrl: input.webhookUrl,
							locale: input.locale,
							method: input.methods,
							metadata: input.metadata,
							customerId: input.customerId,
							sequenceType: input.sequenceType,
							cardToken: input.cardToken,
							billingEmail: input.billingEmail,
							profileId: input.profileId,
							...(input.applicationFee
								? {
										applicationFee: {
											amount: {
												currency: input.currency,
												value: toValue(input.applicationFee.amount),
											},
											description: input.applicationFee.description,
										},
									}
								: {}),
							...modeBody,
						}),
					},
					input.idempotencyKey,
				),
			);
		},

		getPayment: async (id) => normalize(await call(q(`/payments/${encodeURIComponent(id)}`))),

		async refund(paymentId, opts) {
			if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
				throw new Error(`amount must be a positive integer in minor units, got ${opts.amount}`);
			}
			// https://docs.mollie.com/docs/status-changes-refunds
			const REFUND_STATUS: Record<string, RefundStatus> = {
				queued: 'pending',
				pending: 'pending',
				processing: 'pending',
				refunded: 'refunded',
				failed: 'failed',
			};
			const r = await call(
				`/payments/${encodeURIComponent(paymentId)}/refunds`,
				{
					method: 'POST',
					body: JSON.stringify({
						amount: { currency: opts.currency, value: toValue(opts.amount) },
						description: opts.description,
						...modeBody,
					}),
				},
				opts.idempotencyKey,
			);
			return {
				id: r.id,
				paymentId,
				amount: toMinor(r.amount.value),
				currency: r.amount.currency,
				status: REFUND_STATUS[r.status] ?? 'pending',
			} satisfies Refund;
		},

		async createCustomer(input) {
			const c = await call('/customers', {
				method: 'POST',
				body: JSON.stringify({ ...input, ...modeBody }),
			});
			return { id: c.id };
		},

		async createSubscription(input) {
			if (!Number.isInteger(input.amount) || input.amount <= 0) {
				throw new Error(`amount must be a positive integer in minor units, got ${input.amount}`);
			}
			const { customerId, amount, currency, idempotencyKey, ...rest } = input;
			return normalizeSub(
				await call(
					`/customers/${encodeURIComponent(customerId)}/subscriptions`,
					{
						method: 'POST',
						body: JSON.stringify({
							...rest,
							amount: { currency, value: toValue(amount) },
							...modeBody,
						}),
					},
					idempotencyKey,
				),
			);
		},

		getSubscription: async (customerId, id) =>
			normalizeSub(
				await call(q(`/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(id)}`)),
			),

		async listCustomerPayments(customerId) {
			// Newest first (Mollie default ordering). One page is plenty for
			// reconciliation — renewals are monthly.
			const r = await call(q(`/customers/${encodeURIComponent(customerId)}/payments?limit=20`));
			return (r._embedded?.payments ?? []).map(normalize);
		},

		cancelSubscription: async (customerId, id) =>
			normalizeSub(
				await call(`/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(id)}`, {
					method: 'DELETE',
					...(testmode ? { body: JSON.stringify({ testmode: true }) } : {}),
				}),
			),

		async webhookPaymentId(req) {
			// Mollie POSTs application/x-www-form-urlencoded: id=tr_xxxxx
			const id = new URLSearchParams(await req.text()).get('id');
			return id && /^tr_\w+$/.test(id) ? id : null;
		},
	};
}
