import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
    flow,
    Step,
    toPOJO,
    validateAndPinTarget,
    NetworkPolicyViolationException,
    networkPolicyStorage,
} from '@siglo/core';
import { sigloExpressMiddleware } from '@siglo/express';
import { exploreCases } from '../engine/charter';

export async function runSecurityBoundariesCharter(iterations = 15, seed = 1414) {
    const server = createServer((req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
            res.end();
        } else {
            res.end('allowed');
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
        return await exploreCases(
            'Charter 14: Concurrent security boundaries',
            iterations,
            seed,
            [1],
            async (rng, i, record) => {
                const value = rng.string(8);
                const hostile = JSON.parse(
                    `{"__proto__":{"canary":"${value}"},"constructor":{"prototype":{"canary":"${value}"}},"prototype":{"canary":"${value}"},"safe":"${value}"}`,
                );
                record({ input: hostile });
                const clean = await flow(
                    Step.create(`sanitize_${i}`, async (ctx: any) => ({ observed: toPOJO(ctx) })),
                ).run(hostile, { pojo: true });
                assert.equal((Object.prototype as any).canary, undefined);
                for (const key of ['__proto__', 'constructor', 'prototype'])
                    assert.equal(Object.hasOwn(clean.observed, key), false);
                assert.equal(clean.observed.safe, value);

                const policy = {
                    enabled: true,
                    defaultPolicy: 'deny' as const,
                    allowedHosts: ['payments.example'],
                    allowLocalhost: false,
                };
                const publicIp = '93.184.216.34';
                assert.deepEqual(
                    await validateAndPinTarget(new URL('https://payments.example'), policy, async () => [
                        { address: publicIp, family: 4 },
                    ]),
                    [publicIp],
                );
                const privateIp = rng.pick(['169.254.169.254', '10.0.0.1', '127.0.0.1']);
                record({ dns: [publicIp, privateIp] });
                await assert.rejects(
                    validateAndPinTarget(new URL('https://payments.example'), policy, async () => [
                        { address: publicIp, family: 4 },
                        { address: privateIp, family: 4 },
                    ]),
                    NetworkPolicyViolationException,
                );

                const url = `http://127.0.0.1:${port}`;
                const allowedPolicy = { allowedHosts: [`127.0.0.1:${port}`], allowLocalhost: true };
                const allowed = flow(
                    Step.create(`allow_${i}`, async () => {
                        await new Promise(resolve => setTimeout(resolve, rng.nextInt(1, 3)));
                        assert.equal(networkPolicyStorage.getStore()?.allowLocalhost, true);
                        return { body: await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text() };
                    }).networkPolicy(allowedPolicy),
                );
                const denied = flow(
                    Step.create(`deny_${i}`, async () => {
                        await new Promise(resolve => setTimeout(resolve, 1));
                        assert.equal(networkPolicyStorage.getStore()?.allowLocalhost, false);
                        await fetch(url, { signal: AbortSignal.timeout(2000) });
                        return {};
                    }).networkPolicy({ defaultPolicy: 'deny', allowLocalhost: false }),
                );
                const outcomes = await Promise.allSettled([allowed.run({}, { pojo: true }), denied.run()]);
                assert.equal(outcomes[0].status, 'fulfilled');
                if (outcomes[0].status === 'fulfilled') assert.equal(outcomes[0].value.body, 'allowed');
                assert.equal(outcomes[1].status, 'rejected');
                if (outcomes[1].status === 'rejected')
                    assert.ok(outcomes[1].reason instanceof NetworkPolicyViolationException);
                const redirect = flow(
                    Step.create(`redirect_${i}`, async () => {
                        await fetch(`${url}/redirect`, { signal: AbortSignal.timeout(2000) });
                        return {};
                    }).networkPolicy(allowedPolicy),
                );
                await assert.rejects(redirect.run(), NetworkPolicyViolationException);

                let durable: unknown;
                const capture = {
                    run: async (_input: unknown, options: { durable?: boolean }) => {
                        durable = options.durable;
                        return {};
                    },
                };
                const response = { json: () => undefined };
                for (const req of [
                    { headers: { 'x-durable': 'true' } },
                    { query: { durable: 'true' } },
                    { body: { durable: true } },
                ]) {
                    await sigloExpressMiddleware(capture as any)(req, response, () => {});
                    assert.equal(durable, undefined);
                    await sigloExpressMiddleware(capture as any, { allowClientDurableToggle: true })(
                        req,
                        response,
                        () => {},
                    );
                    assert.equal(durable, true);
                }
            },
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
}
