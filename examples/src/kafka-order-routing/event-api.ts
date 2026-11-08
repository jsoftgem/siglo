import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Producer } from 'kafkajs';
import { publishScenario, scenarios } from './publish';

// This demo endpoint publishes through the worker's already connected producer.
export async function handlePublishEvent(
    request: IncomingMessage,
    response: ServerResponse,
    producer: Pick<Producer, 'send'>,
) {
    response.setHeader('Content-Type', 'application/json');
    const reply = (status: number, body: unknown) => {
        response.statusCode = status;
        response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reply(405, { error: 'Use POST /events' });
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let input: { scenario?: string; eventId?: string; orderId?: string };
    try {
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
            size += chunk.length;
            if (size > 16384) {
                request.resume();
                reply(413, { error: 'Request body must be at most 16 KiB' });
                return;
            }
            chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object');
        if (input.scenario !== undefined && !(scenarios as readonly unknown[]).includes(input.scenario)) {
            throw new Error(`scenario must be one of: ${scenarios.join(', ')}`);
        }
        for (const key of ['eventId', 'orderId'] as const) {
            if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
                throw new Error(`${key} must be a non-empty string`);
            }
        }
    } catch (error) {
        reply(400, { error: error instanceof Error ? error.message : String(error) });
        return;
    }
    try {
        reply(202, await publishScenario(producer, input.scenario, input.eventId, input.orderId));
    } catch (error) {
        reply(503, { error: `Kafka publication failed: ${String(error)}` });
    }
}
