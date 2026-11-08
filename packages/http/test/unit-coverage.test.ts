import { expect } from 'chai';
import { validatePayload } from '../src/schema/validator';
import { extractHostInfo, extractStaticHostname, assertNetworkPolicy } from '../src/policy/asl-bridge';
import { createMockHttpServer } from '../src/testing/mock-agent';
import { ValidationException, SigloError } from '@siglo/core';
import { httpStep } from '../src';
import { getActiveTraceId } from '../src/client/trace';
import { executeHttpRequest } from '../src/client/fetch';

describe('@siglo/http: Unit & Branch Coverage Enhancements', () => {
    describe('Schema Validator Edge Cases', () => {
        it('returns data untouched when schema is undefined or null', async () => {
            const data = { count: 42 };
            expect(await validatePayload(undefined, data, 'validation')).to.equal(data);
            expect(await validatePayload(null, data, 'validation')).to.equal(data);
        });

        it('supports standard schema and safeParse without issue paths', async () => {
            // 1. Standard schema with issues without path
            const standardSchema = {
                '~standard': {
                    validate: async () => ({
                        issues: [{ message: 'standard issue without path' }],
                    }),
                },
            };
            try {
                await validatePayload(standardSchema, {}, 'action');
                expect.fail('Expected standard schema error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.message).to.include('$root$: standard issue without path');
            }

            // 2. safeParse with error message but no issues array
            const safeParseSimple = {
                safeParse: () => ({ success: false, error: { message: 'simple safeParse error' } }),
            };
            try {
                await validatePayload(safeParseSimple, {}, 'validation');
                expect.fail('Expected safeParse error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.message).to.include('$root$: simple safeParse error');
            }
        });

        it('supports parse() method and handles parse error', async () => {
            const schemaWithParse = {
                parse: (d: any) => {
                    if (!d.ok) throw new Error('parse error');
                    return { ...d, parsed: true };
                },
            };

            const res = await validatePayload(schemaWithParse, { ok: true }, 'validation');
            expect(res.parsed).to.be.true;

            try {
                await validatePayload(schemaWithParse, { ok: false }, 'validation');
                expect.fail('Expected parse error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.phase).to.equal('validation');
            }

            // parse() error with issues array
            const parseWithIssues = {
                parse: () => {
                    const err: any = new Error('parse fail');
                    err.issues = [{ path: ['subField'], message: 'invalid subfield' }];
                    throw err;
                },
            };
            try {
                await validatePayload(parseWithIssues, {}, 'action');
                expect.fail('Expected parse error with issues');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.message).to.include('subField: invalid subfield');
            }
        });

        it('supports validate() method (Joi/Yup style)', async () => {
            // 1. Successful validate returning value
            const validSchema = {
                validate: (d: any) => ({ value: { ...d, validated: true } }),
            };
            const res = await validatePayload(validSchema, { a: 1 }, 'action');
            expect(res.validated).to.be.true;

            // 2. Validate returning error object with details
            const errorSchema = {
                validate: () => ({ error: { details: [{ path: ['sub', 'field'], message: 'Must be positive' }] } }),
            };
            try {
                await validatePayload(errorSchema, { a: 1 }, 'action');
                expect.fail('Expected error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.message).to.include('sub.field: Must be positive');
            }

            // 3. Validate returning error object without details array
            const errorSimple = {
                validate: () => ({ error: { message: 'Simple validate error' } }),
            };
            try {
                await validatePayload(errorSimple, { a: 1 }, 'action');
                expect.fail('Expected error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
                expect(err.message).to.include('$root$: Simple validate error');
            }

            // 4. Validate throwing error
            const throwingSchema = {
                validate: () => {
                    throw new Error('Joi validation failed');
                },
            };
            try {
                await validatePayload(throwingSchema, {}, 'action');
                expect.fail('Expected error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
            }
        });

        it('supports function validator predicates and transformers', async () => {
            // 1. Function returning true
            const boolFn = (d: any) => d.val > 0;
            expect(await validatePayload(boolFn, { val: 5 }, 'validation')).to.deep.equal({ val: 5 });

            // 2. Function returning false
            try {
                await validatePayload(boolFn, { val: -1 }, 'validation');
                expect.fail('Expected validation error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(ValidationException);
            }

            // 3. Function returning transformed value
            const transformFn = (d: any) => ({ ...d, transformed: true });
            const transformed = await validatePayload(transformFn, { val: 1 }, 'validation');
            expect(transformed.transformed).to.be.true;
        });
    });

    describe('ASL Bridge Edge Cases', () => {
        it('handles non-standard URLs and host:port strings in extractHostInfo', () => {
            const info1 = extractHostInfo('localhost:8080/path');
            expect(info1.hostname).to.equal('localhost');
            expect(info1.port).to.equal('8080');

            const info2 = extractHostInfo('custom-domain/api');
            expect(info2.hostname).to.equal('custom-domain');

            // Edge cases triggering catch block in URL parsing
            const infoCatch1 = extractHostInfo('http://[::1:invalid:8080/path');
            expect(infoCatch1.port).to.equal('8080');

            const infoCatch2 = extractHostInfo('http://[::1:invalid/path');
            expect(infoCatch2.hostname).to.equal('[::1');
        });

        it('extractStaticHostname handles non-strings and invalid URLs', () => {
            expect(extractStaticHostname(() => 'https://example.com')).to.be.undefined;
            expect(extractStaticHostname(12345)).to.be.undefined;
            expect(extractStaticHostname('not a valid url ^^^')).to.be.undefined;
        });

        it('assertNetworkPolicy ignores when active policy is disabled', () => {
            expect(() => {
                assertNetworkPolicy('step', 'https://example.com', 'example.com', undefined, { enabled: false });
            }).to.not.throw();
        });
    });

    describe('W3C Trace & Step Lifecycle Edge Cases', () => {
        it('extracts traceId from span with traceId property or catches throwing spanContext', () => {
            expect(getActiveTraceId({ traceId: 'direct-trace-id' })).to.equal('direct-trace-id');
            expect(
                getActiveTraceId({
                    spanContext: () => {
                        throw new Error('context fail');
                    },
                }),
            ).to.be.undefined;
        });

        it('executes onAfter handler with mutable context and gracefully handles throwing context', async () => {
            const step = httpStep('enrichStep', { url: 'https://api.example.com/test' });

            // 1. Mutable context enrichment
            const mutableCtx: any = {};
            const output = { $httpMetadata: { status: 200 } };
            await (step as any).onafter(output, mutableCtx);
            expect(mutableCtx.$steps?.enrichStep?.httpMetadata?.status).to.equal(200);

            // 2. Context with throwing getter
            const throwingCtx: any = {
                get $steps() {
                    throw new Error('context property error');
                },
            };
            const res = await (step as any).onafter(output, throwingCtx);
            expect(res).to.equal(output);
        });
    });

    describe('MockHttpServer & Fetch Transport Edge Cases', () => {
        it('supports regex paths, assertDone, reset, and enableNetConnect', () => {
            const server = createMockHttpServer();

            server.intercept({ url: /https:\/\/test\.com\/items\/\d+/, method: 'GET' }).reply(200, { matched: true });

            expect(server.isDone()).to.be.false;

            expect(() => server.assertDone()).to.throw(/pending mock rule/);

            server.reset();
            expect(server.isDone()).to.be.true;

            server.enableNetConnect();
            server.disableNetConnect();

            server.close();
        });

        it('handles async response body and signal abort after body resolution in mock server', async () => {
            const server = createMockHttpServer();

            // 1. Async response body without signal
            server
                .get('https://async-test.com')
                .intercept({ path: '/async' })
                .reply(200, async () => ({ value: 999 }));
            const r1 = await fetch('https://async-test.com/async');
            expect(await r1.json()).to.deep.equal({ value: 999 });

            // 2. Abort signal triggered during body generation
            const controller = new AbortController();
            server
                .get('https://async-test.com')
                .intercept({ path: '/abort-inside' })
                .reply(200, () => {
                    controller.abort();
                    return { value: 1 };
                });

            try {
                await fetch('https://async-test.com/abort-inside', { signal: controller.signal });
                expect.fail('Expected abort error');
            } catch (err: any) {
                expect(err.name).to.equal('AbortError');
            }

            server.close();
        });

        it('handles externalSignal cleanup, transient network retries, and retry exhaustion in executeHttpRequest', async () => {
            const server = createMockHttpServer();

            // 1. External signal cleanup on success
            server.get('https://fetch-edge.com').intercept({ path: '/sig-ok' }).reply(200, { ok: true });
            const extController = new AbortController();
            const resOk = await executeHttpRequest({
                stepName: 'sigStep',
                url: 'https://fetch-edge.com/sig-ok',
                method: 'GET',
                signal: extController.signal,
            });
            expect(resOk.data).to.deep.equal({ ok: true });

            // 2. Retryable status (502) exhaustion
            server.get('https://fetch-edge.com').intercept({ path: '/502' }).reply(502, 'Service Down').times(2);
            try {
                await executeHttpRequest({
                    stepName: 'exhaust502Step',
                    url: 'https://fetch-edge.com/502',
                    method: 'GET',
                    maxRetries: 1,
                    retryOnStatus: [502],
                    sleep: () => Promise.resolve(),
                });
                expect.fail('Expected 502 exhaustion error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(SigloError);
                expect(err.message).to.include('HTTP 502');
            }

            // 3. Transient network error retry then success
            const econnErr: any = new Error('socket hang up');
            econnErr.code = 'ECONNRESET';
            server.get('https://fetch-edge.com').intercept({ path: '/econn' }).replyWithError(econnErr);
            server.get('https://fetch-edge.com').intercept({ path: '/econn' }).reply(200, { recovered: true });

            const resRec = await executeHttpRequest({
                stepName: 'recStep',
                url: 'https://fetch-edge.com/econn',
                method: 'GET',
                maxRetries: 2,
                sleep: () => Promise.resolve(),
            });
            expect(resRec.data).to.deep.equal({ recovered: true });

            // 4. Network error fatal when maxRetries is 0
            server.get('https://fetch-edge.com').intercept({ path: '/fatal-net' }).replyWithError(econnErr);
            try {
                await executeHttpRequest({
                    stepName: 'fatalNetStep',
                    url: 'https://fetch-edge.com/fatal-net',
                    method: 'GET',
                    maxRetries: 0,
                });
                expect.fail('Expected fatal network error');
            } catch (err: any) {
                expect(err).to.be.an.instanceOf(SigloError);
                expect(err.message).to.include('socket hang up');
            }

            server.close();
        });
    });
});
