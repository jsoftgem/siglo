import { expect } from 'chai';
import { Step, flow } from 'rivulet';
import { rivuletMiddleware, getErrorStatusCode } from './index';

describe('@rivulet/hono Adapter Suite', () => {
    it('executes workflow using request input and sends response', async () => {
        const calculateTax = Step.create(async ({ subtotal }: { subtotal: number }) => ({
            total: Math.round(subtotal * 1.15),
        }));
        const taxFlow = flow(calculateTax);

        const handler = rivuletMiddleware(taxFlow, {
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

    it('maps workflow errors to error response via onError', async () => {
        const failingStep = Step.create(async (): Promise<any> => {
            throw new Error('Out of stock');
        });
        const orderFlow = flow(failingStep);

        const handler = rivuletMiddleware(orderFlow, {
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
        const handler = rivuletMiddleware(flow(failingStep));

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
