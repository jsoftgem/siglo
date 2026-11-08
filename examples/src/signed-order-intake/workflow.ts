import { flow, Step } from '@siglo/core';
import { verifyWebhookStep, type WebhookDedupStore } from '@siglo/crypto';
import { createRequestProtocol, RequestError, resolveClient, type ClientKey, type SignedRequest } from './security';

export interface OrderEvent {
    eventId: string;
    orderId: string;
    type: 'order.placed';
    amountCents: number;
    giftWrap: boolean;
    tenant: string;
}
export function createIntakeWorkflow(
    keys: ReadonlyMap<string, ClientKey>,
    nonces: WebhookDedupStore,
    publish: (event: OrderEvent) => Promise<void>,
    now = () => Date.now(),
) {
    const authenticate = verifyWebhookStep('verifyOrderSignature', {
        provider: (request: SignedRequest) => createRequestProtocol(request, resolveClient(request, keys), nonces, now),
        secret: (request: SignedRequest) => resolveClient(request, keys).publicKey,
        payload: (request: SignedRequest) => request.rawBody,
        signature: (request: SignedRequest) => request.headers,
        maxBodyBytes: 65536,
        // The custom protocol owns timestamp validation and post-verification nonce claims.
    });
    const validate = Step.create('validateOrder', async (request: SignedRequest) => {
        let body;
        try {
            body = JSON.parse(request.rawBody.toString('utf8'));
        } catch {
            throw new RequestError(400, 'Invalid order JSON');
        }
        const id = /^[A-Za-z0-9_-]{1,80}$/;
        if (
            !body ||
            typeof body.eventId !== 'string' ||
            typeof body.orderId !== 'string' ||
            !id.test(body.eventId) ||
            !id.test(body.orderId) ||
            body.type !== 'order.placed' ||
            !Number.isSafeInteger(body.amountCents) ||
            body.amountCents <= 0 ||
            (body.giftWrap !== undefined && typeof body.giftWrap !== 'boolean')
        ) {
            throw new RequestError(400, 'Invalid order');
        }
        const event: OrderEvent = {
            eventId: body.eventId,
            orderId: body.orderId,
            type: 'order.placed',
            amountCents: body.amountCents,
            giftWrap: body.giftWrap ?? false,
            tenant: resolveClient(request, keys).clientId,
        };
        return { event };
    });
    const publishOrder = Step.create('publishOrder', async ({ event }: { event: OrderEvent }) => {
        await publish(event);
        return { receipt: { eventId: event.eventId, orderId: event.orderId, status: 'accepted' } };
    });
    return flow(authenticate, validate, publishOrder);
}
