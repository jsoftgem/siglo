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
    executionRange,
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
        const errRes = createErrorResponse(2, JsonRpcErrorCode.MethodNotFound, 'Method not found', {
            method: 'foo/bar',
        });

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

    describe('executionRange', () => {
        const loc: SourceRange = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
        const makeNode = (id: string, name: string, stepIndex?: number): GraphNode => ({
            id,
            name,
            stepKind: 'generic',
            location: loc,
            declarationRange: loc,
            executionTarget: stepIndex !== undefined ? { exportName: 'wf', stepIndex } : undefined,
        });

        const nodes: GraphNode[] = [
            makeNode('step1', 'Step 1', 0),
            makeNode('step2', 'Step 2', 1),
            makeNode('step3', 'Step 3', 2),
            makeNode('step4', 'Step 4', 3),
            makeNode('step5', 'Step 5', 4),
        ];

        const edges: GraphEdge[] = [
            { id: 'e1', from: 'step1', to: 'step2', type: 'sequential' },
            { id: 'e2', from: 'step2', to: 'step3', type: 'sequential' },
            { id: 'e3', from: 'step3', to: 'step4', type: 'sequential' },
            { id: 'e4', from: 'step4', to: 'step5', type: 'sequential' },
        ];

        it('returns a single selected step', () => {
            const range = executionRange(nodes, edges, ['step2']);
            expect(range.map(n => n.id)).to.deep.equal(['step2']);
        });

        it('resolves sequential range regardless of selection order', () => {
            // Selecting 2 and 4 yields 2 -> 3 -> 4
            const forward = executionRange(nodes, edges, ['step2', 'step4']);
            expect(forward.map(n => n.id)).to.deep.equal(['step2', 'step3', 'step4']);

            // Reverse selection order (4 then 2) still yields 2 -> 3 -> 4
            const reverse = executionRange(nodes, edges, ['step4', 'step2']);
            expect(reverse.map(n => n.id)).to.deep.equal(['step2', 'step3', 'step4']);

            // More than two selected steps (4, 2, 3)
            const multi = executionRange(nodes, edges, ['step4', 'step2', 'step3']);
            expect(multi.map(n => n.id)).to.deep.equal(['step2', 'step3', 'step4']);
        });

        it('rejects empty selection', () => {
            expect(() => executionRange(nodes, edges, [])).to.throw('Select one or more steps.');
        });

        it('rejects synthetic fork/join nodes with explanatory message', () => {
            const forkNode = makeNode('step_fork_1', 'parallel fork');
            expect(() => executionRange([...nodes, forkNode], edges, ['step_fork_1'])).to.throw(
                'Synthetic fork/join nodes cannot run independently.',
            );
        });

        it('rejects composite combinator nodes', () => {
            const compNode = makeNode('par1', 'parallel');
            expect(() => executionRange([...nodes, compNode], edges, ['par1'])).to.throw(
                'Composite boundaries cannot be crossed. Select individual steps within a branch.',
            );
        });

        it('rejects unexported steps', () => {
            const unexported = makeNode('unexp', 'Private Step');
            expect(() => executionRange([...nodes, unexported], edges, ['unexp'])).to.throw(
                'Selection is not independently executable.',
            );
        });

        it('rejects non-contiguous ranges or selections crossing boundaries', () => {
            const brokenEdges = edges.filter(e => e.id !== 'e2');
            expect(() => executionRange(nodes, brokenEdges, ['step1', 'step4'])).to.throw(
                'Select a contiguous sequential range within one branch.',
            );
        });
    });
});
