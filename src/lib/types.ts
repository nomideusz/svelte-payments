// Provider-agnostic payment types. The model is deliberately the simplest one
// that fits hosted-checkout PSPs (Mollie, and later Stripe Checkout): the
// server creates a payment, redirects the customer to `checkoutUrl`, and a
// webhook tells us to re-fetch the payment for its final status.
//
// Amounts are ALWAYS integer minor units (grosze/cents) — adapters convert to
// whatever their API wants. Never pass major units here.

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'expired';

export interface CreatePaymentInput {
	/** Integer minor units, e.g. 4900 = 49.00 PLN */
	amount: number;
	/** ISO 4217, e.g. 'PLN' */
	currency: string;
	/** Shown to the customer on the checkout page and bank statement */
	description: string;
	/** Where the customer lands after checkout (success AND failure — check status there) */
	redirectUrl: string;
	/** Publicly reachable endpoint the provider calls on status changes */
	webhookUrl?: string;
	/** Checkout page locale, e.g. 'pl_PL' */
	locale?: string;
	/** Restrict/preselect payment methods, e.g. ['blik', 'przelewy24'] */
	methods?: string[];
	/** Customer e-mail forwarded to the provider — methods that ask for one
	 *  (e.g. Przelewy24) prefill it instead of making the customer retype it,
	 *  which also stops the checkout collecting a DIFFERENT address than the
	 *  one the order was placed under. */
	billingEmail?: string;
	/** Round-trips back on the Payment — put your order/booking id here */
	metadata?: Record<string, string>;
	/** Provider customer id — required for sequenceType 'first' / 'recurring' */
	customerId?: string;
	/** Card token from an embedded card form (MollieCard component) — skips
	 *  Mollie's method-selection page; only 3-D Secure may still redirect */
	cardToken?: string;
	/** 'first' establishes a mandate for later recurring charges; default 'oneoff' */
	sequenceType?: 'oneoff' | 'first' | 'recurring';
	/** Sent as the provider's Idempotency-Key header: a retried call (timeout,
	 *  crash between DB claim and provider response) returns the SAME payment
	 *  instead of creating a second one. Pair it with a keyed row in your DB —
	 *  insert the key first, then call with it. */
	idempotencyKey?: string;
	/** Connect/OAuth: which profile the payment belongs to. Required when the
	 *  adapter authenticates with an organization-level OAuth token. */
	profileId?: string;
	/** Connect/OAuth: platform fee taken from this payment (integer minor units,
	 *  same currency as the payment). */
	applicationFee?: { amount: number; description: string };
}

export interface Payment {
	id: string;
	provider: string;
	status: PaymentStatus;
	/** Integer minor units */
	amount: number;
	currency: string;
	/** Present while the payment is still payable — redirect the customer here */
	checkoutUrl?: string;
	metadata?: Record<string, string>;
	customerId?: string;
	/** Set on charges spawned by a subscription */
	subscriptionId?: string;
	/** The payer's real name as reported by the payment method (Przelewy24
	 *  consumerName, card holder…). Only present once the method knows it —
	 *  use it to backfill guest records created from an e-mail alone. */
	consumerName?: string;
}

export interface Customer {
	id: string;
}

// Mollie's subscription lifecycle; 'suspended' = a charge failed, Mollie paused it.
export type SubscriptionStatus = 'pending' | 'active' | 'suspended' | 'canceled' | 'completed';

export interface CreateSubscriptionInput {
	customerId: string;
	/** Integer minor units per charge */
	amount: number;
	currency: string;
	/** e.g. '1 month', '3 months', '1 year' */
	interval: string;
	description: string;
	/** ISO date (YYYY-MM-DD) of the first charge; omit = charge immediately.
	 *  When the mandate came from a just-paid first payment, set this one
	 *  interval out or the customer is charged twice on day one. */
	startDate?: string;
	webhookUrl?: string;
	metadata?: Record<string, string>;
	/** Sent as the provider's Idempotency-Key header — a retried call returns
	 *  the SAME subscription instead of double-charging the mandate monthly.
	 *  The sharpest known failure without it: timeout → DB claim released →
	 *  retry → two live subscriptions. */
	idempotencyKey?: string;
	/** Connect/OAuth: which profile the subscription belongs to. */
	profileId?: string;
}

export interface Subscription {
	id: string;
	customerId: string;
	status: SubscriptionStatus;
	/** Integer minor units */
	amount: number;
	currency: string;
	interval: string;
	/** ISO date of the next scheduled charge, if any */
	nextPaymentDate?: string;
	metadata?: Record<string, string>;
}

export type RefundStatus = 'pending' | 'refunded' | 'failed';

export interface Refund {
	id: string;
	paymentId: string;
	/** Integer minor units */
	amount: number;
	currency: string;
	status: RefundStatus;
}

/**
 * Thrown by adapters when a payment id does not exist at the provider —
 * lets webhook handlers answer 4xx (don't retry) instead of 5xx (retry).
 */
export class PaymentNotFoundError extends Error {
	constructor(paymentId: string) {
		super(`Payment not found: ${paymentId}`);
		this.name = 'PaymentNotFoundError';
	}
}

export interface PaymentProvider {
	readonly name: string;
	createPayment(input: CreatePaymentInput): Promise<Payment>;
	getPayment(id: string): Promise<Payment>;
	/** Refund a paid payment, fully or partially. Amount in integer minor units.
	 *  `idempotencyKey` makes a retried call safe (see CreatePaymentInput). */
	refund(
		paymentId: string,
		opts: { amount: number; currency: string; description?: string; idempotencyKey?: string },
	): Promise<Refund>;
	createCustomer(input: { name?: string; email?: string; metadata?: Record<string, string> }): Promise<Customer>;
	createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
	getSubscription(customerId: string, id: string): Promise<Subscription>;
	/**
	 * Recent payments of a customer, newest first. Optional — used for
	 * webhook-loss reconciliation (find renewal charges that never notified).
	 */
	listCustomerPayments?(customerId: string): Promise<Payment[]>;
	cancelSubscription(customerId: string, id: string): Promise<Subscription>;
	/**
	 * Extract the payment id from an incoming webhook request, or null if the
	 * request isn't a valid webhook. Webhook bodies are UNTRUSTED — never take
	 * a status from them; call getPayment(id) and trust only that.
	 */
	webhookPaymentId(req: Request): Promise<string | null>;
}
