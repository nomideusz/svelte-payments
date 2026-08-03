<!--
	Embedded card form via Mollie Components (PCI SAQ-A: card data lives in
	Mollie-hosted iframes, never in your DOM). Client-only.

	<MollieCard bind:this={card} profileId="pfl_..." testmode />
	const token = await card.createToken(); // pass as cardToken to createPayment

	Wrapper chrome uses --asini-* tokens; the iframe internals can't see host
	CSS variables, so pass concrete colors via the `styles` prop (Mollie styles
	object: https://docs.mollie.com/docs/styling-mollie-components).
-->
<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		profileId: string;
		testmode?: boolean;
		/** Checkout locale, e.g. 'pl_PL' */
		locale?: string;
		/** Mollie Components styles object, forwarded to every field */
		styles?: Record<string, unknown>;
		labels?: { cardNumber?: string; cardHolder?: string; expiryDate?: string; verificationCode?: string };
	}

	let { profileId, testmode = false, locale, styles, labels }: Props = $props();

	const text = $derived({
		cardNumber: labels?.cardNumber ?? 'Card number',
		cardHolder: labels?.cardHolder ?? 'Name on card',
		expiryDate: labels?.expiryDate ?? 'Expiry date',
		verificationCode: labels?.verificationCode ?? 'CVC',
	});

	const FIELDS = ['cardNumber', 'cardHolder', 'expiryDate', 'verificationCode'] as const;
	let errors = $state<Record<string, string>>({});
	let ready = $state(false);
	let mollie: any;

	function loadScript(): Promise<void> {
		if ((window as any).Mollie) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const existing = document.querySelector<HTMLScriptElement>('script[src^="https://js.mollie.com/"]');
			const script = existing ?? document.createElement('script');
			script.addEventListener('load', () => resolve());
			script.addEventListener('error', () => reject(new Error('Failed to load js.mollie.com')));
			if (!existing) {
				script.src = 'https://js.mollie.com/v1/mollie.js';
				document.head.appendChild(script);
			}
		});
	}

	onMount(() => {
		const components: any[] = [];
		let cancelled = false;
		loadScript().then(() => {
			if (cancelled) return;
			mollie = (window as any).Mollie(profileId, { locale, testmode });
			for (const name of FIELDS) {
				const component = mollie.createComponent(name, styles ? { styles } : undefined);
				component.mount(`#mollie-${name}`);
				component.addEventListener('change', (event: { error?: string; touched?: boolean }) => {
					errors[name] = event.error && event.touched ? event.error : '';
				});
				components.push(component);
			}
			ready = true;
		});
		return () => {
			cancelled = true;
			components.forEach((c) => c.unmount());
		};
	});

	/** Tokenize the entered card. Throws with Mollie's message if invalid. */
	export async function createToken(): Promise<string> {
		if (!mollie) throw new Error('Mollie Components not ready yet');
		const { token, error } = await mollie.createToken();
		if (error) throw new Error(error.message ?? 'Card tokenization failed');
		return token;
	}
</script>

<div class="mollie-card" class:is-ready={ready}>
	{#each FIELDS as name (name)}
		<div class="mollie-field-wrap" data-field={name}>
			<label class="mollie-label" for="mollie-{name}">{text[name]}</label>
			<div class="mollie-field" id="mollie-{name}"></div>
			{#if errors[name]}<p class="mollie-error" role="alert">{errors[name]}</p>{/if}
		</div>
	{/each}
</div>

<style>
	.mollie-card {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.875rem;
		opacity: 0.4;
		transition: opacity 0.2s ease;
	}
	.mollie-card.is-ready {
		opacity: 1;
	}
	.mollie-field-wrap[data-field='cardNumber'],
	.mollie-field-wrap[data-field='cardHolder'] {
		grid-column: 1 / -1;
	}
	.mollie-label {
		display: block;
		margin-bottom: 0.375rem;
		font-size: var(--asini-label-size, 0.75rem);
		color: var(--asini-text-2, #6b7280);
	}
	.mollie-field {
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--asini-border, #d1d5db);
		border-radius: var(--asini-radius, 0.375rem);
		background: var(--asini-surface, #fff);
		transition: border-color 0.15s ease;
	}
	.mollie-field:focus-within {
		border-color: var(--asini-accent, #6366f1);
	}
	.mollie-error {
		margin: 0.25rem 0 0;
		font-size: 0.75rem;
		color: var(--asini-danger, #dc2626);
	}
</style>
