import { WebhookProtocol } from './types';
import { stripeProtocol } from './webhooks/protocols/stripe';
import { gitHubProtocol } from './webhooks/protocols/github';
import { shopifyProtocol } from './webhooks/protocols/shopify';
import { slackProtocol } from './webhooks/protocols/slack';
import { svixProtocol } from './webhooks/protocols/svix';
import { genericHmacProtocol } from './webhooks/protocols/generic-hmac';

const protocolRegistry = new Map<string, WebhookProtocol>();

// Register default built-in protocols
protocolRegistry.set('stripe', stripeProtocol);
protocolRegistry.set('github', gitHubProtocol);
protocolRegistry.set('shopify', shopifyProtocol);
protocolRegistry.set('slack', slackProtocol);
protocolRegistry.set('svix', svixProtocol);
protocolRegistry.set('generic-hmac', genericHmacProtocol);

/**
 * Registers a global webhook protocol strategy.
 */
export function registerWebhookProtocol(name: string, protocol: WebhookProtocol): void {
  protocolRegistry.set(name.toLowerCase(), protocol);
}

/**
 * Retrieves a registered webhook protocol by name.
 */
export function getWebhookProtocol(name: string): WebhookProtocol | undefined {
  return protocolRegistry.get(name.toLowerCase());
}

/**
 * Clears custom registered protocols, resetting to built-ins (useful for test isolation).
 */
export function resetWebhookProtocols(): void {
  protocolRegistry.clear();
  protocolRegistry.set('stripe', stripeProtocol);
  protocolRegistry.set('github', gitHubProtocol);
  protocolRegistry.set('shopify', shopifyProtocol);
  protocolRegistry.set('slack', slackProtocol);
  protocolRegistry.set('svix', svixProtocol);
  protocolRegistry.set('generic-hmac', genericHmacProtocol);
}
