import { expect } from 'chai';
import { Step, flow, waitForEvent, wait, clearStorage, defaultDurableManager } from '@siglo/core';
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


describe('@siglo/express durable HTTP responses', () => {
    beforeEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    afterEach(() => {
        clearStorage();
        defaultDurableManager.clear();
    });

    function responseHarness() {
        const response = {
            statusCode: 200,
            body: undefined as any,
            headers: {} as Record<string, string>,
            header(name: string, value: string) { this.headers[name] = value; },
            setHeader(name: string, value: string) { this.headers[name] = value; },
            status(code: number) { this.statusCode = code; return this; },
            json(body: any, status?: number) {
                if (status !== undefined) this.statusCode = status;
                this.body = body;
                return body;
            },
            send(body: any) { this.body = body; return body; },
        };
        return {
            response,
            async invoke(handler: any) {
                return handler({ body: {}, headers: {} }, response, (err?: any) => { if (err) throw err; });
            },
        };
    }

    for (const kind of ['event', 'timer']) {
        it(`returns 202 and the suspension descriptor for a durable ${kind} wait`, async () => {
            let continued = false;
            let errorHandled = false;
            const waitStep = kind === 'event'
                ? waitForEvent('approval', { correlationKey: 'order-202', timeout: '1h' })
                : wait('1h');
            const workflow = flow(waitStep, Step.create(() => { continued = true; return { done: true }; }));
            const { response, invoke } = responseHarness();
            const result = await invoke(sigloExpressMiddleware(workflow, {
                durable: true,
                onError: () => { errorHandled = true; },
            }));

            expect(response.statusCode).to.equal(202);
            expect(result.status).to.equal('waiting');
            expect(result.stackId).to.equal(response.headers['X-Workflow-Stack-Id']);
            expect(result.stackId).to.be.a('string');
            expect(result.correlationKey).to.be.a('string');
            expect(result.expiresAt).to.be.a('number');
            expect(continued).to.equal(false);
            expect(errorHandled).to.equal(false);
        });
    }

    for (const enabled of [true, false, undefined]) {
        it(`resolves per-request durable=${enabled} and preserves 200 for non-durable waits`, async () => {
            const { response, invoke } = responseHarness();
            const workflow = flow(waitForEvent('approval', { correlationKey: 'order-option' }));
            let requestSeen: any;
            const result = await invoke(sigloExpressMiddleware(workflow, {
                durable: enabled === undefined ? undefined : (request: any) => {
                    requestSeen = request;
                    return enabled;
                },
            }));
            if (enabled !== undefined) expect(requestSeen).to.exist;
            expect(response.statusCode).to.equal(enabled ? 202 : 200);
            if (enabled) expect(result.status).to.equal('waiting');
            else expect(result.waited).to.equal(true);
        });
    }

    it('leaves the response status under custom output control for a waiting workflow', async () => {
        const { response, invoke } = responseHarness();
        const result = await invoke(sigloExpressMiddleware(flow(waitForEvent('approval', { correlationKey: 'order-custom' })), {
            durable: true,
            output: (result: any, res: any) => res.status(201).json(result),
        }));
        expect(response.statusCode).to.equal(201);
        expect(result.status).to.equal('waiting');
    });

    it('returns 200 when a durable workflow completes without waiting', async () => {
        const { response, invoke } = responseHarness();
        const result = await invoke(sigloExpressMiddleware(flow(Step.create(() => ({ done: true }))), { durable: true }));
        expect(response.statusCode).to.equal(200);
        expect(result.done).to.equal(true);
    });
});
