import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflowFile, resolveLocationInDocument } from '@siglo/ide-analysis';
import { sanitizeTelemetryDocument, matchTelemetryRecord, formatOriginCurl } from '@siglo/ide-protocol';
import { exploreCases } from '../engine/charter';

export async function runIdeTelemetryCharter(iterations = 15, seed = 1313) {
    const directory = await mkdtemp(join(tmpdir(), 'siglo-explore-ide-'));
    try {
        return await exploreCases(
            'Charter 13: IDE diagnostics and offline telemetry',
            iterations,
            seed,
            [],
            async (rng, iteration, record) => {
                const secret = `synthetic_secret_${rng.string(12)}`;
                for (const kind of ['http', 'crypto', 'notification', 'ai']) {
                    const raw = {
                        version: 1,
                        workflowName: 'checkout',
                        workflowVersion: '1',
                        stepIdentity: 'charge',
                        inspection: {
                            version: 1,
                            kind,
                            outcome: rng.pick(['success', 'failure']),
                            url: `https://user:${secret}@payments.example/private?token=${secret}`,
                            headers: { authorization: secret },
                            payload: secret,
                            signature: secret,
                            prompt: secret,
                            token: secret,
                            secret,
                        },
                    };
                    record({ input: raw, kind });
                    const malformed = [
                        null,
                        rng.jsonPayload(),
                        { ...raw, version: 99 },
                        { ...raw, workflowName: '' },
                        { ...raw, inspection: { ...raw.inspection, kind: 'unsupported' } },
                        { ...raw, inspection: { ...raw.inspection, outcome: 'unsupported' } },
                    ];
                    const document = sanitizeTelemetryDocument({ version: 1, records: [raw, ...malformed] });
                    assert.ok(document);
                    assert.equal(document.records.length, 1);
                    assert.equal(JSON.stringify(document).includes(secret), false);
                    const envelope = document.records[0];
                    assert.equal(matchTelemetryRecord(envelope, 'checkout', '1', 'charge'), true);
                    assert.equal(matchTelemetryRecord(envelope, 'checkout', '2', 'charge'), false);
                    assert.equal(matchTelemetryRecord(envelope, 'other', '1', 'charge'), false);
                    assert.equal(matchTelemetryRecord(envelope, 'checkout', '1', 'other'), false);
                    assert.equal(formatOriginCurl('POST', raw.inspection.url).includes(secret), false);
                    assert.equal(sanitizeTelemetryDocument({ version: 99, records: [raw] }), undefined);
                }
                const padding = '\n'.repeat(rng.nextInt(0, 8));
                const name = `charge_${iteration}`;
                const content = `${padding}import { Step, flow } from '@siglo/core';\nconst a = Step.create('${name}', () => ({}));\nconst b = Step.create('${name}', () => ({}));\nexport const checkout = flow(a, b);`;
                const uri = join(directory, 'workflow.ts');
                const before = parseWorkflowFile({ uri, content });
                assert.equal(before.diagnostics.filter(d => d.code === 'SIGLO_DUPLICATE_STEP_ID').length, 2);
                const edited = content.replace(
                    `const b = Step.create('${name}'`,
                    `const b = Step.create('unique_${iteration}'`,
                );
                const after = parseWorkflowFile({ uri, content: '\n' + edited, documentVersion: 2 });
                assert.equal(after.diagnostics.filter(d => d.code === 'SIGLO_DUPLICATE_STEP_ID').length, 0);
                const first = before.nodes.find(n => n.name === name)!;
                const moved = after.nodes.find(n => n.name === name)!;
                assert.ok(first?.location && moved?.location);
                assert.equal(moved.location.start.line, first.location.start.line + 1);
                assert.equal(resolveLocationInDocument(after, moved.location.start).nodeId, moved.id);

                await writeFile(
                    join(directory, 'factory.ts'),
                    `import { Step, flow } from '@siglo/core';\nthrow new Error('must never execute');\nexport function makeFlow() { return flow(Step.create('imported', () => ({}))); }`,
                );
                const imported = parseWorkflowFile({
                    uri,
                    content: `import { flow } from '@siglo/core';\nimport { makeFlow } from './factory';\nexport const checkout = flow(...makeFlow().steps);`,
                });
                assert.ok(imported.nodes.some(n => n.name === 'imported'));
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
