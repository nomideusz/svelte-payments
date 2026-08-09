/**
 * Financial-event ledger primitives — a PURE subpath: no DB, no SDK, no env.
 *
 * The division of labour (see the 2026-08-09 package audit, P3):
 * - this module owns the event vocabulary, the eventKey grammar, the
 *   integer-minor-units contract, and the insert → provider-call-with-key →
 *   mark ordering that makes a keyed provider call replay-safe;
 * - the APP owns the table schema, the SDK calls, the duplicate-recovery
 *   policy (what to do when a key already exists), and all domain math
 *   (payout targets, fees, refund percentages).
 *
 * The vocabulary is provider-neutral (charge / refund / chargeback).
 * Marketplace shapes (transfers, reversals, payout status) are deliberately
 * NOT here — extend in the app that needs them.
 *
 * Amounts are ALWAYS integer minor units (grosze/cents). Never major units.
 */

export type LedgerEventType = 'charge' | 'refund' | 'chargeback';

export interface LedgerEvent {
	/** Unique, deterministic key — doubles as the provider Idempotency-Key. */
	eventKey: string;
	type: LedgerEventType;
	/** Domain subject the money belongs to (booking / order id). */
	subjectId: string;
	/** Provider payment id the money moves against. */
	paymentId: string;
	/** Integer minor units, > 0. */
	amount: number;
	/** ISO 4217, e.g. 'PLN'. */
	currency: string;
	/** Connect: provider account / profile the event belongs to. */
	providerAccount?: string;
}

/**
 * Append-only store the app implements over its own DB. `insert` MUST be
 * atomic on eventKey (e.g. INSERT … ON CONFLICT DO NOTHING) and return false
 * when the key already exists — that is the whole double-spend defence.
 */
export interface LedgerStore {
	insert(event: LedgerEvent): Promise<boolean>;
	/** Stamp the event completed, optionally with the provider's own id. */
	markCompleted(eventKey: string, providerRef?: string): Promise<void>;
}

// ─── eventKey grammar ───────────────────────────────────────────────────────
//
// Refund keys encode the CUMULATIVE refunded amount after this refund, so a
// second partial refund of the same subject gets a different key (a retry of
// the first one does not): refund:<subjectId>:<cumulativeMinorAfter>.

/** One charge per subject. */
export function chargeKey(subjectId: string): string {
	return `charge:${subjectId}`;
}

/** Cumulative-amount refund grammar — see module comment. */
export function refundKey(subjectId: string, cumulativeMinorAfter: number): string {
	assertMinorUnits(cumulativeMinorAfter, 'cumulativeMinorAfter');
	return `refund:${subjectId}:${cumulativeMinorAfter}`;
}

/** Chargebacks are provider-initiated — key on the provider's chargeback id. */
export function chargebackKey(subjectId: string, providerChargebackId: string): string {
	return `chargeback:${subjectId}:${providerChargebackId}`;
}

// ─── Keyed operation ────────────────────────────────────────────────────────

export type KeyedOperationResult<T> =
	| { status: 'executed'; result: T }
	| { status: 'duplicate' };

/**
 * The one safe ordering for a keyed money movement:
 *
 *   1. append the event row (atomic on eventKey) — the claim;
 *   2. call the provider WITH the eventKey as Idempotency-Key;
 *   3. mark the event completed.
 *
 * Returns `{ status: 'duplicate' }` without calling the provider when the key
 * already exists — a previous attempt got at least as far as step 1, and what
 * to do next (re-call with the same key, verify at the provider, alert a
 * human) is the app's duplicate-recovery policy, not this module's.
 *
 * A provider failure in step 2 rethrows and leaves the row un-marked; whether
 * to delete the row (retry starts fresh) or keep it (retry goes through the
 * recovery path) is, again, the app's policy.
 */
export async function executeKeyedOperation<T>(
	store: LedgerStore,
	event: LedgerEvent,
	call: (idempotencyKey: string) => Promise<T>,
	opts?: { providerRef?: (result: T) => string | undefined },
): Promise<KeyedOperationResult<T>> {
	validateEvent(event);
	const fresh = await store.insert(event);
	if (!fresh) return { status: 'duplicate' };
	const result = await call(event.eventKey);
	await store.markCompleted(event.eventKey, opts?.providerRef?.(result));
	return { status: 'executed', result };
}

// ─── Pure derivations ───────────────────────────────────────────────────────

/** Payment status from cumulative refunds — integer minor units. */
export function derivePaymentStatus(
	totalMinor: number,
	refundedMinor: number,
): 'paid' | 'partially_refunded' | 'refunded' {
	assertMinorUnits(totalMinor, 'totalMinor');
	assertMinorUnits(refundedMinor, 'refundedMinor');
	if (refundedMinor === 0) return 'paid';
	if (refundedMinor >= totalMinor) return 'refunded';
	return 'partially_refunded';
}

// ─── Contract enforcement ───────────────────────────────────────────────────

function assertMinorUnits(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(
			`${name} must be a non-negative integer in minor units, got ${value} — never pass major units here`,
		);
	}
}

function validateEvent(event: LedgerEvent): void {
	if (!event.eventKey) throw new TypeError('LedgerEvent.eventKey is required');
	if (!event.subjectId) throw new TypeError('LedgerEvent.subjectId is required');
	if (!event.paymentId) throw new TypeError('LedgerEvent.paymentId is required');
	if (!Number.isInteger(event.amount) || event.amount <= 0) {
		throw new TypeError(
			`LedgerEvent.amount must be a positive integer in minor units, got ${event.amount}`,
		);
	}
	if (!event.currency) throw new TypeError('LedgerEvent.currency is required');
}
