import { expect } from 'chai';
import { SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import {
    injectTraceHeaders,
    recordRequestSpanAttributes,
    recordResponseSpanAttributes,
    getActiveTraceId,
} from '../src/client/trace';
import { createMockHttpServer } from '../src/testing/mock-agent';
import { httpStep } from '../src/step';

describe('@siglo/http: W3C Distributed Trace Propagation', () => {
    let mockServer: ReturnType<typeof createMockHttpServer>;

    beforeEach(() => {
        mockServer = createMockHttpServer();
    });

    afterEach(() => {
        mockServer.restore();
    });

    it('injects W3C traceparent and tracestate from span into carrier headers', () => {
        const mockSpan: any = {
            spanContext: () => ({
                traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                spanId: '00f067aa0ba902b7',
                traceFlags: 1,
                traceState: {
                    serialize: () => 'rojo=1,congo=2',
                },
            }),
        };

        const carrier: Record<string, string> = { 'x-custom': 'val' };
        injectTraceHeaders(carrier, mockSpan);

        expect(carrier['traceparent']).to.equal('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        expect(carrier['tracestate']).to.equal('rojo=1,congo=2');
        expect(carrier['x-custom']).to.equal('val');
    });

    it('handles missing or inactive span gracefully without failing', () => {
        const carrier: Record<string, string> = { 'x-foo': 'bar' };
        injectTraceHeaders(carrier, undefined);
        expect(carrier['x-foo']).to.equal('bar');
    });

    it('records semantic conventions on active span', () => {
        const attributes: Record<string, any> = {};
        let statusRecord: any = undefined;

        const mockSpan: any = {
            setAttribute: (k: string, v: any) => {
                attributes[k] = v;
            },
            setStatus: (s: any) => {
                statusRecord = s;
            },
        };

        recordRequestSpanAttributes('POST', 'https://api.stripe.com/v1/charges', 'api.stripe.com', mockSpan);
        expect(attributes['http.request.method']).to.equal('POST');
        expect(attributes['url.full']).to.equal('https://api.stripe.com/v1/charges');
        expect(attributes['server.address']).to.equal('api.stripe.com');

        recordResponseSpanAttributes(200, mockSpan);
        expect(attributes['http.response.status_code']).to.equal(200);

        recordResponseSpanAttributes(503, mockSpan);
        expect(attributes['http.response.status_code']).to.equal(503);
        expect(statusRecord?.code).to.equal(SpanStatusCode.ERROR);
    });

    it('extracts active traceId when span is present', () => {
        const mockSpan: any = {
            spanContext: () => ({
                traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
            }),
        };
        expect(getActiveTraceId(mockSpan)).to.equal('a1b2c3d4e5f60718293a4b5c6d7e8f90');
        expect(getActiveTraceId(undefined)).to.be.undefined;
    });

    it('automatically transmits trace headers in httpStep request execution', async () => {
        const mockSpan: any = {
            spanContext: () => ({
                traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                spanId: '00f067aa0ba902b7',
                traceFlags: TraceFlags.SAMPLED,
            }),
            setAttribute: () => {},
            setStatus: () => {},
        };

        const client = mockServer.get('https://api.example.com');
        client.intercept({ path: '/traced', method: 'GET' }).reply(200, { ok: true });

        const step = httpStep('tracedStep', {
            url: 'https://api.example.com/traced',
            method: 'GET',
        });

        const res = await step.execute({ span: mockSpan });
        expect(res.ok).to.be.true;
        expect(res.$httpMetadata.traceId).to.equal('4bf92f3577b34da6a3ce929d0e0e4736');
    });
});
