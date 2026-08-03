import { describe, expect, it, vi } from 'vitest';
import { createCheckout } from './checkout.js';
import { PaymentNotFoundError } from '../types.js';
import type { Payment, PaymentProvider } from '../types.js';

const payment = (over: Partial<Payment> = {}): Payment => ({
	id: 'tr_1',
	provider: 'fake',
	status: 'pending',
	amount: 4900,
	currency: 'PLN',
	checkoutUrl: 'https://pay.example/tr_1',
	...over,
});

function fakeProvider(over: Partial<PaymentProvider> = {}): PaymentProvider {
	return {
		name: 'fake',
		createPayment: vi.fn(async () => payment()),
		getPayment: vi.fn(async () => payment({ status: 'paid' })),
		refund: vi.fn(),
		createCustomer: vi.fn(),
		createSubscription: vi.fn(),
		getSubscription: vi.fn(),
		cancelSubscription: vi.fn(),
		webhookPaymentId: vi.fn(async () => 'tr_1'),
		...over,
	} as PaymentProvider;
}

const makeStore = () => ({
	savePayment: vi.fn(async () => {}),
	onPaid: vi.fn(async () => {}),
	onFailed: vi.fn(async () => {}),
});

describe('createCheckout', () => {
	it('start creates and persists the payment', async () => {
		const store = makeStore();
		const p = await createCheckout(fakeProvider(), store).start({
			amount: 4900,
			currency: 'PLN',
			description: 'x',
			redirectUrl: 'https://x/r',
		});
		expect(p.checkoutUrl).toBeDefined();
		expect(store.savePayment).toHaveBeenCalledWith(p);
	});

	it('settle persists and routes paid → onPaid, terminal failures → onFailed', async () => {
		for (const [status, paid, failed] of [
			['paid', 1, 0],
			['failed', 0, 1],
			['canceled', 0, 1],
			['expired', 0, 1],
			['pending', 0, 0],
		] as const) {
			const store = makeStore();
			const provider = fakeProvider({ getPayment: async () => payment({ status }) });
			await createCheckout(provider, store).settle('tr_1');
			expect(store.savePayment).toHaveBeenCalledOnce();
			expect(store.onPaid).toHaveBeenCalledTimes(paid);
			expect(store.onFailed).toHaveBeenCalledTimes(failed);
		}
	});

	it('handleWebhook: ok / malformed / unknown id / provider outage', async () => {
		const store = makeStore();
		const checkout = createCheckout(fakeProvider(), store);
		expect((await checkout.handleWebhook(new Request('https://x', { method: 'POST' }))).status).toBe(200);

		const malformed = createCheckout(fakeProvider({ webhookPaymentId: async () => null }), store);
		expect((await malformed.handleWebhook(new Request('https://x', { method: 'POST' }))).status).toBe(400);

		const unknown = createCheckout(
			fakeProvider({ getPayment: async () => { throw new PaymentNotFoundError('tr_1'); } }),
			store,
		);
		expect((await unknown.handleWebhook(new Request('https://x', { method: 'POST' }))).status).toBe(400);

		const outage = createCheckout(
			fakeProvider({ getPayment: async () => { throw new Error('mollie down'); } }),
			store,
		);
		await expect(outage.handleWebhook(new Request('https://x', { method: 'POST' }))).rejects.toThrow('mollie down');
	});
});
