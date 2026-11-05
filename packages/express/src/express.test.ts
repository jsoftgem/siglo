import { expect } from 'chai';
import { Step, flow } from '@siglo/core';
import { sigloExpressMiddleware, getErrorStatusCode } from './index';

describe('@siglo/express Adapter Suite', () => {
    it('executes workflow using express request and sends json response', async () => {
        const stepA = Step.create(async ({ a, b }: { a: number; b: number }) => ({
            sum: a + b,
        }));
        const calcFlow = flow(stepA);

        const middleware = sigloExpressMiddleware(calcFlow);

        const mockReq = {
            body: { a: 15, b: 25 },
            headers: { 'x-namespace': 'ns-express', 'x-correlation-id': 'corr-express-123' },
        };
        const headersSet: Record<string, string> = {};
        let sentBody: any;
        const mockRes = {
            setHeader(name: string, val: string) {
                headersSet[name] = val;
            },
            json(b: any) {
                sentBody = b;
                return b;
            },
        };

        await middleware(mockReq, mockRes, () => {});

        expect(sentBody.sum).to.equal(40);
        expect(headersSet['X-Workflow-Stack-Id']).to.be.a('string');
        expect(headersSet['X-Correlation-Id']).to.equal('corr-express-123');
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
            headers: { 'x-namespace': 'attacker-tenant' },
        };
        const mockRes = { json: (b: any) => b };

        // Default: header is ignored for security
        const secureMiddleware = sigloExpressMiddleware(testFlow);
        await secureMiddleware(mockReq, mockRes, () => {});
        expect(capturedNamespace).to.be.undefined;

        // With explicit opt-in: header is respected
        const optInMiddleware = sigloExpressMiddleware(testFlow, { allowHeaderNamespace: true });
        await optInMiddleware(mockReq, mockRes, () => {});
        expect(capturedNamespace).to.equal('attacker-tenant');
    });

    it('sanitizes internal 500 error messages when exposeErrorDetails is false', async () => {
        const secretErrorStep = Step.create(async (): Promise<any> => {
            throw new Error('FATAL: password authentication failed for user postgres');
        });
        const middleware = sigloExpressMiddleware(flow(secretErrorStep), {
            exposeErrorDetails: false,
        });

        let sentStatus = 0;
        let sentJson: any;
        const mockRes = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            json(j: any) {
                sentJson = j;
                return j;
            },
        };

        await middleware({}, mockRes, () => {});
        expect(sentStatus).to.equal(500);
        expect(sentJson.error).to.equal('Internal workflow execution error');
    });

    it('routes workflow errors to next(err) if no custom onError provided and no res.status/json', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Database down');
        });
        const brokenFlow = flow(failStep);

        const middleware = sigloExpressMiddleware(brokenFlow);

        let errorReceived: any;
        await middleware({}, {}, (err: any) => {
            errorReceived = err;
        });

        expect(errorReceived).to.exist;
        expect(errorReceived.message).to.equal('Database down');
    });

    it('handles errors and maps to status code if res.status and res.json are present', async () => {
        const timeoutErr = new Error('Request deadline exceeded');
        timeoutErr.name = 'StepTimeoutException';

        expect(getErrorStatusCode(timeoutErr)).to.equal(504);
        expect(getErrorStatusCode({ name: 'CancellationException' })).to.equal(499);

        const failStep = Step.create(async (): Promise<any> => {
            throw timeoutErr;
        });
        const middleware = sigloExpressMiddleware(flow(failStep));

        let sentStatus = 0;
        let sentJson: any;
        const mockRes = {
            status(s: number) {
                sentStatus = s;
                return this;
            },
            json(j: any) {
                sentJson = j;
                return j;
            },
        };

        await middleware({}, mockRes, () => {});

        expect(sentStatus).to.equal(504);
        expect(sentJson.error).to.equal('Request deadline exceeded');
    });
});
