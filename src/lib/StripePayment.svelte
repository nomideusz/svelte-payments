<!--
	Pay a Stripe Checkout Session ON the page — the Payment Element over a
	session created with `embedded: true` (ui_mode 'custom'). Card and BLIK
	finish here; methods that must leave (P24) come back to the session's
	return_url. Card data lives in Stripe's iframes (PCI SAQ-A). Client-only.

	{#key clientSecret}
		<StripePayment bind:this={pay} {publishableKey} {clientSecret} account="acct_…" locale="pl" />
	{/key}
	const r = await pay.confirm(); // { ok: true } | { ok: false, message }

	The iframe can't see host CSS, so the --asini-* tokens around it are
	resolved to concrete colors once, at mount; `appearance` overrides them.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		publishableKey: string;
		/** From the server's createPayment({ embedded: true }) → payment.clientSecret */
		clientSecret: string;
		/** Connect direct charge: the acct_… the session lives on */
		account?: string;
		/** 'pl', 'en', … or 'auto' */
		locale?: string;
		/** Stripe Appearance object, merged over the token-derived one */
		appearance?: Record<string, any>;
		/**
		 * Stripe's font set, for a family the iframe can't load from the host page:
		 * `{ cssSrc }` or `{ family, src: 'url(https://…)', weight?, unicodeRange? }`.
		 * A file on another origin must be served with CORS.
		 */
		fonts?: Record<string, string>[];
		/** 'tabs' (default) or 'accordion' */
		layout?: 'tabs' | 'accordion';
		/** The payer's name as already typed — a card's billing name starts from it */
		billingName?: string;
		onready?: () => void;
		/** Whether the entered details are complete enough to confirm */
		onchange?: (complete: boolean) => void;
		/** Stripe.js or the session failed to load */
		onerror?: (message: string) => void;
	}

	let { publishableKey, clientSecret, account, locale = 'auto', appearance, fonts, layout = 'tabs', billingName, onready, onchange, onerror }: Props = $props();

	const SRC = 'https://js.stripe.com/clover/stripe.js';
	let host: HTMLDivElement;
	let probe: HTMLSpanElement;
	let ready = $state(false);
	let actions: Promise<any> | undefined;

	function loadScript(): Promise<void> {
		if ((window as any).Stripe) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
			const script = existing ?? document.createElement('script');
			script.addEventListener('load', () => resolve());
			script.addEventListener('error', () => {
				// A tag that failed never fires again — the next mount must add a fresh one.
				script.remove();
				reject(new Error('Failed to load js.stripe.com'));
			});
			if (!existing) {
				script.src = SRC;
				document.head.appendChild(script);
			}
		});
	}

	/** The host's tokens as values Stripe's iframe accepts: rgb() colors, px radius. */
	function tokens(): Record<string, string> {
		const own = getComputedStyle(probe);
		const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
		const color = (token: string) => {
			if (!own.getPropertyValue(token).trim() || !ctx) return undefined;
			probe.style.color = `var(${token})`;
			// Computed colors may be oklch()/color(); the canvas flattens any of them to sRGB.
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = getComputedStyle(probe).color;
			ctx.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
			return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
		};
		const radius = (token: string) => {
			if (!own.getPropertyValue(token).trim()) return undefined;
			probe.style.borderTopLeftRadius = `var(${token})`;
			return getComputedStyle(probe).borderTopLeftRadius;
		};
		const out = {
			colorPrimary: color('--asini-accent'),
			colorBackground: color('--asini-surface'),
			colorText: color('--asini-text'),
			colorTextSecondary: color('--asini-text-2'),
			colorTextPlaceholder: color('--asini-text-3'),
			colorDanger: color('--asini-danger'),
			colorSuccess: color('--asini-success'),
			border: color('--asini-border'),
			borderRadius: radius('--asini-radius-sm') ?? radius('--asini-radius'),
			fontFamily: own.getPropertyValue('--asini-font-sans').trim() || undefined,
		};
		probe.removeAttribute('style');
		return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Record<string, string>;
	}

	onMount(() => {
		let cancelled = false;
		let element: any;
		loadScript()
			.then(() => {
				if (cancelled) return;
				const { border, ...variables } = tokens();
				const stripe = (window as any).Stripe(publishableKey, { ...(account ? { stripeAccount: account } : {}), locale });
				const checkout = stripe.initCheckoutElementsSdk({
					clientSecret,
					...(billingName ? { defaultValues: { billingAddress: { name: billingName } } } : {}),
					elementsOptions: {
						...(fonts ? { fonts } : {}),
						appearance: {
							theme: 'stripe',
							variables,
							rules: { '.Input': { boxShadow: 'none', ...(border ? { borderColor: border } : {}) }, '.Tab': { boxShadow: 'none', ...(border ? { borderColor: border } : {}) } },
							...appearance,
							...(appearance?.variables ? { variables: { ...variables, ...appearance.variables } } : {}),
						},
					},
				});
				actions = checkout.loadActions();
				element = checkout.createPaymentElement({ layout });
				element.on('ready', () => {
					ready = true;
					onready?.();
				});
				element.on('change', (e: { complete?: boolean }) => onchange?.(!!e.complete));
				element.on('loaderror', (e: { error?: { message?: string } }) => onerror?.(e.error?.message ?? 'Payment form failed to load'));
				element.mount(host);
			})
			.catch((e: Error) => onerror?.(e.message));
		return () => {
			cancelled = true;
			element?.destroy?.();
		};
	});

	/** Pay. Methods that must leave the page navigate away and never resolve here. */
	export async function confirm(): Promise<{ ok: true } | { ok: false; message: string }> {
		if (!actions) return { ok: false, message: 'Payment form is not ready yet' };
		const loaded = await actions;
		if (loaded.type !== 'success') return { ok: false, message: loaded.error?.message ?? 'Payment form failed to load' };
		const result = await loaded.actions.confirm({ redirect: 'if_required' });
		return result.type === 'success' ? { ok: true } : { ok: false, message: result.error?.message ?? 'Payment failed' };
	}
</script>

<div class="asini-stripe-payment" class:is-ready={ready} aria-busy={!ready}>
	<span class="asini-stripe-probe" bind:this={probe}></span>
	<div bind:this={host}></div>
</div>

<style>
	.asini-stripe-payment {
		min-height: 9rem;
		opacity: 0.4;
		transition: opacity 0.2s ease;
	}
	.asini-stripe-payment.is-ready {
		min-height: 0;
		opacity: 1;
	}
	.asini-stripe-probe {
		display: none;
	}
</style>
