import { expect } from 'chai';
import {
  parseRetryAfter,
  isRetryableStatus,
  isTransientNetworkError,
  calculateBackoffDelay,
  DEFAULT_RETRY_STATUSES
} from '../src/client/retry';
import { FakeClock } from '@siglo/testing';
import { createMockHttpServer } from '../src/testing/mock-agent';
import { executeHttpRequest } from '../src/client/fetch';

describe('@siglo/http: Retry-After & Status Classifier', () => {
  let mockServer: ReturnType<typeof createMockHttpServer>;

  beforeEach(() => {
    mockServer = createMockHttpServer();
  });

  afterEach(() => {
    mockServer.restore();
  });

  describe('parseRetryAfter', () => {
    it('parses integer and decimal seconds into milliseconds', () => {
      expect(parseRetryAfter('120')).to.equal(120000);
      expect(parseRetryAfter('0')).to.equal(0);
      expect(parseRetryAfter('60')).to.equal(60000);
      expect(parseRetryAfter('1.5')).to.equal(1500);
      expect(parseRetryAfter('   30   ')).to.equal(30000);
    });

    it('parses RFC 1123 HTTP Date strings relative to clock', () => {
      const fixedTime = Date.parse('Wed, 21 Oct 2026 07:20:00 GMT');
      const fakeClock = new FakeClock(fixedTime);

      const targetHeader = 'Wed, 21 Oct 2026 07:21:00 GMT'; // 60 seconds later
      const delay = parseRetryAfter(targetHeader, () => fakeClock.now());
      expect(delay).to.equal(60000);
    });

    it('returns 0 for HTTP dates in the past', () => {
      const fixedTime = Date.parse('Wed, 21 Oct 2026 07:20:00 GMT');
      const fakeClock = new FakeClock(fixedTime);

      const pastHeader = 'Wed, 21 Oct 2026 07:10:00 GMT'; // 10 minutes ago
      const delay = parseRetryAfter(pastHeader, () => fakeClock.now());
      expect(delay).to.equal(0);
    });

    it('returns undefined for invalid, null, or empty values', () => {
      expect(parseRetryAfter(null)).to.be.undefined;
      expect(parseRetryAfter(undefined)).to.be.undefined;
      expect(parseRetryAfter('')).to.be.undefined;
      expect(parseRetryAfter('   ')).to.be.undefined;
      expect(parseRetryAfter('invalid-header')).to.be.undefined;
      expect(parseRetryAfter('-10')).to.be.undefined;
    });
  });

  describe('isRetryableStatus & Status Classifier', () => {
    it('classifies default transient status codes as retryable', () => {
      expect(DEFAULT_RETRY_STATUSES).to.deep.equal([429, 502, 503, 504]);
      expect(isRetryableStatus(429)).to.be.true;
      expect(isRetryableStatus(502)).to.be.true;
      expect(isRetryableStatus(503)).to.be.true;
      expect(isRetryableStatus(504)).to.be.true;
    });

    it('classifies fatal client errors and non-retryable server errors as false', () => {
      expect(isRetryableStatus(200)).to.be.false;
      expect(isRetryableStatus(201)).to.be.false;
      expect(isRetryableStatus(400)).to.be.false;
      expect(isRetryableStatus(401)).to.be.false;
      expect(isRetryableStatus(403)).to.be.false;
      expect(isRetryableStatus(404)).to.be.false;
      expect(isRetryableStatus(422)).to.be.false;
      expect(isRetryableStatus(500)).to.be.false;
    });

    it('supports custom retryOnStatus overrides', () => {
      const custom = [500, 503];
      expect(isRetryableStatus(500, custom)).to.be.true;
      expect(isRetryableStatus(429, custom)).to.be.false;
    });
  });

  describe('isTransientNetworkError', () => {
    it('identifies network transport error codes and messages', () => {
      expect(isTransientNetworkError({ code: 'ECONNRESET' })).to.be.true;
      expect(isTransientNetworkError({ code: 'ETIMEDOUT' })).to.be.true;
      expect(isTransientNetworkError({ code: 'EAI_AGAIN' })).to.be.true;
      expect(isTransientNetworkError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).to.be.true;
      expect(isTransientNetworkError(new Error('TypeError: fetch failed'))).to.be.true;
      expect(isTransientNetworkError(new Error('socket hung up'))).to.be.true;
      expect(isTransientNetworkError(new Error('SyntaxError: unexpected token'))).to.be.false;
      expect(isTransientNetworkError(null)).to.be.false;
    });
  });

  describe('calculateBackoffDelay', () => {
    it('returns positive delay capped at maxDelay', () => {
      for (let i = 0; i < 5; i++) {
        const delay = calculateBackoffDelay(i, 50, 500);
        expect(delay).to.be.at.least(0);
        expect(delay).to.be.at.most(500);
      }
    });
  });

  describe('FakeClock Retry Testing', () => {
    it('fast-forwards Retry-After: 60 headers instantly without waiting real seconds', async () => {
      const fakeClock = new FakeClock();
      let sleepCalls: number[] = [];

      const customSleep = async (ms: number) => {
        sleepCalls.push(ms);
        fakeClock.advanceTime(ms);
      };

      const client = mockServer.get('https://api.test.com');
      // First attempt: 429 with Retry-After: 60
      client.intercept({ path: '/rate-limited', method: 'GET' })
        .reply(429, { error: 'slow down' }, { headers: { 'retry-after': '60' } });
      // Second attempt: 200 OK
      client.intercept({ path: '/rate-limited', method: 'GET' })
        .reply(200, { success: true });

      const res = await executeHttpRequest({
        stepName: 'testRateLimit',
        url: 'https://api.test.com/rate-limited',
        method: 'GET',
        clock: fakeClock,
        sleep: customSleep,
        maxRetries: 2
      });

      expect(res.data).to.deep.equal({ success: true });
      expect(res.metadata.retryAttempts).to.equal(1);
      expect(sleepCalls).to.deep.equal([60000]);
      expect(fakeClock.now()).to.be.at.least(60000);
    });
  });
});
