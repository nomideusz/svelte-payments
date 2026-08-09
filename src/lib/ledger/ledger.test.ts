import { describe, expect, it } from 'vitest';
import {
	chargebackKey,
	chargeKey,
	derivePaymentStatus,
	executeKeyedOperation,
	refundKey,
	type LedgerEvent,
	type LedgerStore,
} from './index.js';

const event = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
	eventKey: refundKey('bk_1', 2500),
	type: 'refund',
	subjectId: 'bk_1',
	paymentId: 'tr_x',
	amount: 2500,
	currency: 'PLN',
	...over,
});

/** In-memory store recording call order — the contract under test IS the ordering. */
function memStore(insertResult = true) {
	const calls: string[] = [];
	const store: LedgerStore = {
		async insert() {
			calls.push('insert');
			return insertResult;
		},
		async markCompleted(key, ref) {
			calls.push(`mark:${key}:${ref ?? ''}`);
		},
	};
	return { store, calls };
}

describe('eventKey grammar', () => {
	it('encodes the cumulative amount in refund keys', () => {
		expect(refundKey('bk_1', 2500)).toBe('refund:bk_1:2500');
		// A SECOND partial refund gets a new key; a RETRY of the first reuses it.
		expect(refundKey('bk_1', 5000)).not.toBe(refundKey('bk_1', 2500));
	});

	it('rejects non-integer / negative cumulative amounts (minor-units contract)', () => {
		expect(() => refundKey('bk_1', 25.5)).toThrow(/minor units/);
		expect(() => refundKey('bk_1', -1)).toThrow(/minor units/);
	});

	it('builds charge and chargeback keys', () => {
		expect(chargeKey('bk_1')).toBe('charge:bk_1');
		expect(chargebackKey('bk_1', 'chb_9')).toBe('chargeback:bk_1:chb_9');
	});
});

describe('executeKeyedOperation', () => {
	it('inserts BEFORE calling, passes the key as idempotency key, marks after', async () => {
		const { store, calls } = memStore();
		let seenKey = '';
		const res = await executeKeyedOperation(
			store,
			event(),
			async (key) => {
				calls.push('call');
				seenKey = key;
				return { id: 're_7' };
			},
			{ providerRef: (r) => r.id },
		);
		expect(res).toEqual({ status: 'executed', result: { id: 're_7' } });
		expect(seenKey).toBe('refund:bk_1:2500');
		expect(calls).toEqual(['insert', 'call', 'mark:refund:bk_1:2500:re_7']);
	});

	it('short-circuits on a duplicate key WITHOUT touching the provider', async () => {
		const { store, calls } = memStore(false);
		const res = await executeKeyedOperation(store, event(), async () => {
			calls.push('call');
			return null;
		});
		expect(res).toEqual({ status: 'duplicate' });
		expect(calls).toEqual(['insert']);
	});

	it('rethrows a provider failure and leaves the event un-marked', async () => {
		const { store, calls } = memStore();
		await expect(
			executeKeyedOperation(store, event(), async () => {
				throw new Error('mollie 500');
			}),
		).rejects.toThrow('mollie 500');
		expect(calls).toEqual(['insert']);
	});

	it('enforces the event contract before inserting', async () => {
		const { store, calls } = memStore();
		const call = async () => null;
		await expect(executeKeyedOperation(store, event({ amount: 0 }), call)).rejects.toThrow(
			/positive integer/,
		);
		await expect(executeKeyedOperation(store, event({ amount: 12.34 }), call)).rejects.toThrow(
			/positive integer/,
		);
		await expect(executeKeyedOperation(store, event({ eventKey: '' }), call)).rejects.toThrow(
			/eventKey/,
		);
		expect(calls).toEqual([]);
	});
});

describe('derivePaymentStatus', () => {
	it('walks paid → partially_refunded → refunded on cumulative minor units', () => {
		expect(derivePaymentStatus(10000, 0)).toBe('paid');
		expect(derivePaymentStatus(10000, 2500)).toBe('partially_refunded');
		expect(derivePaymentStatus(10000, 10000)).toBe('refunded');
		expect(derivePaymentStatus(10000, 12000)).toBe('refunded'); // over-refund clamps to terminal
	});

	it('rejects major units', () => {
		expect(() => derivePaymentStatus(100.5, 0)).toThrow(/minor units/);
		expect(() => derivePaymentStatus(10000, -1)).toThrow(/minor units/);
	});
});
