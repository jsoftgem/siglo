import { expect } from 'chai';
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  PROTOCOL_METHODS,
  createRequest,
  createResponse,
  createErrorResponse,
  createNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification,
  GraphDocument,
  GraphNode,
  GraphEdge,
  SourceRange,
} from '../src';

describe('packages/ide-protocol', () => {
  it('creates valid JSON-RPC 2.0 requests', () => {
    const req = createRequest(1, PROTOCOL_METHODS.INITIALIZE, {
      clientName: 'IntelliJ IDEA',
      clientVersion: '2024.1',
      rootUri: 'file:///path/to/project',
      capabilities: { dynamicRefresh: true },
    });

    expect(req.jsonrpc).to.equal(JSONRPC_VERSION);
    expect(req.id).to.equal(1);
    expect(req.method).to.equal('siglo/initialize');
    expect(req.params.clientName).to.equal('IntelliJ IDEA');
    expect(isJsonRpcRequest(req)).to.be.true;
    expect(isJsonRpcResponse(req)).to.be.false;
  });

  it('creates valid JSON-RPC 2.0 responses', () => {
    const res = createResponse(1, {
      serverVersion: '1.0.0',
      protocolVersion: '1.0.0',
      supportedSyntaxMatrix: ['flow', 'step'],
    });

    expect(res.jsonrpc).to.equal(JSONRPC_VERSION);
    expect(res.id).to.equal(1);
    expect(res.result.protocolVersion).to.equal('1.0.0');
    expect(isJsonRpcResponse(res)).to.be.true;
    expect(isJsonRpcRequest(res)).to.be.false;
  });

  it('creates valid JSON-RPC error responses', () => {
    const errRes = createErrorResponse(
      2,
      JsonRpcErrorCode.MethodNotFound,
      'Method not found',
      { method: 'foo/bar' }
    );

    expect(errRes.jsonrpc).to.equal(JSONRPC_VERSION);
    expect(errRes.id).to.equal(2);
    expect(errRes.error?.code).to.equal(-32601);
    expect(errRes.error?.message).to.equal('Method not found');
    expect(isJsonRpcResponse(errRes)).to.be.true;
  });

  it('creates valid notifications', () => {
    const notif = createNotification('siglo/telemetry', { event: 'ping' });
    expect(notif.jsonrpc).to.equal(JSONRPC_VERSION);
    expect(notif.method).to.equal('siglo/telemetry');
    expect(isJsonRpcNotification(notif)).to.be.true;
    expect(isJsonRpcRequest(notif)).to.be.false;
  });

  it('validates graph document schema and data model', () => {
    const location: SourceRange = {
      start: { line: 10, character: 2 },
      end: { line: 15, character: 4 },
    };

    const node: GraphNode = {
      id: 'step_order_L10_C2',
      name: 'createOrder',
      stepKind: 'generic',
      location,
      declarationRange: location,
      executionConfig: { retries: 3, timeoutMs: 5000 },
    };

    const edge: GraphEdge = {
      id: 'edge_1',
      from: 'step_order_L10_C2',
      to: 'step_payment_L20_C2',
      type: 'sequential',
    };

    const doc: GraphDocument = {
      uri: 'file:///app/order.workflow.ts',
      documentVersion: 1,
      workflowName: 'orderWorkflow',
      nodes: [node],
      edges: [edge],
      unresolved: [],
      diagnostics: [],
    };

    expect(doc.workflowName).to.equal('orderWorkflow');
    expect(doc.nodes).to.have.lengthOf(1);
    expect(doc.nodes[0].stepKind).to.equal('generic');
    expect(doc.edges[0].type).to.equal('sequential');
  });
});
