import { expect } from 'chai';
import { Step, flow } from '@siglo/core';
import { sigloFastifyHandler, getErrorStatusCode } from './index';

describe('@siglo/fastify Adapter Suite', () => {
    it('executes workflow using fastify request and returns clean response', async () => {
        const stepA = Step.create(async ({ price, qty }: { price: number; qty: number }) => ({
            subtotal: price * qty,
        }));
        const orderFlow = flow(stepA);

        const handler = sigloFastifyHandler(orderFlow);

        const mockReq = {
            body: { price: 20, qty: 3 },
            headers: { 'x-namespace': 'ns-fastify', 'x-correlation-id': 'corr-fastify-99' },
        };
        const headersSet: Record<string, string> = {};
        const mockReply = {
            header(name: string, val: string) {
                headersSet[name] = val;
            },
        };

        const result = await handler(mockReq, mockReply);
        expect(result.subtotal).to.equal(60);
        expect(headersSet['X-Workflow-Stack-Id']).to.be.a('string');
        expect(headersSet['X-Correlation-Id']).to.equal('corr-fastify-99');
    });

    it('ignores x-namespace header by default and respects it only when allowHeaderNamespace is true', async () => {
        let capturedNamespace: string | undefined;
        const inspectStep = Step.create(async (param: any) => {
            capturedNamespace = typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace;
            return { ok: true };
        });
        const testFlow = flow(inspectStep);

        const mockReq = {
            body: {},
            headers: { 'x-namespace': 'attacker-fastify' },
        };
        const mockReply = { header: () => {} };

        // Default: header is ignored for security
        const secureHandler = sigloFastifyHandler(testFlow);
        await secureHandler(mockReq, mockReply);
        expect(capturedNamespace).to.be.undefined;

        // With explicit opt-in: header is respected
        const optInHandler = sigloFastifyHandler(testFlow, { allowHeaderNamespace: true });
        await optInHandler(mockReq, mockReply);
        expect(capturedNamespace).to.equal('attacker-fastify');
    });

    it('sanitizes internal 500 error messages when exposeErrorDetails is false', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Database password incorrect in /etc/db.conf');
        });
        const handler = sigloFastifyHandler(flow(failStep), {
            exposeErrorDetails: false,
        });

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        await handler({}, mockReply);
        expect(sentStatus).to.equal(500);
        expect(sentBody.error).to.equal('Internal workflow execution error');
    });

    it('handles errors and maps to reply status via onError', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Forbidden operation');
        });
        const failingFlow = flow(failStep);

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        const handler = sigloFastifyHandler(failingFlow, {
            onError: (err, reply) => reply.status(403).send({ message: err.message }),
        });

        await handler({}, mockReply);
        expect(sentStatus).to.equal(403);
        expect(sentBody.message).to.equal('Forbidden operation');
    });

    it('maps default error status codes correctly without custom onError', async () => {
        const timeoutErr = new Error('Gateway timed out');
        timeoutErr.name = 'FlowTimeoutException';

        expect(getErrorStatusCode(timeoutErr)).to.equal(504);
        expect(getErrorStatusCode({ name: 'ValidationException' })).to.equal(400);

        const failingStep = Step.create(async (): Promise<any> => {
            throw timeoutErr;
        });
        const handler = sigloFastifyHandler(flow(failingStep));

        let sentStatus = 0;
        let sentBody: any;
        const mockReply = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            send(b: any) {
                sentBody = b;
                return b;
            },
        };

        await handler({}, mockReply);
        expect(sentStatus).to.equal(504);
        expect(sentBody.error).to.equal('Gateway timed out');
    });
});
