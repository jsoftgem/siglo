import { expect } from 'chai';
import { Step, flow } from '@siglo/core';
import { sigloMiddleware, getErrorStatusCode } from './index';

describe('@siglo/hono Adapter Suite', () => {
    it('executes workflow using request input and sends response', async () => {
        const calculateTax = Step.create(async ({ subtotal }: { subtotal: number }) => ({
            total: Math.round(subtotal * 1.15),
        }));
        const taxFlow = flow(calculateTax);

        const handler = sigloMiddleware(taxFlow, {
            input: (c: any) => ({ subtotal: c.body.subtotal }),
            output: (result: any, c: any) => c.json(result, 200),
        });

        const mockContext = {
            body: { subtotal: 100 },
            headers: {} as Record<string, string>,
            header(name: string, val: string) {
                this.headers[name] = val;
            },
            req: {
                header(name: string) {
                    if (name.toLowerCase() === 'x-correlation-id') return 'corr-123';
                    return undefined;
                }
            },
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);

        expect(mockContext.statusCode).to.equal(200);
        expect(mockContext.jsonResponse.total).to.equal(115);
        expect(mockContext.headers['X-Workflow-Stack-Id']).to.be.a('string');
        expect(mockContext.headers['X-Correlation-Id']).to.equal('corr-123');
    });

    it('ignores x-namespace header by default and respects it only when allowHeaderNamespace is true', async () => {
        let capturedNamespace: string | undefined;
        const inspectStep = Step.create(async (param: any) => {
            capturedNamespace = typeof param.$namespace === 'function' ? param.$namespace() : param.$namespace;
            return { ok: true };
        });
        const testFlow = flow(inspectStep);

        const createMockContext = () => ({
            req: {
                header(name: string) {
                    if (name.toLowerCase() === 'x-namespace') return 'attacker-hono';
                    return undefined;
                }
            },
            json: (b: any) => b,
        });

        // Default: header is ignored for security
        const secureHandler = sigloMiddleware(testFlow);
        await secureHandler(createMockContext());
        expect(capturedNamespace).to.be.undefined;

        // With explicit opt-in: header is respected
        const optInHandler = sigloMiddleware(testFlow, { allowHeaderNamespace: true });
        await optInHandler(createMockContext());
        expect(capturedNamespace).to.equal('attacker-hono');
    });

    it('sanitizes internal 500 error messages when exposeErrorDetails is false', async () => {
        const failStep = Step.create(async (): Promise<any> => {
            throw new Error('Connection refused to redis://secret_auth@10.0.0.1:6379');
        });
        const handler = sigloMiddleware(flow(failStep), {
            exposeErrorDetails: false,
        });

        const mockContext = {
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);
        expect(mockContext.statusCode).to.equal(500);
        expect(mockContext.jsonResponse.error).to.equal('Internal workflow execution error');
    });

    it('maps workflow errors to error response via onError', async () => {
        const failingStep = Step.create(async (): Promise<any> => {
            throw new Error('Out of stock');
        });
        const orderFlow = flow(failingStep);

        const handler = sigloMiddleware(orderFlow, {
            onError: (err: any, c: any) => c.json({ error: err.message }, 400),
        });

        const mockContext = {
            headers: {} as Record<string, string>,
            header(name: string, val: string) {
                this.headers[name] = val;
            },
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);

        expect(mockContext.statusCode).to.equal(400);
        expect(mockContext.jsonResponse.error).to.equal('Out of stock');
    });

    it('maps default error status codes correctly without custom onError', async () => {
        const timeoutErr = new Error('Step timed out');
        timeoutErr.name = 'TimeoutException';

        const validationErr = new Error('Invalid schema');
        validationErr.name = 'SpecFailedException';

        const conflictErr = new Error('Key locked');
        conflictErr.name = 'IdempotencyConflictException';

        expect(getErrorStatusCode(timeoutErr)).to.equal(504);
        expect(getErrorStatusCode(validationErr)).to.equal(400);
        expect(getErrorStatusCode(conflictErr)).to.equal(409);
        expect(getErrorStatusCode(new Error('Internal failure'))).to.equal(500);

        const failingStep = Step.create(async (): Promise<any> => {
            throw timeoutErr;
        });
        const handler = sigloMiddleware(flow(failingStep));

        const mockContext = {
            jsonResponse: null as any,
            statusCode: 0,
            json(data: any, status = 200) {
                this.jsonResponse = data;
                this.statusCode = status;
                return { data, status };
            },
        };

        await handler(mockContext);
        expect(mockContext.statusCode).to.equal(504);
        expect(mockContext.jsonResponse.error).to.equal('Step timed out');
    });
});
