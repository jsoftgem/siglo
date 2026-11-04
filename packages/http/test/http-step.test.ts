import { expect } from 'chai';
import { flow, Step, ValidationException, SigloError, StepTimeoutException, CancellationException } from 'siglo';
import { httpStep, HttpStep } from '../src/step';
import { createMockHttpServer } from '../src/testing/mock-agent';
import { executeHttpRequest } from '../src/client/fetch';

describe('@siglo/http: httpStep Lifecycle & Integration Suite', () => {
  let mockServer: ReturnType<typeof createMockHttpServer>;

  beforeEach(() => {
    mockServer = createMockHttpServer();
  });

  afterEach(() => {
    mockServer.restore();
  });

  describe('Standard HTTP Requests (GET, POST, PUT, DELETE)', () => {
    it('executes GET request with query params and headers', async () => {
      mockServer.get('https://api.github.com')
        .intercept({ path: '/users?page=1&per_page=10', method: 'GET' })
        .reply(200, [{ login: 'octocat', id: 1 }]);

      const getUsers = httpStep('getUsers', {
        url: 'https://api.github.com/users',
        method: 'GET',
        query: (ctx: any) => ({
          page: ctx.page,
          per_page: 10,
          ignored: undefined
        }),
        headers: { 'User-Agent': 'Siglo-Test-Agent' }
      });

      const workflow = flow(getUsers);
      const res = await workflow.run({ page: 1 });

      expect(res.data).to.deep.equal([{ login: 'octocat', id: 1 }]);
      expect(res.$httpMetadata.status).to.equal(200);
      expect(res.$httpMetadata.method).to.equal('GET');
      expect(res.$httpMetadata.cUrl).to.include("curl -X GET 'https://api.github.com/users?page=1&per_page=10'");
    });

    it('executes POST request and merges returned JSON payload into context', async () => {
      mockServer.get('https://api.stripe.com')
        .intercept({ path: '/v1/charges', method: 'POST' })
        .reply(200, { chargeId: 'ch_999', status: 'paid', amount: 2500 });

      const chargeStep = httpStep('charge', {
        url: 'https://api.stripe.com/v1/charges',
        method: 'POST',
        headers: (ctx: any) => ({
          Authorization: `Bearer ${ctx.token}`
        }),
        body: (ctx: any) => ({
          amount: ctx.amount
        })
      });

      const nextStep = Step.create('verify', (ctx: any) => ({
        verifiedAmount: ctx.amount,
        chargeRecorded: ctx.chargeId
      }));

      const workflow = flow(chargeStep, nextStep);
      const result = await workflow.run({ amount: 2500, token: 'sk_secret_123' });

      expect(result.chargeId).to.equal('ch_999');
      expect(result.chargeRecorded).to.equal('ch_999');
      expect(result.status).to.equal('paid');
      expect(result.$httpMetadata.status).to.equal(200);
      // cURL redaction assertion
      expect(result.$httpMetadata.cUrl).to.include("Authorization: [REDACTED]");
      // Telemetry in context assertion
      expect(result.$steps?.charge?.httpMetadata?.status).to.equal(200);
    });

    it('handles 204 No Content response gracefully', async () => {
      mockServer.get('https://api.example.com')
        .intercept({ path: '/items/42', method: 'DELETE' })
        .reply(204, null);

      const deleteStep = httpStep('deleteItem', {
        url: 'https://api.example.com/items/42',
        method: 'DELETE'
      });

      const res = await deleteStep.execute({});
      expect(res.$httpMetadata.status).to.equal(204);
    });

    it('supports responseType text, blob, and arrayBuffer', async () => {
      // 1. Text with httpStep
      mockServer.get('https://api.example.com')
        .intercept({ path: '/plain', method: 'GET' })
        .reply(200, 'Hello World', { headers: { 'content-type': 'text/plain' } });

      const textStep = httpStep('getText', {
        url: 'https://api.example.com/plain',
        method: 'GET',
        responseType: 'text'
      });
      const textRes = await textStep.execute({});
      expect(textRes.data).to.equal('Hello World');

      // 2. Blob with executeHttpRequest
      mockServer.get('https://api.example.com')
        .intercept({ path: '/binary', method: 'GET' })
        .reply(200, 'binary-bytes', { headers: { 'content-type': 'application/octet-stream' } });

      const directBlobRes = await executeHttpRequest({
        stepName: 'getBlob',
        url: 'https://api.example.com/binary',
        method: 'GET',
        responseType: 'blob'
      });
      expect(directBlobRes.data).to.be.an.instanceOf(Blob);

      // 3. ArrayBuffer with executeHttpRequest
      mockServer.get('https://api.example.com')
        .intercept({ path: '/buffer', method: 'GET' })
        .reply(200, 'raw-buffer-data');

      const directBufferRes = await executeHttpRequest({
        stepName: 'getBuffer',
        url: 'https://api.example.com/buffer',
        method: 'GET',
        responseType: 'arrayBuffer'
      });
      expect(directBufferRes.data).to.be.an.instanceOf(ArrayBuffer);
    });
  });

  describe('Standard Schema & Payload Validation', () => {
    it('validates outgoing request payload with requestSchema and fails before dispatch', async () => {
      let networkCalled = false;
      mockServer.get('https://api.example.com')
        .intercept({ path: '/items', method: 'POST' })
        .reply(200, () => {
          networkCalled = true;
          return { id: 1 };
        });

      // Standard Schema mock
      const mockRequestSchema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (val: any) => {
            if (!val || typeof val.name !== 'string' || val.name.length < 3) {
              return {
                issues: [{ path: ['name'], message: 'Name must have at least 3 characters' }]
              };
            }
            return { value: val };
          }
        }
      };

      const createItem = httpStep('createItem', {
        url: 'https://api.example.com/items',
        method: 'POST',
        body: (ctx: any) => ({ name: ctx.name }),
        requestSchema: mockRequestSchema
      });

      // 1. Invalid input: should throw ValidationException
      try {
        await createItem.execute({ name: 'x' });
        expect.fail('Expected request validation to fail');
      } catch (err: any) {
        expect(err).to.be.an.instanceOf(ValidationException);
        expect(err.phase).to.equal('validation');
        expect(err.message).to.include('name: Name must have at least 3 characters');
        expect(networkCalled).to.be.false;
      }

      // 2. Valid input: should succeed
      const validRes = await createItem.execute({ name: 'Valid Item' });
      expect(validRes.id).to.equal(1);
    });

    it('validates incoming response payload with responseSchema and catches corrupt data', async () => {
      mockServer.get('https://api.example.com')
        .intercept({ path: '/product', method: 'GET' })
        .reply(200, { title: 'Book', price: 'not-a-number' }); // Corrupt price

      const safeParseSchema = {
        safeParse: (val: any) => {
          if (typeof val?.price !== 'number') {
            return {
              success: false,
              error: {
                issues: [{ path: ['price'], message: 'Price must be a number' }]
              }
            };
          }
          return { success: true, data: val };
        }
      };

      const getProduct = httpStep('getProduct', {
        url: 'https://api.example.com/product',
        method: 'GET',
        responseSchema: safeParseSchema
      });

      try {
        await getProduct.execute({});
        expect.fail('Expected response validation to fail');
      } catch (err: any) {
        expect(err).to.be.an.instanceOf(ValidationException);
        expect(err.phase).to.equal('action');
        expect(err.message).to.include('price: Price must be a number');
      }
    });
  });

  describe('Status Code Classification & Error Handling', () => {
    it('throws non-retryable SigloError on 404 by default', async () => {
      mockServer.get('https://api.example.com')
        .intercept({ path: '/missing', method: 'GET' })
        .reply(404, { error: 'Not Found' });

      const missingStep = httpStep('fetchMissing', {
        url: 'https://api.example.com/missing',
        method: 'GET'
      });

      try {
        await missingStep.execute({});
        expect.fail('Expected 404 to throw');
      } catch (err: any) {
        expect(err).to.be.an.instanceOf(SigloError);
        expect(err.status).to.equal(404);
        expect(err.retryable).to.be.false;
      }
    });

    it('returns { notFound: true, data: null } when allowNotFound is true', async () => {
      mockServer.get('https://api.example.com')
        .intercept({ path: '/optional-user/999', method: 'GET' })
        .reply(404, { error: 'User does not exist' });

      const optionalUserStep = httpStep('findUser', {
        url: 'https://api.example.com/optional-user/999',
        method: 'GET',
        allowNotFound: true
      });

      const res = await optionalUserStep.execute({});
      expect(res.notFound).to.be.true;
      expect(res.data).to.be.null;
      expect(res.$httpMetadata.status).to.equal(404);
    });

    it('fails fast on 400 Bad Request and 401 Unauthorized without retrying', async () => {
      let callCount = 0;
      mockServer.get('https://api.example.com')
        .intercept({ path: '/unauthorized', method: 'GET' })
        .reply(401, () => {
          callCount++;
          return { error: 'Unauthorized' };
        });

      const unauthStep = httpStep('unauth', {
        url: 'https://api.example.com/unauthorized',
        method: 'GET',
        maxRetries: 3
      });

      try {
        await unauthStep.execute({});
        expect.fail('Expected 401 to fail');
      } catch (err: any) {
        expect(err.status).to.equal(401);
        expect(err.retryable).to.be.false;
        expect(callCount).to.equal(1); // Fast failure without retries
      }
    });

    it('retries on 502/503/504 transient server errors up to maxRetries', async () => {
      let callCount = 0;
      const client = mockServer.get('https://api.example.com');
      // Attempt 1: 503
      client.intercept({ path: '/unstable', method: 'GET' })
        .reply(503, () => {
          callCount++;
          return { error: 'Overloaded' };
        });
      // Attempt 2: 503
      client.intercept({ path: '/unstable', method: 'GET' })
        .reply(503, () => {
          callCount++;
          return { error: 'Overloaded' };
        });
      // Attempt 3: 200 OK
      client.intercept({ path: '/unstable', method: 'GET' })
        .reply(200, () => {
          callCount++;
          return { recovered: true };
        });

      const unstableStep = httpStep('unstableStep', {
        url: 'https://api.example.com/unstable',
        method: 'GET',
        maxRetries: 3,
        sleep: async () => {} // Instant backoff in test
      });

      const res = await unstableStep.execute({});
      expect(res.recovered).to.be.true;
      expect(res.$httpMetadata.retryAttempts).to.equal(2);
      expect(callCount).to.equal(3);
    });
  });

  describe('Timeouts & Socket Abort Binding', () => {
    it('aborts socket and throws StepTimeoutException when timeoutMs fires', async () => {
      // Mock delayed response
      mockServer.get('https://api.example.com')
        .intercept({ path: '/hanging', method: 'GET' })
        .reply(200, async () => {
          await new Promise(r => setTimeout(r, 200));
          return { done: true };
        });

      const hangingStep = httpStep('hanging', {
        url: 'https://api.example.com/hanging',
        method: 'GET',
        timeoutMs: 30
      });

      try {
        await hangingStep.execute({});
        expect.fail('Expected timeout exception');
      } catch (err: any) {
        expect(err).to.be.an.instanceOf(StepTimeoutException);
        expect(err.stepName).to.equal('hanging');
      }
    });

    it('aborts request and throws CancellationException when context AbortSignal fires', async () => {
      mockServer.get('https://api.example.com')
        .intercept({ path: '/cancel-me', method: 'GET' })
        .reply(200, async () => {
          await new Promise(r => setTimeout(r, 150));
          return { done: true };
        });

      const controller = new AbortController();

      const cancelStep = httpStep('cancellable', {
        url: 'https://api.example.com/cancel-me',
        method: 'GET'
      });

      setTimeout(() => controller.abort(new DOMException('This operation was aborted', 'AbortError')), 20);

      try {
        await cancelStep.execute({}, { signal: controller.signal });
        expect.fail('Expected cancellation exception');
      } catch (err: any) {
        expect(err).to.be.an.instanceOf(CancellationException);
      }
    });
  });
});
