import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { stripe, stripeConnect } from './stripe.js';
import { PaymentNotFoundError } from '../types.js';

const session = (over: Record<string, unknown> = {}) => ({
	id: 'cs_test_abc',
	status: 'open',
	payment_status: 'unpaid',
	amount_total: 120000,
	currency: 'pln',
	url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
	metadata: { courseId: '528' },
	customer: null,
	payment_intent: null,
	...over,
});

const stubFetch = (...bodies: unknown[]) => {
	const spy = vi.spyOn(globalThis, 'fetch');
	for (const body of bodies)
		spy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);
	return spy;
};
const sent = (spy: ReturnType<typeof stubFetch>, i = 0) => new URLSearchParams(spy.mock.calls[i][1]!.body as string);

afterEach(() => vi.restoreAllMocks());

describe('stripe adapter', () => {
	it('creates a Checkout Session: line item in minor units, one landing page, normalized back', async () => {
		const spy = stubFetch(session());
		const p = await stripe('sk_test').createPayment({
			amount: 120000,
			currency: 'PLN',
			description: 'Kurs nauczycielski',
			redirectUrl: 'https://x/return',
			locale: 'pl_PL',
			methods: ['blik', 'przelewy24'],
			metadata: { courseId: '528' },
		});
		const b = sent(spy);
		expect(b.get('line_items[0][price_data][unit_amount]')).toBe('120000');
		expect(b.get('line_items[0][price_data][currency]')).toBe('pln');
		expect(b.get('success_url')).toBe('https://x/return');
		expect(b.get('cancel_url')).toBe('https://x/return');
		expect(b.get('locale')).toBe('pl');
		expect(b.getAll('payment_method_types[0]').concat(b.getAll('payment_method_types[1]'))).toEqual(['blik', 'p24']);
		expect(b.has('payment_intent_data[on_behalf_of]')).toBe(false);
		expect(p).toMatchObject({ id: 'cs_test_abc', provider: 'stripe', status: 'pending', amount: 120000, currency: 'PLN', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
	});

	it('Connect: a direct charge on the school account, our fee on top, the id carries the account', async () => {
		const spy = stubFetch(session(), session({ status: 'complete', payment_status: 'paid' }));
		const p = stripe('sk_test');
		const pay = await p.createPayment({
			amount: 120000,
			currency: 'PLN',
			description: 'Kurs',
			redirectUrl: 'https://x/r',
			profileId: 'acct_school',
			applicationFee: { amount: 6000, description: 'szkolyjogi.pl' },
			idempotencyKey: 'order-1',
		});
		const b = sent(spy);
		const headers = spy.mock.calls[0][1]!.headers as Record<string, string>;
		expect(headers['Stripe-Account']).toBe('acct_school');
		expect(headers['Idempotency-Key']).toBe('order-1');
		expect(b.get('payment_intent_data[application_fee_amount]')).toBe('6000');
		expect(b.has('payment_intent_data[transfer_data][destination]')).toBe(false);
		expect(pay.id).toBe('acct_school:cs_test_abc');
		// Re-reading goes back to the school's account for the bare session id.
		expect((await p.getPayment(pay.id)).status).toBe('paid');
		expect(String(spy.mock.calls[1][0])).toContain('/checkout/sessions/cs_test_abc?');
		expect((spy.mock.calls[1][1]!.headers as Record<string, string>)['Stripe-Account']).toBe('acct_school');
	});

	it('refuses a fee without an account, a fee that eats the whole amount, and a non-acct profile', async () => {
		const base = { amount: 1000, currency: 'PLN', description: 'x', redirectUrl: 'https://x' };
		await expect(stripe('k').createPayment({ ...base, applicationFee: { amount: 100, description: '' } })).rejects.toThrow(/profileId/);
		await expect(stripe('k').createPayment({ ...base, profileId: 'acct_1', applicationFee: { amount: 1000, description: '' } })).rejects.toThrow(/below/);
		await expect(stripe('k').createPayment({ ...base, profileId: 'pfl_mollie' })).rejects.toThrow(/acct_/);
	});

	it.each([
		[{ status: 'complete', payment_status: 'paid' }, 'paid'],
		[{ status: 'expired' }, 'expired'],
		[{ status: 'open' }, 'pending'],
		[{ status: 'complete', payment_status: 'unpaid', payment_intent: { id: 'pi_1', status: 'processing' } }, 'pending'],
		[{ status: 'complete', payment_status: 'unpaid', payment_intent: { id: 'pi_1', status: 'requires_payment_method' } }, 'failed'],
		[{ status: 'open', payment_intent: { id: 'pi_1', status: 'canceled' } }, 'canceled'],
		[{ status: 'something_new', payment_status: 'weird' }, 'pending'],
	])('maps session %o → %s', async (over, status) => {
		stubFetch(session(over));
		expect((await stripe('k').getPayment('cs_test_abc')).status).toBe(status);
	});

	it('404 → PaymentNotFoundError (webhook handlers answer 4xx, not retry)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, text: async () => '' } as Response);
		await expect(stripe('k').getPayment('cs_test_gone')).rejects.toBeInstanceOf(PaymentNotFoundError);
	});

	it("refunds a school's payment from the school's balance, our fee back proportionally", async () => {
		const spy = stubFetch(
			session({ status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1', status: 'succeeded' } }),
			{ id: 're_1', amount: 50000, currency: 'pln', status: 'succeeded' },
		);
		const r = await stripe('k').refund('acct_school:cs_test_abc', { amount: 50000, currency: 'PLN', idempotencyKey: 'ref-1' });
		const b = sent(spy, 1);
		expect(b.get('payment_intent')).toBe('pi_1');
		expect(b.get('refund_application_fee')).toBe('true');
		expect((spy.mock.calls[1][1]!.headers as Record<string, string>)['Stripe-Account']).toBe('acct_school');
		expect(r).toEqual({ id: 're_1', paymentId: 'acct_school:cs_test_abc', amount: 50000, currency: 'PLN', status: 'refunded' });
	});

	it('refunds a platform payment without Connect parameters', async () => {
		const spy = stubFetch(
			session({ status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1', status: 'succeeded' } }),
			{ id: 're_1', amount: 1000, currency: 'pln', status: 'succeeded' },
		);
		await stripe('k').refund('cs_test_abc', { amount: 1000, currency: 'PLN' });
		expect(sent(spy, 1).has('refund_application_fee')).toBe(false);
		expect((spy.mock.calls[1][1]!.headers as Record<string, string>)['Stripe-Account']).toBeUndefined();
	});

	it('embedded: ui_mode custom, return_url only, expiry passed through, clientSecret while open', async () => {
		const now = 1_800_000_000;
		const spy = stubFetch(session({ url: null, client_secret: 'cs_secret' }), session({ status: 'complete', payment_status: 'paid', client_secret: 'cs_secret' }));
		const p = stripe('k', { now: () => now });
		const pay = await p.createPayment({
			amount: 5000,
			currency: 'PLN',
			description: 'Zajęcia',
			redirectUrl: 'https://x/return',
			embedded: true,
			expiresAt: new Date((now + 31 * 60) * 1000),
		});
		const b = sent(spy);
		expect(b.get('ui_mode')).toBe('custom');
		expect(b.get('return_url')).toBe('https://x/return');
		expect(b.has('success_url') || b.has('cancel_url')).toBe(false);
		expect(b.get('expires_at')).toBe(String(now + 31 * 60));
		expect(pay).toMatchObject({ clientSecret: 'cs_secret', checkoutUrl: undefined });
		// A finished session no longer hands out its secret.
		expect((await p.getPayment(pay.id)).clientSecret).toBeUndefined();
	});

	it('refuses an expiry Stripe would refuse (under 30 min, over 24 h)', async () => {
		const now = 1_800_000_000;
		const base = { amount: 1000, currency: 'PLN', description: 'x', redirectUrl: 'https://x' };
		const at = (s: number) => new Date((now + s) * 1000);
		await expect(stripe('k', { now: () => now }).createPayment({ ...base, expiresAt: at(10 * 60) })).rejects.toThrow(/expiresAt/);
		await expect(stripe('k', { now: () => now }).createPayment({ ...base, expiresAt: at(25 * 3600) })).rejects.toThrow(/expiresAt/);
	});

	it('expirePayment closes the session on its account and reports the state after', async () => {
		const spy = stubFetch(session({ status: 'expired' }), session({ status: 'expired' }));
		const r = await stripe('k').expirePayment!('acct_school:cs_test_abc');
		expect(String(spy.mock.calls[0][0])).toContain('/checkout/sessions/cs_test_abc/expire');
		expect((spy.mock.calls[0][1]!.headers as Record<string, string>)['Stripe-Account']).toBe('acct_school');
		expect(r.status).toBe('expired');
	});

	it('expirePayment on a session already paid: Stripe refuses, the re-read says paid', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		spy.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'not open' } as Response);
		spy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => session({ status: 'complete', payment_status: 'paid' }) } as Response);
		expect((await stripe('k').expirePayment!('cs_test_abc')).status).toBe('paid');
	});

	it('expirePayment that fails on a session still open throws: it can still be paid', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		spy.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'busy' } as Response);
		spy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => session({ status: 'open' }) } as Response);
		await expect(stripe('k').expirePayment!('cs_test_abc')).rejects.toThrow();
	});

	describe('stripeConnect', () => {
		it('creates a standard-style account: the school pays fees, Stripe collects requirements, full dashboard', async () => {
			const spy = stubFetch({ id: 'acct_new', charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['email'], past_due: ['tos_acceptance.date'] } });
			const a = await stripeConnect('k').createAccount({ email: 's@x.pl', businessName: 'Studio', metadata: { schoolId: 's1' }, idempotencyKey: 'connect:s1' });
			const b = sent(spy);
			expect(b.get('country')).toBe('PL');
			expect(b.get('controller[fees][payer]')).toBe('account');
			expect(b.get('controller[losses][payments]')).toBe('stripe');
			expect(b.get('controller[requirement_collection]')).toBe('stripe');
			expect(b.get('controller[stripe_dashboard][type]')).toBe('full');
			expect(b.get('business_profile[name]')).toBe('Studio');
			expect([...b.keys()].some((k) => k.startsWith('capabilities'))).toBe(false);
			expect((spy.mock.calls[0][1]!.headers as Record<string, string>)['Idempotency-Key']).toBe('connect:s1');
			expect(a).toEqual({ id: 'acct_new', chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, due: ['email', 'tos_acceptance.date'] });
		});

		it('onboarding link asks for everything at once; a non-acct id never reaches Stripe', async () => {
			const spy = stubFetch({ url: 'https://connect.stripe.com/setup/s/x' });
			const c = stripeConnect('k');
			expect(await c.onboardingLink('acct_1', { refreshUrl: 'https://p/r', returnUrl: 'https://p/b' })).toBe('https://connect.stripe.com/setup/s/x');
			expect(sent(spy).get('type')).toBe('account_onboarding');
			expect(sent(spy).get('collection_options[fields]')).toBe('eventually_due');
			await expect(c.getAccount('../balance')).rejects.toThrow(/acct_/);
			expect(spy).toHaveBeenCalledTimes(1);
		});
	});

	describe('webhookPaymentId', () => {
		const secret = 'whsec_test';
		const now = 1_800_000_000;
		const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_abc' } } });
		const signed = (b: string, t = now, s = secret) =>
			new Request('https://x/api/webhooks/stripe', {
				method: 'POST',
				body: b,
				headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', s).update(`${t}.${b}`).digest('hex')}` },
			});
		const provider = stripe('k', { webhookSecret: secret, now: () => now });

		it('accepts a correctly signed checkout event', async () => {
			expect(await provider.webhookPaymentId(signed(body))).toBe('cs_test_abc');
		});
		it('rejects a wrong secret, a stale timestamp, and a missing secret', async () => {
			expect(await provider.webhookPaymentId(signed(body, now, 'whsec_other'))).toBeNull();
			expect(await provider.webhookPaymentId(signed(body, now - 301))).toBeNull();
			expect(await stripe('k').webhookPaymentId(signed(body))).toBeNull();
		});
		it("a Connect event's id carries the school's account; either endpoint secret verifies", async () => {
			const connect = JSON.stringify({ type: 'checkout.session.completed', account: 'acct_school', data: { object: { id: 'cs_test_abc' } } });
			const both = stripe('k', { webhookSecret: ['whsec_platform', secret], now: () => now });
			expect(await both.webhookPaymentId(signed(connect))).toBe('acct_school:cs_test_abc');
			const forged = JSON.stringify({ type: 'checkout.session.completed', account: 'acct_x:cs_y', data: { object: { id: 'cs_test_abc' } } });
			expect(await both.webhookPaymentId(signed(forged))).toBeNull();
		});
		it('ignores events that are not about a checkout session', async () => {
			const other = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_1' } } });
			expect(await provider.webhookPaymentId(signed(other))).toBeNull();
		});
	});
});
