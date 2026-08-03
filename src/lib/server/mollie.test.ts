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
});
