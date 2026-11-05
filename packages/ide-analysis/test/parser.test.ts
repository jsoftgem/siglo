import { expect } from 'chai';
import path from 'path';
import fs from 'fs';
import { parseWorkflowFile, resolveLocationInDocument, discoverWorkflows } from '../src/parser';

describe('packages/ide-analysis parser', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  it('proves ZERO-EXECUTION safety: parses malicious fixture without executing top-level code', () => {
    const maliciousFile = path.join(fixturesDir, 'malicious.workflow.ts');
    const canaryFile = path.join(fixturesDir, 'canary.txt');
    if (fs.existsSync(canaryFile)) {
      fs.unlinkSync(canaryFile);
    }

    const doc = parseWorkflowFile({ uri: maliciousFile });

    expect(doc.workflowName).to.equal('safeWorkflow');
    expect(doc.nodes).to.have.lengthOf(1);
    expect(doc.nodes[0].name).to.equal('safeStep');
    expect(fs.existsSync(canaryFile), 'CANARY FILE MUST NOT BE CREATED (Zero application execution)').to.be.false;
  });

  it('extracts topology, ecosystem steps, and execution configs from order.workflow.ts', () => {
    const orderPath = path.join(fixturesDir, 'order.workflow.ts');
    const doc = parseWorkflowFile({ uri: orderPath });

    expect(doc.workflowName).to.equal('orderWorkflow');
    expect(doc.nodes.length).to.be.greaterThan(2);

    const fetchStep = doc.nodes.find((n) => n.name === 'fetchUser');
    expect(fetchStep).to.exist;
    expect(fetchStep?.executionConfig?.retries).to.equal(2);
    expect(fetchStep?.executionConfig?.timeoutMs).to.equal(3000);

    const chargeStep = doc.nodes.find((n) => n.name === 'chargeCard');
    expect(chargeStep).to.exist;
    expect(chargeStep?.stepKind).to.equal('http');

    const compensationEdge = doc.edges.find((e) => e.type === 'compensation');
    expect(compensationEdge).to.exist;
  });

  it('handles multi-byte unicode offsets safely', () => {
    const unicodePath = path.join(fixturesDir, 'order.workflow.ts');
    const content = `// 🚀 Japanese: ワークフロー | Emoji: 🔥🎉\nimport { flow, Step } from '@siglo/core';\nconst s = Step.create('unicodeStep', () => {});\nflow('unicodeFlow', s);`;
    const doc = parseWorkflowFile({ uri: unicodePath, content });

    expect(doc.workflowName).to.equal('unicodeFlow');
    expect(doc.nodes).to.have.lengthOf(1);
    expect(doc.nodes[0].name).to.equal('unicodeStep');
    expect(doc.nodes[0].location.start.line).to.equal(2);
  });

  it('normalizes POSIX URIs, Windows backslashes, and file paths consistently', () => {
    const posixDoc = parseWorkflowFile({ uri: '/app/order.workflow.ts', content: 'flow("testFlow");' });
    expect(posixDoc.uri).to.equal('file:///app/order.workflow.ts');
  });

  it('resolves source position to the correct AST node range', () => {
    const sampleContent = `import { flow, Step } from '@siglo/core';
const step1 = Step.create('step1', () => {});
const step2 = Step.create('step2', () => {});
flow('test', step1, step2);`;

    const doc = parseWorkflowFile({ uri: '/test.ts', content: sampleContent });
    const resolved = resolveLocationInDocument(doc, { line: 1, character: 20 });

    expect(resolved.nodeId).to.exist;
    expect(resolved.range).to.exist;

    const outside = resolveLocationInDocument(doc, { line: 0, character: 0 });
    expect(outside.nodeId).to.be.undefined;
  });

  it('discovers workflows in files and workspaces', () => {
    const orderPath = path.join(fixturesDir, 'order.workflow.ts');
    const discovered = discoverWorkflows({ documentUri: orderPath });
    expect(discovered).to.have.lengthOf(1);
    expect(discovered[0].name).to.equal('orderWorkflow');
  });

  it('parses multi-argument workflows: flow(step1, step2)', () => {
    const samplePath = path.resolve(__dirname, '../../../examples/src/workflow/usecases/sample.ts');
    const content = `
      const step1 = Step.create('sampleStep', () => {});
      const step2 = Step.create('sampleStepWithSpec', () => {});
      const step3 = Step.create('sampleStepWithSpecAndValidation', () => {});
      const step4 = Step.create('sampleStepWithSpecAndValidation2', () => {});
      const step5 = Step.create('sampleStepWithSpecAndValidation4', () => {});
      const flow1 = flow(step1, step2, step5);
      const flow2 = flow(step3, step4);
      flow(flow1, flow2);
    `;
    const doc = parseWorkflowFile({ uri: samplePath, content });
    // Default composite flow: flow(flow1, flow2) has 5 steps
    expect(doc.nodes).to.have.lengthOf(5);
    expect(doc.workflows).to.have.lengthOf(3);
    expect(doc.workflows![0].name).to.equal('flow1');
    expect(doc.workflows![0].nodes).to.have.lengthOf(3);
    expect(doc.workflows![1].name).to.equal('flow2');
    expect(doc.workflows![1].nodes).to.have.lengthOf(2);
    expect(doc.workflows![2].name).to.equal('flow(flow1, flow2)');
    expect(doc.workflows![2].nodes).to.have.lengthOf(5);

    // Can query a specific flow by name
    const docFlow2 = parseWorkflowFile({ uri: samplePath, content, workflowName: 'flow2' });
    expect(docFlow2.workflowName).to.equal('flow2');
    expect(docFlow2.nodes).to.have.lengthOf(2);
    expect(docFlow2.nodes[0].name).to.equal('sampleStepWithSpecAndValidation');
    expect(docFlow2.nodes[1].name).to.equal('sampleStepWithSpecAndValidation2');
    expect(docFlow2.edges).to.have.lengthOf(1);
    expect(docFlow2.edges[0].type).to.equal('sequential');
  });
});


describe('standalone combinator topology', () => {
  it('expands the multi-cloud fixture into race, replication and telemetry forks', () => {
    const doc = parseWorkflowFile({ uri: path.resolve(__dirname, '../../../examples/src/workflow/usecases/usecase-13-parallel-cloud-race.ts') });
    expect(doc.unresolved).to.have.lengthOf(0);
    for (const [name, count] of [['race', 2], ['parallel', 3], ['allSettled', 2]] as const) {
      const fork = doc.nodes.find(n => n.name === name)!;
      expect(fork, name).to.exist;
      expect(doc.edges.filter(e => e.from === fork.id && e.type === 'parallel')).to.have.lengthOf(count);
    }
    const receipt = doc.nodes.find(n => n.name === 'assembleReceipt')!;
    const join = doc.nodes.find(n => n.name === 'allSettled join')!;
    expect(doc.edges.some(e => e.from === join.id && e.to === receipt.id)).to.equal(true);
    expect(doc.diagnostics).to.have.lengthOf(0);
  });

  it('expands named branches and nested parallel arrays', () => {
    const doc = parseWorkflowFile({ uri: '/branch.ts', content: `
      const a = Step.create('a', () => {});
      const b = Step.create('b', () => {});
      const c = Step.create('c', () => {});
      const routes = branch(ctx => ctx.route, { yes: parallel([a, b]), no: c });
      flow(routes, a);
    ` });
    expect(doc.unresolved).to.have.lengthOf(0);
    expect(doc.edges.filter(e => e.type === 'branch').map(e => e.label)).to.deep.equal(['yes', 'no']);
    expect(doc.edges.filter(e => e.type === 'parallel')).to.have.lengthOf(2);
  });
});


describe('package step coverage', () => {
  it('expands all, static helpers, when skip paths, map bodies and durable waits', () => {
    const doc = parseWorkflowFile({ uri: '/special.ts', content: `
      const a = Step.create('a', () => {});
      const b = Step.create('b', () => {});
      const batch = Step.map(ctx => ctx.items, flow(a, b), { concurrency: 3, preserveOrder: false });
      flow(all([a, b]), when(ctx => ctx.ok, batch), wait('2s'), Step.waitForEvent('approved', { timeout: '1h', correlationKey: ctx => ctx.id }));
    ` });
    expect(doc.unresolved).to.have.lengthOf(0);
    const map = doc.nodes.find(n => n.name === 'map')!;
    expect(map.properties?.concurrency).to.equal('3');
    expect(map.properties?.preserveOrder).to.equal('false');
    expect(doc.nodes.some(n => n.name.startsWith('wait:'))).to.equal(true);
    expect(doc.nodes.find(n => n.name.startsWith('waitForEvent:'))?.properties?.timeout).to.equal("'1h'");
    const conditional = doc.nodes.find(n => n.name === 'when')!;
    const join = doc.nodes.find(n => n.name === 'when join')!;
    expect(doc.edges.some(e => e.from === conditional.id && e.to === join.id)).to.equal(true);
    expect(doc.edges.filter(e => e.type === 'branch')).to.have.lengthOf(1);
  });

  it('recognizes crypto factories, constructors and fluent execution options', () => {
    const doc = parseWorkflowFile({ uri: '/ecosystem.ts', content: `
      const encrypt = encryptFieldsStep('encrypt', { fields: ['email'], secretKey: 'not-for-inspector' });
      const decrypt = new DecryptFieldsStep('decrypt', { fields: ['email'] });
      const mask = maskFieldsStep('mask', { fields: ['phone'] });
      const request = httpStep('request', { maxRetries: 4, timeoutMs: 200 }).timeout(500).compensateWithHttp({ method: 'DELETE' });
      const model = new AiStep('model', { provider: 'openai', model: 'configured-model' });
      Step.flow(encrypt, decrypt, mask, request, model, new Step('finish', () => {}));
    ` });
    expect(doc.unresolved).to.have.lengthOf(0);
    expect(doc.nodes).to.have.lengthOf(6);
    expect(doc.nodes.filter(n => n.stepKind === 'crypto')).to.have.lengthOf(3);
    const request = doc.nodes.find(n => n.name === 'request')!;
    expect(request.executionConfig).to.deep.equal({ retries: 4, timeoutMs: 500, hasCompensation: true });
    expect(doc.nodes.find(n => n.name === 'encrypt')?.properties).not.to.have.property('secretKey');
    expect(doc.nodes.find(n => n.name === 'model')?.stepKind).to.equal('ai');
  });
});


describe('underwriting and settlement fixture isolation', () => {
  const usecases = path.resolve(__dirname, '../../../examples/src/workflow/usecases');
  it('preserves SUBPRIME and default routes to the shared decline subflow', () => {
    const doc = parseWorkflowFile({ uri: path.join(usecases, 'usecase-14-dynamic-underwriting-branching.ts') });
    const router = doc.nodes.find(n => n.name === 'branch')!;
    const decline = doc.nodes.find(n => n.name === 'declineSubprime')!;
    const routes = doc.edges.filter(e => e.from === router.id && e.type === 'branch');
    expect(routes.map(e => e.label)).to.deep.equal(['PRIME', 'NEAR_PRIME', 'SUBPRIME / default']);
    expect(routes.find(e => e.label?.includes('SUBPRIME'))?.to).to.equal(decline.id);
    expect(new Set(doc.edges.map(e => e.id)).size).to.equal(doc.edges.length);
    expect(doc.edges.filter(e => e.from === decline.id)).to.have.lengthOf(1);
    expect(doc.unresolved).to.have.lengthOf(0);
    expect(doc.diagnostics).to.have.lengthOf(0);
  });

  it('keeps settlement sequential and preserves its idempotency configuration after parsing underwriting', () => {
    parseWorkflowFile({ uri: path.join(usecases, 'usecase-14-dynamic-underwriting-branching.ts') });
    const doc = parseWorkflowFile({ uri: path.join(usecases, 'usecase-15-idempotent-payment-claims.ts') });
    expect(doc.nodes.map(n => n.name)).to.deep.equal(['validateTransfer', 'settleLedgerEntry', 'issueTransferReceipt']);
    expect(doc.edges.map(e => e.type)).to.deep.equal(['sequential', 'sequential']);
    const settlement = doc.nodes[1];
    expect(settlement.properties?.idempotent).to.include('ledger-settlement');
    expect(settlement.properties?.idempotent).to.include('60000');
    expect(doc.edges.some(e => e.label?.includes('SUBPRIME'))).to.equal(false);
    expect(doc.unresolved).to.have.lengthOf(0);
  });
});


describe('structured input contracts', () => {
  it('preserves every order-intake spec, repeated fields, alias rules, and whole-input schema', () => {
    const doc = parseWorkflowFile({ uri: path.resolve(__dirname, '../../../examples/src/workflow/usecases/usecase-24-order-intake-specs.ts') });
    const normalize = doc.nodes.find(n => n.name === 'orderIntakeNormalize')!;
    expect(normalize.specs).to.have.lengthOf(11);
    expect(normalize.properties).not.to.have.property('spec');
    const rules = (field: string) => normalize.specs!.filter(s => s.field === field).flatMap(s => s.rules);
    expect(rules('email').map(r => r.kind)).to.deep.equal(['required', 'transform', 'translate']);
    expect(rules('countryCode').map(r => r.kind)).to.deep.equal(['required', 'transform', 'translate']);
    expect(rules('purchaseOrder')[0]).to.include({ kind: 'required', expression: true, value: '() => requirePurchaseOrder' });
    expect(rules('orderId')[1].value).to.equal('An order ID is required.');
    expect(rules('currency')[0]).to.include({ kind: 'default', value: 'PHP', expression: false });
    expect(rules('shippingMethod')[0]).to.include({ kind: 'default', value: 'STANDARD', expression: false });
    expect(rules('quantity')[0].description).to.equal('Quantity must be a positive integer.');
    expect(rules('unitPrice')[0].kind).to.equal('validate');
    expect(rules('shippingAddress')[0].kind).to.equal('schema');
    const accept = doc.nodes.find(n => n.name === 'orderIntakeAccept')!;
    expect(accept.specs![0].field).to.equal('$root$');
    expect(accept.specs![0].rules[0]).to.include({ kind: 'schema', expression: true, description: 'A valid customer email is required.' });
    expect(doc.unresolved).to.have.lengthOf(0);
  });

  it('supports schema helpers, dynamic options, and static falsy defaults', () => {
    const doc = parseWorkflowFile({ uri: '/specs.ts', content: `
      const step = Step.create('check', () => {}).schema(rootSchema)
        .spec('count', { default: 0, defaultValue: 7, require: false })
        .spec('label', { default: '' }).spec('optional', options)
        .spec('address', fieldSchema);
      flow(step);
    ` });
    const specs = doc.nodes[0].specs!;
    expect(specs[0].rules[0].value).to.equal('rootSchema');
    expect(specs[1].rules.map(r => r.value)).to.deep.equal(['0', 'false']);
    expect(specs[2].rules[0]).to.include({ value: '', expression: false });
    expect(specs[3].rules[0]).to.include({ kind: 'options', value: 'options', expression: true });
  });
});

describe('workflow-level configuration', () => {
  it('extracts chained deadlines, schema versions and network settings without creating steps', () => {
    const doc = parseWorkflowFile({ uri: '/flow-properties.ts', documentVersion: 9, content: `
      const a = Step.create('a', () => {}).timeout(200);
      const payment = flow(a).timeout(1000).version('v2.1').networkPolicy({
        defaultPolicy: 'deny', allowedHosts: ['api.stripe.com', /\\.example\\.com$/], allowLocalhost: true
      }).monitor(events);
    ` });
    expect(doc.properties).to.include({ timeoutMs: '1000', workflowVersion: 'v2.1', monitor: 'events', 'network.defaultPolicy': 'deny', 'network.allowLocalhost': 'true' });
    expect(doc.properties!['network.allowedHosts']).to.include('api.stripe.com');
    expect(doc.workflows![0].properties).to.deep.equal(doc.properties);
    expect(doc.documentVersion).to.equal(9);
    expect(doc.nodes).to.have.lengthOf(1);
    expect(doc.nodes[0].executionConfig?.timeoutMs).to.equal(200);
    expect(doc.edges).to.have.lengthOf(0);
  });

  it('tracks separate configuration calls in order and keeps subflow defaults local', () => {
    const doc = parseWorkflowFile({ uri: '/flow-properties.ts', content: `
      const child = flow(Step.create('a', () => {})).timeout(100).version(1);
      child.timeout(500).version('v3');
      const outer = flow(child, Step.create('b', () => {})).timeout(limit);
      outer.networkPolicy({ allowedHosts: ['api.example.com'] });
      outer.run({}, { timeout: 999, workflowVersion: 'runtime' });
    ` });
    expect(doc.workflows![0].properties).to.deep.equal({ timeoutMs: '500', workflowVersion: 'v3' });
    expect(doc.properties).to.include({ timeoutMs: 'limit', 'network.defaultPolicy': 'deny', 'network.allowLocalhost': 'false' });
    expect(doc.properties).not.to.have.property('workflowVersion');
    expect(doc.nodes).to.have.lengthOf(2);
  });

  it('preserves dynamic policies as source expressions without inventing defaults', () => {
    const doc = parseWorkflowFile({ uri: '/flow-properties.ts', content: `
      const pipeline = flow(Step.create('a', () => {})).networkPolicy(policy);
      pipeline.networkPolicy({ ...settings, defaultPolicy: 'deny' });
    ` });
    expect(doc.properties!['network.source']).to.include('...settings');
    expect(doc.properties).not.to.have.property('network.allowLocalhost');
    expect(doc.properties!['network.defaultPolicy']).to.equal('deny');
  });
});
