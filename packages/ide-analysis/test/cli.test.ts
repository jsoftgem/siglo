import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { expect } from 'chai';
import { PROTOCOL_METHODS, createRequest } from '@siglo/ide-protocol';

describe('packages/ide-analysis CLI daemon stdio lifecycle', () => {
  const binPath = path.resolve(__dirname, '../dist/bin.js');
  const fixturePath = path.resolve(__dirname, 'fixtures/order.workflow.ts');

  it('handles initialize, getGraph, resolveLocation, and shutdown over stdio', (done) => {
    const proc = spawn(process.execPath, [binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: proc.stdout });
    const responses: any[] = [];

    rl.on('line', (line) => {
      const parsed = JSON.parse(line.trim());
      responses.push(parsed);

      if (parsed.id === 1) {
        // Response to initialize: send getGraph
        expect(parsed.result.protocolVersion).to.equal('1.0.0');
        expect(parsed.result.supportedSyntaxMatrix).to.be.an('array');
        const req2 = createRequest(2, PROTOCOL_METHODS.GET_GRAPH, {
          uri: fixturePath,
          documentVersion: 1,
        });
        proc.stdin.write(JSON.stringify(req2) + '\n');
      } else if (parsed.id === 2) {
        // Response to getGraph: send resolveLocation
        expect(parsed.result.workflowName).to.equal('orderWorkflow');
        expect(parsed.result.nodes.length).to.be.greaterThan(0);
        const firstNode = parsed.result.nodes[0];

        const req3 = createRequest(3, PROTOCOL_METHODS.RESOLVE_LOCATION, {
          uri: fixturePath,
          position: firstNode.location.start,
        });
        proc.stdin.write(JSON.stringify(req3) + '\n');
      } else if (parsed.id === 3) {
        // Response to resolveLocation: send shutdown
        expect(parsed.result.nodeId).to.be.ok;
        const req4 = createRequest(4, PROTOCOL_METHODS.SHUTDOWN, {});
        proc.stdin.write(JSON.stringify(req4) + '\n');
      }
    });

    proc.on('exit', (code) => {
      expect(code).to.equal(0);
      expect(responses).to.have.lengthOf(4);
      done();
    });

    // Send initialize request
    const initReq = createRequest(1, PROTOCOL_METHODS.INITIALIZE, {
      clientName: 'IntelliJ IDEA Test',
      clientVersion: '2024.1',
      rootUri: 'file:///workspace',
      capabilities: { dynamicRefresh: true },
    });
    proc.stdin.write(JSON.stringify(initReq) + '\n');
  });
});
