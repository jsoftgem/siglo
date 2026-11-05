/** Scriptable ecosystem generators. Values are serialized, never interpolated as code. */
export type GenerateStepOptions =
  | { type?: 'generic' }
  | { type: 'http'; url: string }
  | { type: 'crypto'; provider: 'stripe' | 'github' | 'shopify' | 'slack' | 'svix' | 'generic-hmac' }
  | { type: 'ai'; provider: 'openai' | 'anthropic' | 'gemini' | 'ollama'; model: string }
  | { type: 'notification'; channel: 'email' | 'slack' | 'discord' | 'sms' | 'push'; interactive?: boolean };

export function validateStepOptions(name: string, options: GenerateStepOptions): void {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(name)) throw new Error('Step name must be a TypeScript identifier or kebab-case name');
  const o = options as any;
  const keys: Record<string, string[]> = { generic: ['type'], http: ['type', 'url'], crypto: ['type', 'provider'], ai: ['type', 'provider', 'model'], notification: ['type', 'channel', 'interactive'] };
  const type = o.type ?? 'generic';
  if (!keys[type]) throw new Error(`Unsupported step type: ${type}`);
  if (Object.keys(o).some(k => !keys[type].includes(k))) throw new Error('Unsupported option for step type');
  if (type === 'http') {
    let url: URL;
    try { url = new URL(o.url); } catch { throw new Error('HTTP requires an absolute URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('HTTP URL must use http(s), without credentials or fragment');
  }
  if (type === 'crypto' && !['stripe', 'github', 'shopify', 'slack', 'svix', 'generic-hmac'].includes(o.provider)) throw new Error('Unsupported webhook provider');
  if (type === 'ai' && (!['openai', 'anthropic', 'gemini', 'ollama'].includes(o.provider) || typeof o.model !== 'string' || !o.model.trim())) throw new Error('AI requires a supported provider and model');
  if (type === 'notification') {
    if (!['email', 'slack', 'discord', 'sms', 'push'].includes(o.channel)) throw new Error('Unsupported notification channel');
    if (o.interactive !== undefined && typeof o.interactive !== 'boolean') throw new Error('interactive must be true or false');
    if (o.interactive && !['email', 'slack'].includes(o.channel)) throw new Error('Approval supports email or slack');
  }
}

const literal = (s: string) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const schema = `const schema = { '~standard': { version: 1 as const, vendor: 'example', validate(value: unknown) {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? { value: value as { id: string } } : { issues: [{ message: 'Expected an object with string id' }] };
} } };\n`;

export function ecosystemTemplate(name: string, file: string, options: GenerateStepOptions): { source: string; test: string } | undefined {
  const o = options;
  const header = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { create${name}Step } from './${file}.step';\n`;
  if (o.type === 'http') {
    const url = new URL(o.url);
    return {
      source: `import { httpStep } from '@siglo/http';\n\n${schema}\n// Static URLs declare their host automatically. For dynamic URLs, call .allowNetwork([...]).\nexport function create${name}Step() {\n  return httpStep(${literal(name)}, { url: ${literal(o.url)}, method: 'POST',\n    body: { id: 'example' }, requestSchema: schema, responseSchema: schema });\n}\n`,
      test: header + `import { createMockHttpServer } from '@siglo/http/testing';\nimport { installNetworkInterceptors } from '@siglo/core';\n\ntest('HTTP offline response', async () => {\n  installNetworkInterceptors();\n  const originalFetch = globalThis.fetch;\n  const http = createMockHttpServer();\n  try {\n    http.get(${literal(url.origin)}).intercept({ path: ${literal(url.pathname + url.search)}, method: 'POST' }).reply(200, { id: 'fixture' });\n    const result = await create${name}Step().execute({});\n    assert.equal(result.id, 'fixture');\n    http.assertDone();\n  } finally { http.close(); assert.equal(globalThis.fetch, originalFetch); }\n});\n`
    };
  }
  if (o.type === 'ai') return {
    source: `import { aiStep, type AiProviderAdapter } from '@siglo/ai';\n\n${schema}\nexport function create${name}Step(adapter?: AiProviderAdapter) {\n  return aiStep(${literal(name)}, { model: { provider: ${literal(o.provider)}, model: ${literal(o.model)}, adapter },\n    prompt: 'Return JSON with a string id.', schema,\n    jsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } });\n}\n`,
    test: header + `import { MockAiProvider } from '@siglo/ai/testing';\n\ntest('AI offline structured response', async () => {\n  const ai = new MockAiProvider([{ text: '{"id":"fixture"}', promptTokens: 10, completionTokens: 5 }]);\n  const result = await create${name}Step(ai).execute({});\n  assert.deepEqual(result.data, { id: 'fixture' });\n  ai.assertDone();\n});\n`
  };
  if (o.type === 'crypto') {
    const sign: Record<string, string> = {
      stripe: "{ 'stripe-signature': `t=${timestamp},v1=${hmac(`${timestamp}.${body}`)}` }",
      github: "{ 'x-hub-signature-256': `sha256=${hmac(body)}` }",
      shopify: "{ 'x-shopify-hmac-sha256': hmac(body, 'base64') }",
      slack: "{ 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${hmac(`v0:${timestamp}:${body}`)}` }",
      svix: "{ 'svix-id': 'fixture', 'svix-timestamp': timestamp, 'svix-signature': `v1,${hmac(`fixture.${timestamp}.${body}`, 'base64')}` }",
      'generic-hmac': "{ 'x-signature': hmac(body) }"
    };
    return {
      source: `import { verifyWebhookStep } from '@siglo/crypto';\n\n// Pass the original raw body, never parsed/re-serialized JSON.\nexport function create${name}Step(secret = () => {\n  const value = process.env.WEBHOOK_SECRET;\n  if (!value) throw new Error('WEBHOOK_SECRET is required');\n  return value;\n}) {\n  return verifyWebhookStep(${literal(name)}, { provider: ${literal(o.provider)}, secret,\n    payload: (ctx: { rawBody: string | Buffer; headers: Record<string, string> }) => ctx.rawBody,\n    signature: ctx => ctx.headers });\n}\n`,
      test: header + `import { createHmac } from 'node:crypto';\n\ntest('valid signature and rejection', async () => {\n  const secret = 'synthetic-test-key';\n  const body = '{ "id": "fixture" }';\n  const timestamp = String(Math.floor(Date.now() / 1000));\n  const hmac = (value: string, encoding: 'hex' | 'base64' = 'hex') => createHmac('sha256', secret).update(value).digest(encoding);\n  const headers = ${sign[o.provider]};\n  const result = await create${name}Step(() => secret).execute({ rawBody: body, headers });\n  assert.equal(result.webhookVerified, true);\n  await assert.rejects(() => create${name}Step(() => secret).execute({ rawBody: body + 'tampered', headers }));\n});\n`
    };
  }
  if (o.type === 'notification') {
    const recipient = { email: 'fixture@example.test', slack: 'CFIXTURE', discord: 'https://discord.com/api/webhooks/fixture/token', sms: '+15555550123', push: 'fixture-device' }[o.channel];
    const approval = o.interactive;
    return {
      source: `import { ${approval ? 'sendInteractiveApprovalStep' : 'sendNotificationStep'}, type NotificationTransport } from '@siglo/notifications';\n\n// Inject a production transport at the application boundary; see the CLI cookbook.\nexport function create${name}Step(transport: NotificationTransport${approval ? ', callbackBaseUrl: string, signingSecret: string' : ''}) {\n  return ${approval ? 'sendInteractiveApprovalStep' : 'sendNotificationStep'}(${literal(name)}, { channel: ${literal(o.channel)}, transport,\n    recipient: ${literal(recipient)}, ${approval ? "title: 'Approval requested', correlationKey: 'example-approval', timeout: '1h',\n    onApproveEvent: 'approved', onRejectEvent: 'rejected', callbackBaseUrl, signingSecret" : "template: 'Example notification'"} });\n}\n`,
      test: header + `import { MockNotificationTransport } from '@siglo/notifications/testing';\n\ntest('offline ${approval ? 'approval dispatch' : 'delivery'}', async () => {\n  const transport = new MockNotificationTransport(${literal(o.channel)});\n  const result = await create${name}Step(transport${approval ? ", 'https://example.test/callback', 'synthetic-test-signing-key'" : ''}).execute({});\n  assert.equal(result.notificationId, 'mock-1');\n  assert.equal(transport.messages.length, 1);\n${approval ? "  assert.ok(transport.messages[0].interactiveActions);\n" : ''}});\n`
    };
  }
  return undefined;
}
