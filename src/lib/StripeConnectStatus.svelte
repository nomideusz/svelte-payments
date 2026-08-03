<script lang="ts">
  interface Props {
    /** Whether the guide's Stripe account is fully connected and active */
    connected: boolean;
    /** URL to redirect to for Stripe Connect onboarding — e.g. /api/stripe/connect */
    onboardingHref: string;
    /** Optional: label for the connect button */
    connectLabel?: string;
  }

  let {
    connected,
    onboardingHref,
    connectLabel = 'Connect with Stripe',
  }: Props = $props();
</script>

<div class="stripe-connect-status">
  {#if connected}
    <div class="status-connected">
      <span class="status-icon" aria-hidden="true">✓</span>
      <span>Your Stripe account is connected. You can receive payments.</span>
    </div>
  {:else}
    <p class="status-description">
      Connect your Stripe account to receive payments from guests.
      You'll be redirected to Stripe to complete the setup.
    </p>
    <a href={onboardingHref} class="connect-btn">
      {connectLabel}
    </a>
  {/if}
</div>

<style>
  .stripe-connect-status {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .status-connected {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--asini-radius, 0.5rem);
    background: color-mix(in srgb, var(--asini-success, #22c55e) 15%, transparent);
    color: var(--asini-text, inherit);
    border: 1px solid color-mix(in srgb, var(--asini-success, #22c55e) 40%, transparent);
  }

  .status-icon {
    font-size: 1.1rem;
    color: var(--asini-success, #22c55e);
    font-weight: bold;
  }

  .status-description {
    color: var(--asini-text-2, #6b7280);
    margin: 0;
    line-height: 1.5;
  }

  .connect-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem 1.25rem;
    border-radius: var(--asini-radius, 0.5rem);
    background: var(--asini-accent, #6366f1);
    color: #fff;
    text-decoration: none;
    font-weight: 500;
    font-size: 0.95rem;
    transition: opacity 0.15s;
    align-self: flex-start;
  }

  .connect-btn:hover {
    opacity: 0.88;
  }
</style>
