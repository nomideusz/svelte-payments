import { describe, expect, it, vi, afterEach } from 'vitest';
import { mollie } from './mollie.js';

const molliePayment = (over: Record<string, unknown> = {}) => ({
	id: 'tr_abc123',
	status: 'open',
	amount: { currency: 'PLN', value: '49.00' },
	metadata: { bookingId: 'b1' },
	_links: { checkout: { href: 'https://pay.mollie.com/checkout/tr_abc123' } },
	...over,
});

const stubFetch = (body: unknown, ok = true, status = 200) =>
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response);

afterEach(() => vi.restoreAllMocks());

describe('mollie adapter', () => {
	it('creates a payment: minor units → "49.00", normalized result back to minor units', async () => {
		const fetchSpy = stubFetch(molliePayment());
		const p = await mollie('key').createPayment({
			amount: 4900,
			currency: 'PLN',
			description: 'Yoga class',
			redirectUrl: 'https://x/return',
			methods: ['blik'],
		});

		const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(sent.amount).toEqual({ currency: 'PLN', value: '49.00' });
		expect(sent.method).toEqual(['blik']);
		expect(p).toMatchObject({
			id: 'tr_abc123',
			provider: 'mollie',
			status: 'pending',
			amount: 4900,
			currency: 'PLN',
			checkoutUrl: 'https://pay.mollie.com/checkout/tr_abc123',
		});
	});

	it('forwards billingEmail and surfaces the payer name from method details', async () => {
		const fetchSpy = stubFetch(
			molliePayment({ status: 'paid', details: { consumerName: 'Anna Kowalska' } }),
		);
		const p = await mollie('key').createPayment({
			amount: 4900,
			currency: 'PLN',
			description: 'Yoga class',
			redirectUrl: 'https://x/return',
			billingEmail: 'anna@example.com',
		});
		const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(sent.billingEmail).toBe('anna@example.com');
		expect(p.consumerName).toBe('Anna Kowalska');
		vi.restoreAllMocks();

		// Card payments report cardHolder instead; absent details stay undefined.
		stubFetch(molliePayment({ details: { cardHolder: 'A. Kowalska' } }));
		expect((await mollie('k').getPayment('tr_abc123')).consumerName).toBe('A. Kowalska');
		vi.restoreAllMocks();
		stubFetch(molliePayment());
		expect((await mollie('k').getPayment('tr_abc123')).consumerName).toBeUndefined();
	});

	it('rejects non-integer and non-positive amounts', async () => {
		await expect(
			mollie('key').createPayment({
				amount: 49.5,
				currency: 'PLN',
				description: 'x',
				redirectUrl: 'https://x',
			}),
		).rejects.toThrow(/minor units/);
	});

	it('maps every Mollie status; unknown falls back to pending', async () => {
		const cases: Record<string, string> = {
			open: 'pending',
			pending: 'pending',
			authorized: 'pending',
			paid: 'paid',
			failed: 'failed',
			canceled: 'canceled',
			expired: 'expired',
			something_new: 'pending',
		};
		for (const [mollieStatus, ours] of Object.entries(cases)) {
			stubFetch(molliePayment({ status: mollieStatus }));
			expect((await mollie('key').getPayment('tr_abc123')).status).toBe(ours);
			vi.restoreAllMocks();
		}
	});

	it('throws on API errors; 404 becomes PaymentNotFoundError', async () => {
		stubFetch({ detail: 'nope' }, false, 401);
		await expect(mollie('bad').getPayment('tr_x')).rejects.toThrow(/401/);
		vi.restoreAllMocks();
		stubFetch({ detail: 'gone' }, false, 404);
		await expect(mollie('k').getPayment('tr_x')).rejects.toMatchObject({
			name: 'PaymentNotFoundError',
		});
	});

	it('refunds: minor units → value, statuses map, rejects bad amounts', async () => {
		const fetchSpy = stubFetch({
			id: 're_1',
			status: 'queued',
			amount: { currency: 'PLN', value: '20.00' },
		});
		const r = await mollie('k').refund('tr_1', { amount: 2000, currency: 'PLN' });
		expect(fetchSpy.mock.calls[0][0]).toContain('/payments/tr_1/refunds');
		const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(sent.amount).toEqual({ currency: 'PLN', value: '20.00' });
		expect(r).toMatchObject({ id: 're_1', paymentId: 'tr_1', amount: 2000, status: 'pending' });

		await expect(mollie('k').refund('tr_1', { amount: 20.5, currency: 'PLN' })).rejects.toThrow(
			/minor units/,
		);
	});

	it('creates a subscription: minor units → "49.00", customer id in path, normalized back', async () => {
		const fetchSpy = stubFetch({
			id: 'sub_x1',
			customerId: 'cst_a',
			status: 'active',
			amount: { currency: 'PLN', value: '49.00' },
			interval: '1 month',
			nextPaymentDate: '2026-08-29',
		});
		const s = await mollie('key').createSubscription({
			customerId: 'cst_a',
			amount: 4900,
			currency: 'PLN',
			interval: '1 month',
			description: 'Premium',
			startDate: '2026-08-29',
		});

		expect(fetchSpy.mock.calls[0][0]).toContain('/customers/cst_a/subscriptions');
		const sent = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
		expect(sent.amount).toEqual({ currency: 'PLN', value: '49.00' });
		expect(sent.customerId).toBeUndefined(); // in the path, not the body
		expect(sent.startDate).toBe('2026-08-29');
		expect(s).toMatchObject({ id: 'sub_x1', status: 'active', amount: 4900, nextPaymentDate: '2026-08-29' });
	});

	it('unknown subscription status never reads as active', async () => {
		stubFetch({ id: 'sub_x1', customerId: 'cst_a', status: 'brand_new_state', amount: { currency: 'PLN', value: '49.00' }, interval: '1 month' });
		expect((await mollie('key').getSubscription('cst_a', 'sub_x1')).status).toBe('pending');
	});

	it('cancels a subscription via DELETE', async () => {
		const fetchSpy = stubFetch({ id: 'sub_x1', customerId: 'cst_a', status: 'canceled', amount: { currency: 'PLN', value: '49.00' }, interval: '1 month' });
		const s = await mollie('key').cancelSubscription('cst_a', 'sub_x1');
		expect(fetchSpy.mock.calls[0][1]!.method).toBe('DELETE');
		expect(s.status).toBe('canceled');
	});

	it('extracts webhook payment id, rejects garbage', async () => {
		const provider = mollie('key');
		const req = (body: string) =>
			new Request('https://x/webhook', { method: 'POST', body });
		expect(await provider.webhookPaymentId(req('id=tr_abc123'))).toBe('tr_abc123');
		expect(await provider.webhookPaymentId(req('id=DROP TABLE'))).toBeNull();
		expect(await provider.webhookPaymentId(req(''))).toBeNull();
	});

	it('sends Idempotency-Key on createPayment/refund/createSubscription when given, never otherwise', async () => {
		const header = (spy: ReturnType<typeof stubFetch>, call = 0) =>
			(spy.mock.calls[call][1]!.headers as Record<string, string>)['Idempotency-Key'];

		let spy = stubFetch(molliePayment());
		await mollie('k').createPayment({
			amount: 4900, currency: 'PLN', description: 'x', redirectUrl: 'https://x',
			idempotencyKey: 'charge:b1',
		});
		expect(header(spy)).toBe('charge:b1');
		const sentPayment = JSON.parse(spy.mock.calls[0][1]!.body as string);
		expect(sentPayment.idempotencyKey).toBeUndefined(); // header, not body
		vi.restoreAllMocks();

		spy = stubFetch({ id: 're_1', status: 'queued', amount: { currency: 'PLN', value: '20.00' } });
		await mollie('k').refund('tr_1', { amount: 2000, currency: 'PLN', idempotencyKey: 'refund:b1:2000' });
		expect(header(spy)).toBe('refund:b1:2000');
		vi.restoreAllMocks();

		spy = stubFetch({ id: 'sub_1', customerId: 'cst_a', status: 'active', amount: { currency: 'PLN', value: '49.00' }, interval: '1 month' });
		await mollie('k').createSubscription({
			customerId: 'cst_a', amount: 4900, currency: 'PLN', interval: '1 month', description: 'p',
			idempotencyKey: 'sub:pass1',
		});
		expect(header(spy)).toBe('sub:pass1');
		const sentSub = JSON.parse(spy.mock.calls[0][1]!.body as string);
		expect(sentSub.idempotencyKey).toBeUndefined();
		vi.restoreAllMocks();

		spy = stubFetch(molliePayment());
		await mollie('k').createPayment({ amount: 4900, currency: 'PLN', description: 'x', redirectUrl: 'https://x' });
		expect(header(spy)).toBeUndefined();
	});

	it('Connect readiness: profileId and applicationFee flow into the payment body', async () => {
		const spy = stubFetch(molliePayment());
		await mollie('org-token').createPayment({
			amount: 4900, currency: 'PLN', description: 'x', redirectUrl: 'https://x',
			profileId: 'pfl_abc',
			applicationFee: { amount: 250, description: 'platform fee' },
		});
		const sent = JSON.parse(spy.mock.calls[0][1]!.body as string);
		expect(sent.profileId).toBe('pfl_abc');
		expect(sent.applicationFee).toEqual({
			amount: { currency: 'PLN', value: '2.50' },
			description: 'platform fee',
		});

		await expect(
			mollie('k').createPayment({
				amount: 4900, currency: 'PLN', description: 'x', redirectUrl: 'https://x',
				applicationFee: { amount: 2.5, description: 'bad' },
			}),
		).rejects.toThrow(/minor units/);
	});

	it('testmode: true lands in POST bodies and as ?testmode=true on reads', async () => {
		const provider = mollie('org-token', { testmode: true });

		let spy = stubFetch(molliePayment());
		await provider.createPayment({ amount: 100, currency: 'PLN', description: 'x', redirectUrl: 'https://x' });
		expect(JSON.parse(spy.mock.calls[0][1]!.body as string).testmode).toBe(true);
		vi.restoreAllMocks();

		spy = stubFetch(molliePayment());
		await provider.getPayment('tr_abc123');
		expect(spy.mock.calls[0][0]).toContain('/payments/tr_abc123?testmode=true');
		vi.restoreAllMocks();

		spy = stubFetch({ _embedded: { payments: [] } });
		await provider.listCustomerPayments!('cst_a');
		expect(spy.mock.calls[0][0]).toContain('/payments?limit=20&testmode=true'); // query merge
		vi.restoreAllMocks();

		// Cancel-subscription takes testmode as a BODY parameter, not query.
		spy = stubFetch({ id: 'sub_x1', customerId: 'cst_a', status: 'canceled', amount: { currency: 'PLN', value: '49.00' }, interval: '1 month' });
		await provider.cancelSubscription('cst_a', 'sub_x1');
		expect(spy.mock.calls[0][0]).not.toContain('testmode');
		expect(JSON.parse(spy.mock.calls[0][1]!.body as string)).toEqual({ testmode: true });
		vi.restoreAllMocks();

		// Without the option nothing changes anywhere.
		spy = stubFetch(molliePayment());
		await mollie('k').getPayment('tr_abc123');
		expect(spy.mock.calls[0][0]).not.toContain('testmode');
		spy = stubFetch(molliePayment());
		await mollie('k').createPayment({ amount: 100, currency: 'PLN', description: 'x', redirectUrl: 'https://x' });
		expect(JSON.parse(spy.mock.calls[1][1]!.body as string).testmode).toBeUndefined();
	});
});
