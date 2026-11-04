import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { captureInspection, InspectionCapturePolicy } from './capture';
import { sanitizeInspection } from './inspection';

describe('bounded opt-in inspection content', () => {
  const policy: InspectionCapturePolicy = { fields: ['prompt', 'requestHeaders', 'requestBody'], maxBytes: 7, redact: (_, value) => value };
  it('defaults to no capture and fails closed on invalid policies, redactors and values', () => {
    assert.deepEqual(captureInspection(undefined, 'prompt', 'secret'), {});
    assert.deepEqual(captureInspection(policy, 'output', 'secret'), {});
    for (const override of [{ maxBytes: 0 }, { maxBytes: NaN }, { redact: undefined }, { redact: () => { throw new Error('secret'); } }, { redact: () => undefined }]) {
      assert.deepEqual(captureInspection({ ...policy, ...override } as any, 'prompt', 'secret'), {});
    }
  });
  it('bounds complete UTF-8 code points and does not let redactors mutate execution input', () => {
    const capture = captureInspection(policy, 'prompt', '😀😀😀');
    assert.equal(capture.prompt?.text, '😀');
    assert.equal(capture.prompt?.truncated, true);
    const input = { value: 'original', secret: 'private' };
    captureInspection({ ...policy, redact: (_, value: any) => { value.value = 'changed'; return value; } }, 'requestBody', input);
    assert.equal(input.value, 'original');
  });
  it('redacts credentials, omits URLs and allowlists header names again at ingestion', () => {
    const data: any = sanitizeInspection({ version: 1, kind: 'http', outcome: 'success', content: {
      requestBody: { text: JSON.stringify({ secret: 'private', url: 'https://example.test/private?token=private', ok: true }), truncated: false },
      requestHeaders: { text: JSON.stringify({ Authorization: 'private', 'X-API-Key': 'private', 'Content-Type': 'application/json' }), truncated: false },
      prompt: { text: 'wrong-kind', truncated: false },
    } });
    assert.equal(JSON.stringify(data).includes('private'), false);
    assert.equal(data.content.prompt, undefined);
    assert.ok(data.content.requestHeaders.text.includes('application/json'));
    assert.equal(sanitizeInspection({ version: 1, kind: 'crypto', outcome: 'success', content: data.content })?.content, undefined);
    const large = sanitizeInspection({ version: 1, kind: 'ai', outcome: 'success', content: { output: { text: '😀'.repeat(2000), truncated: false } } });
    assert.ok(Buffer.byteLength(large!.content!.output!.text) <= 4096);
    assert.equal(large?.truncated, true);
  });
});
