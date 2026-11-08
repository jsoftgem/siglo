import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signRequest, windowSeconds } from './security';

async function main() {
    const scenario = process.argv[2] ?? 'standard';
    if (!['standard', 'gift', 'review', 'tamper', 'expired', 'replay'].includes(scenario))
        throw new Error('Unknown scenario');
    const body = Buffer.from(
        JSON.stringify({
            eventId: randomUUID(),
            orderId: randomUUID(),
            type: 'order.placed',
            amountCents: scenario === 'review' ? 120000 : 5000,
            giftWrap: scenario === 'gift',
        }),
    );
    const key = readFileSync(resolve(__dirname, '../../signed-order-intake/.local/client-private.pem'), 'utf8');
    const request = signRequest(body, key, {
        nonce: randomUUID(),
        created: Math.floor(Date.now() / 1000) - (scenario === 'expired' ? windowSeconds + 60 : 0),
    });
    const url = `${process.env.SIGNED_ORDER_URL ?? 'http://127.0.0.1:3400'}${request.target}`;
    for (let i = 0; i < (scenario === 'replay' ? 2 : 1); i++) {
        const response = await fetch(url, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            signal: AbortSignal.timeout(10000),
            body: scenario === 'tamper' ? Buffer.from(body.toString().replace('5000', '5001')) : body,
        });
        console.log(response.status, await response.text());
        const stackId = response.headers.get('x-workflow-stack-id');
        if (stackId) console.log(`HTTP intake run: ${stackId} (select this run in the live monitor)`);
        const expected = scenario === 'tamper' || scenario === 'expired' || i === 1 ? 401 : 202;
        if (response.status !== expected) throw new Error(`Expected ${expected}`);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
