// Stripe adapter — plain fetch against api.stripe.com, no SDK dependency.
// Server-only (holds the secret key): import from '@nomideusz/svelte-payments/server'.
//
// A "payment" here is a Checkout Session (cs_…): the hosted page that maps
// one-to-one onto the Mollie model this package was built around — create,
// redirect to `checkoutUrl`, re-fetch on the webhook. With `embedded` the same
// session is paid ON the page instead (ui_mode 'custom' — the Payment Element,
// see StripePayment.svelte): it hands back `clientSecret`, never a URL, and
// everything after creation (status, webhook, refunds) is unchanged.
//
// Connect = direct charges: `profileId` is the connected account (acct_…) and
// the session is created ON it (Stripe-Account header). The school is the
// merchant of record, the money lands in its balance, it pays Stripe's
// processing fee, and `applicationFee` is the platform's cut on top. Because
// the session lives on the school's account, its id carries the account:
// 'acct_…:cs_…'. Treat payment ids as opaque strings and this stays invisible.
//
// Stripe's webhook security model is a signature (Stripe-Signature, HMAC of
// the raw body). webhookPaymentId checks it, then hands back the session id;
// the status still comes from getPayment, never from the body.
import type {
	CreatePaymentInput,
	Payment,
	PaymentProvider,
	PaymentStatus,
	Refund,
	RefundStatus,
} from '../types.js';
import { PaymentNotFoundError } from '../types.js';

const API = 'https://api.stripe.com/v1';
// Pinned so response shapes do not move under us (same as thebest).
const VERSION = '2026-02-25.clover';
// Stripe's own default: a signature older than 5 minutes is a replay.
const TOLERANCE_S = 300;
// Checkout Session expires_at bounds (Stripe's): 30 minutes – 24 hours out.
// A minute of slack on each side, so a value computed a moment ago still fits.
const MIN_EXPIRY_S = 30 * 60 - 60;
const MAX_EXPIRY_S = 24 * 3600 + 60;

// The package's method names (Mollie's) → Stripe's payment_method_types.
const METHODS: Record<string, string> = { blik: 'blik', przelewy24: 'p24', creditcard: 'card' };
const REFUND_STATUS: Record<string, RefundStatus> = {
	pending: 'pending',
	requires_action: 'pending',
	succeeded: 'refunded',
	failed: 'failed',
	canceled: 'failed',
};

/** Stripe's bracket form encoding: {a: {b: [1]}} → a[b][0]=1. Undefined is dropped. */
export function formEncode(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		const key = prefix ? `${prefix}[${k}]` : k;
		if (typeof v === 'object') formEncode(v as Record<string, unknown>, key, out);
		else out.append(key, String(v));
	}
	return out;
}

/** Session + its expanded PaymentIntent → the package's status. Unknown = pending:
 *  an unrecognised state must never grant access. */
function statusOf(s: any): PaymentStatus {
	if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return 'paid';
	if (s.status === 'expired') return 'expired';
	const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
	if (pi?.status === 'canceled') return 'canceled';
	// Complete but unpaid = a delayed method that came back declined.
	if (s.status === 'complete' && pi?.status === 'requires_payment_method') return 'failed';
	return 'pending';
}

async function hmacHex(secret: string, payload: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 'acct_…:cs_…' → [account, session]; a bare 'cs_…' is a platform session. */
function splitId(id: string): [string | undefined, string] {
	const i = id.indexOf(':');
	return i < 0 ? [undefined, id] : [id.slice(0, i), id.slice(i + 1)];
}

function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export interface StripeOptions {
	/** The endpoint's signing secret (whsec_…). Without it webhookPaymentId
	 *  refuses every request — an unverified Stripe webhook is never trusted.
	 *  Pass both secrets when one URL serves the account endpoint (platform
	 *  payments) and the Connect endpoint (schools' payments). */
	webhookSecret?: string | string[];
	/** Injectable clock (seconds) for tests. */
	now?: () => number;
}

/** One authenticated Stripe request. A body makes it a POST; 404 is its own error. */
function caller(secretKey: string) {
	return async function call(path: string, body?: Record<string, unknown>, idempotencyKey?: string, account?: string): Promise<any> {
		const res = await fetch(`${API}${path}`, {
			method: body ? 'POST' : 'GET',
			headers: {
				Authorization: `Bearer ${secretKey}`,
				'Content-Type': 'application/x-www-form-urlencoded',
				'Stripe-Version': VERSION,
				...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
				...(account ? { 'Stripe-Account': account } : {}),
			},
			body: body ? formEncode(body).toString() : undefined,
		});
		if (res.status === 404) throw new PaymentNotFoundError(path);
		if (!res.ok) throw new Error(`stripe ${path} → ${res.status}: ${await res.text()}`);
		return res.json();
	};
}

export function stripe(secretKey: string, options: StripeOptions = {}): PaymentProvider {
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	const call = caller(secretKey);

	const session = (id: string) => {
		const [account, cs] = splitId(id);
		return call(`/checkout/sessions/${encodeURIComponent(cs)}?expand[]=payment_intent`, undefined, undefined, account);
	};

	const normalize = (s: any, account?: string): Payment => ({
		id: account ? `${account}:${s.id}` : s.id,
		provider: 'stripe',
		status: statusOf(s),
		amount: s.amount_total,
		currency: String(s.currency).toUpperCase(),
		checkoutUrl: s.url ?? undefined,
		// Only while it can still be paid — a finished session's secret is useless.
		clientSecret: s.status === 'open' ? (s.client_secret ?? undefined) : undefined,
		metadata: s.metadata && Object.keys(s.metadata).length ? s.metadata : undefined,
		customerId: (typeof s.customer === 'string' ? s.customer : s.customer?.id) ?? undefined,
		consumerName: s.customer_details?.name ?? undefined,
	});

	// ponytail: subscriptions stay on Mollie until premium moves — Stripe's model
	// (Products/Prices, Checkout mode 'subscription') is a different flow, built then.
	const noSubs = async (): Promise<never> => {
		throw new Error('stripe adapter: subscriptions are not implemented yet');
	};

	return {
		name: 'stripe',

		async createPayment(input: CreatePaymentInput) {
			if (!Number.isInteger(input.amount) || input.amount <= 0) {
				throw new Error(`amount must be a positive integer in minor units, got ${input.amount}`);
			}
			const fee = input.applicationFee?.amount;
			if (fee !== undefined && (!Number.isInteger(fee) || fee <= 0 || fee >= input.amount)) {
				throw new Error(`applicationFee.amount must be a positive integer below the amount, got ${fee}`);
			}
			if (fee !== undefined && !input.profileId) throw new Error('applicationFee needs profileId (the connected account)');
			if (input.cardToken) throw new Error('stripe adapter: cardToken is Mollie-only');
			if (input.sequenceType === 'recurring') throw new Error('stripe adapter: recurring charges are not implemented yet');
			if (input.profileId && !/^acct_\w+$/.test(input.profileId)) throw new Error(`profileId must be an acct_ id, got ${input.profileId}`);
			const expiresAt = input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : undefined;
			if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt - now() < MIN_EXPIRY_S || expiresAt - now() > MAX_EXPIRY_S)) {
				throw new Error(`expiresAt must be 30 min – 24 h from now, got ${input.expiresAt?.toISOString()}`);
			}
			const methods = input.methods?.map((m) => METHODS[m] ?? m);
			const lang = input.locale?.slice(0, 2);
			return normalize(
				await call(
					'/checkout/sessions',
					{
						mode: 'payment',
						line_items: [
							{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amount, product_data: { name: input.description } } },
						],
						// Embedded: paid on the page; return_url is only for methods that
						// must leave it. Hosted, Mollie semantics: one landing page for
						// every outcome — it checks the status.
						...(input.embedded
							? { ui_mode: 'custom', return_url: input.redirectUrl }
							: { success_url: input.redirectUrl, cancel_url: input.redirectUrl }),
						expires_at: expiresAt,
						locale: lang === 'pl' || lang === 'en' ? lang : 'auto',
						payment_method_types: methods, // omitted = the dashboard's choice
						customer: input.customerId,
						customer_email: input.customerId ? undefined : input.billingEmail,
						metadata: input.metadata,
						payment_intent_data: {
							description: input.description,
							metadata: input.metadata,
							setup_future_usage: input.sequenceType === 'first' ? 'off_session' : undefined,
							application_fee_amount: fee,
						},
					},
					input.idempotencyKey,
					input.profileId,
				),
				input.profileId,
			);
		},

		getPayment: async (id) => normalize(await session(id), splitId(id)[0]),

		async expirePayment(id) {
			const [account, cs] = splitId(id);
			let refused: unknown;
			try {
				await call(`/checkout/sessions/${encodeURIComponent(cs)}/expire`, {}, undefined, account);
			} catch (e) {
				if (e instanceof PaymentNotFoundError) throw e;
				refused = e;
			}
			// Stripe refuses to expire a session that is no longer open (paid, or
			// already expired) — the re-read says which. Still open = the close
			// failed (429, 5xx, network): it can still be paid, so say so.
			const s = await session(id);
			if (refused && s.status === 'open') throw refused;
			return normalize(s, account);
		},

		async refund(paymentId, opts) {
			if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
				throw new Error(`amount must be a positive integer in minor units, got ${opts.amount}`);
			}
			const pi = (await session(paymentId)).payment_intent;
			if (!pi?.id) throw new Error(`stripe refund: ${paymentId} has no payment`);
			// A school's payment: the refund comes out of the school's balance,
			// and our fee goes back to it proportionally.
			const account = splitId(paymentId)[0];
			const r = await call(
				'/refunds',
				{
					payment_intent: pi.id,
					amount: opts.amount,
					metadata: opts.description ? { description: opts.description } : undefined,
					refund_application_fee: account ? true : undefined,
				},
				opts.idempotencyKey,
				account,
			);
			return {
				id: r.id,
				paymentId,
				amount: r.amount,
				currency: String(r.currency).toUpperCase(),
				status: REFUND_STATUS[r.status] ?? 'pending',
			} satisfies Refund;
		},

		async createCustomer(input) {
			const c = await call('/customers', input);
			return { id: c.id };
		},

		createSubscription: noSubs,
		getSubscription: noSubs,
		cancelSubscription: noSubs,

		async webhookPaymentId(req) {
			const secrets = [options.webhookSecret ?? []].flat();
			if (!secrets.length) return null;
			const header = req.headers.get('stripe-signature') ?? '';
			const body = await req.text();
			const parts = header.split(',').map((p) => p.split('='));
			const t = Number(parts.find(([k]) => k === 't')?.[1]);
			const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
			if (!Number.isFinite(t) || !sigs.length || Math.abs(now() - t) > TOLERANCE_S) return null;
			const expected = await Promise.all(secrets.map((s) => hmacHex(s, `${t}.${body}`)));
			if (!sigs.some((s) => expected.some((e) => safeEqual(s, e)))) return null;
			let event: any;
			try {
				event = JSON.parse(body);
			} catch {
				return null;
			}
			// completed / async_payment_succeeded / async_payment_failed / expired —
			// every one means "re-read this session". Other events are not ours.
			// A Connect event names the school's account, which the id must carry.
			const id = event?.data?.object?.id;
			if (!String(event?.type).startsWith('checkout.session.') || !/^cs_\w+$/.test(id ?? '')) return null;
			if (event.account === undefined) return id;
			return /^acct_\w+$/.test(event.account) ? `${event.account}:${id}` : null;
		},
	};
}

export interface ConnectAccount {
	id: string;
	/** Can take payments — the only flag a checkout should look at. */
	chargesEnabled: boolean;
	payoutsEnabled: boolean;
	/** Onboarding was finished once (it may still owe something later). */
	detailsSubmitted: boolean;
	/** Requirements Stripe wants now; non-empty = send the owner back to onboarding. */
	due: string[];
}

/**
 * Connect onboarding for direct charges: the school's own Stripe account (it
 * pays Stripe's fees, owns the full Dashboard, Stripe collects its
 * requirements and carries payment losses — what Stripe calls a standard
 * account), created by the platform and onboarded on Stripe's hosted pages.
 * The platform never collects KYC itself. Server-only.
 */
export function stripeConnect(secretKey: string) {
	const call = caller(secretKey);
	const view = (a: any): ConnectAccount => ({
		id: a.id,
		chargesEnabled: !!a.charges_enabled,
		payoutsEnabled: !!a.payouts_enabled,
		detailsSubmitted: !!a.details_submitted,
		due: [...(a.requirements?.currently_due ?? []), ...(a.requirements?.past_due ?? [])],
	});
	const acct = (id: string) => {
		if (!/^acct_\w+$/.test(id)) throw new Error(`not an acct_ id: ${id}`);
		return id;
	};
	return {
		/** A new connected account. Payment methods (card, BLIK, P24) follow
		 *  the account's own Dashboard settings once it is verified. */
		async createAccount(input: {
			email?: string;
			/** ISO 3166-1 alpha-2, default 'PL' */
			country?: string;
			businessName?: string;
			metadata?: Record<string, string>;
			idempotencyKey?: string;
		}): Promise<ConnectAccount> {
			return view(
				await call(
					'/accounts',
					{
						country: input.country ?? 'PL',
						email: input.email,
						business_profile: input.businessName ? { name: input.businessName } : undefined,
						controller: {
							fees: { payer: 'account' },
							losses: { payments: 'stripe' },
							requirement_collection: 'stripe',
							stripe_dashboard: { type: 'full' },
						},
						metadata: input.metadata,
					},
					input.idempotencyKey,
				),
			);
		},

		/** A one-time onboarding URL (Stripe's hosted pages). It lives minutes
		 *  and opens once — `refreshUrl` must mint a fresh one, never reuse. */
		async onboardingLink(account: string, urls: { refreshUrl: string; returnUrl: string }): Promise<string> {
			const link = await call('/account_links', {
				account: acct(account),
				type: 'account_onboarding',
				refresh_url: urls.refreshUrl,
				return_url: urls.returnUrl,
				// Everything up front — one visit instead of a second one later.
				collection_options: { fields: 'eventually_due' },
			});
			return link.url;
		},

		/** The account's live state. Throws PaymentNotFoundError for an unknown id. */
		async getAccount(account: string): Promise<ConnectAccount> {
			return view(await call(`/accounts/${acct(account)}`));
		},
	};
}
