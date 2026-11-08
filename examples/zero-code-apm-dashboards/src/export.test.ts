import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);

it('standalone scenarios flush OTLP spans and honor endpoint/header environment variables', async () => {
    const requests: { path?: string; auth?: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ path: req.url, auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
        for (const specificEndpoint of [false, true]) {
            requests.length = 0;
            await run(process.execPath, ['--import', 'tsx', resolve(__dirname, 'scenarios/2-retries.ts')], {
                env: {
                    ...process.env,
                    NODE_ENV: 'development',
                    OTEL_TRACES_EXPORTER: 'otlp',
                    OTEL_EXPORTER_OTLP_ENDPOINT: `${endpoint}/collector`,
                    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: specificEndpoint ? `${endpoint}/custom-traces` : '',
                    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20demo-token',
                    OTEL_EXPORTER_OTLP_TRACES_HEADERS: '',
                },
                timeout: 15000,
            });
            assert.ok(requests.length > 0, 'Scenario must export before exiting');
            assert.ok(
                requests.every(req => req.path === (specificEndpoint ? '/custom-traces' : '/collector/v1/traces')),
            );
            assert.ok(requests.every(req => req.auth === 'Bearer demo-token'));
            const spans = requests
                .flatMap(req => JSON.parse(req.body).resourceSpans)
                .flatMap(resource => resource.scopeSpans)
                .flatMap(scope => scope.spans);
            assert.ok(spans.some(span => span.name === 'workflow:ResilientPaymentWorkflow'));
            assert.equal(spans.filter(span => span.name.startsWith('step:chargeCreditCard')).length, 3);
        }
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
});
