import { expect } from 'chai';
import {
    sanitizeOriginUrl,
    formatOriginCurl,
    sanitizeTelemetryInspection,
    sanitizeTelemetryEnvelope,
    sanitizeTelemetryDocument,
    matchTelemetryRecord,
    EcosystemTelemetryEnvelope,
} from '../src';

describe('Milestone 4: Ecosystem Telemetry & Fail-Closed Sanitization', () => {
    describe('sanitizeOriginUrl & formatOriginCurl', () => {
        it('sanitizes full URLs to origin only, stripping paths, credentials and query parameters', () => {
            const raw = 'https://api.stripe.com/v1/charges?key=secret_123#frag';
            expect(sanitizeOriginUrl(raw)).to.equal('https://api.stripe.com');

            const withPort = 'http://localhost:8080/api/v1/resource';
            expect(sanitizeOriginUrl(withPort)).to.equal('http://localhost:8080');

            expect(sanitizeOriginUrl('not-a-url')).to.be.undefined;
            expect(sanitizeOriginUrl(undefined)).to.be.undefined;
        });

        it('formats sanitized origin-only curl commands', () => {
            const curl = formatOriginCurl('POST', 'https://api.stripe.com/v1/charges?key=supersecret');
            expect(curl).to.equal('curl -X POST https://api.stripe.com');
            expect(curl).not.to.include('/v1/charges');
            expect(curl).not.to.include('supersecret');
        });
    });

    describe('sanitizeTelemetryInspection (Fail-Closed)', () => {
        it('sanitizes HTTP telemetry records and strips sensitive payload data', () => {
            const raw = {
                version: 1,
                kind: 'http',
                outcome: 'success',
                durationMs: 142.5,
                method: 'post',
                url: 'https://api.stripe.com/v1/charges?token=sensitive_token',
                status: 200,
                retryAttempts: 2,
                retryDelayMs: 500,
                retryAfterMs: 1000,
                retryDelaySource: 'retry-after',
                policy: 'allowed',
                sensitiveHeader: 'Bearer xyz', // must be omitted!
                body: { card: '4111111111111111' }, // must be omitted!
            };

            const clean = sanitizeTelemetryInspection(raw) as any;
            expect(clean).to.exist;
            expect(clean.version).to.equal(1);
            expect(clean.kind).to.equal('http');
            expect(clean.outcome).to.equal('success');
            expect(clean.method).to.equal('POST');
            expect(clean.url).to.equal('https://api.stripe.com');
            expect(clean.status).to.equal(200);
            expect(clean.retryAttempts).to.equal(2);
            expect(clean.retryDelayMs).to.equal(500);
            expect(clean.retryAfterMs).to.equal(1000);
            expect(clean.retryDelaySource).to.equal('retry-after');
            expect(clean.policy).to.equal('allowed');
            expect(clean.durationMs).to.equal(142.5);
            expect(clean.sensitiveHeader).to.be.undefined;
            expect(clean.body).to.be.undefined;
        });

        it('sanitizes Crypto telemetry records without exposing secrets or raw signatures', () => {
            const raw = {
                version: 1,
                kind: 'crypto',
                outcome: 'failure',
                provider: 'stripe',
                category: 'timestamp-rejected',
                timestampCheck: 'failed',
                replayCheck: 'passed',
                payloadBytes: 1024,
                rawSignature: 't=123,v1=abcdef', // forbidden
                secretKey: 'whsec_test', // forbidden
            };

            const clean = sanitizeTelemetryInspection(raw) as any;
            expect(clean).to.exist;
            expect(clean.kind).to.equal('crypto');
            expect(clean.provider).to.equal('stripe');
            expect(clean.category).to.equal('timestamp-rejected');
            expect(clean.timestampCheck).to.equal('failed');
            expect(clean.replayCheck).to.equal('passed');
            expect(clean.payloadBytes).to.equal(1024);
            expect(clean.rawSignature).to.be.undefined;
            expect(clean.secretKey).to.be.undefined;
        });

        it('sanitizes Notification telemetry and bounds preview content safely', () => {
            const raw = {
                version: 1,
                kind: 'notification',
                outcome: 'success',
                channel: 'email',
                approval: true,
                approvalState: 'approved',
                approvalExpiresAt: 1731330000000,
                tokenStatus: 'issued',
                contentPreview: {
                    subject: 'Order Confirmation #1234',
                    bodySnippet: 'Thank you for your purchase...',
                    recipientMasked: 'u***@example.com',
                },
            };

            const clean = sanitizeTelemetryInspection(raw) as any;
            expect(clean).to.exist;
            expect(clean.channel).to.equal('email');
            expect(clean.approval).to.be.true;
            expect(clean.approvalState).to.equal('approved');
            expect(clean.tokenStatus).to.equal('issued');
            expect(clean.contentPreview.subject).to.equal('Order Confirmation #1234');
            expect(clean.contentPreview.recipientMasked).to.equal('u***@example.com');
        });

        it('sanitizes AI telemetry including tokens, repair attempts, and fallback counts', () => {
            const raw = {
                version: 1,
                kind: 'ai',
                outcome: 'success',
                provider: 'openai',
                model: 'gpt-4o',
                promptTokens: 150,
                completionTokens: 42,
                totalTokens: 192,
                estimatedCostUsd: 0.0025,
                repairAttempts: 1,
                fallbackCount: 0,
            };

            const clean = sanitizeTelemetryInspection(raw) as any;
            expect(clean).to.exist;
            expect(clean.provider).to.equal('openai');
            expect(clean.model).to.equal('gpt-4o');
            expect(clean.promptTokens).to.equal(150);
            expect(clean.completionTokens).to.equal(42);
            expect(clean.totalTokens).to.equal(192);
            expect(clean.estimatedCostUsd).to.equal(0.0025);
            expect(clean.repairAttempts).to.equal(1);
        });

        it('rejects unsupported versions or invalid kind/outcome fail-closed', () => {
            expect(sanitizeTelemetryInspection({ version: 2, kind: 'http', outcome: 'success' })).to.be.undefined;
            expect(sanitizeTelemetryInspection({ version: 1, kind: 'unknown', outcome: 'success' })).to.be.undefined;
            expect(sanitizeTelemetryInspection({ version: 1, kind: 'http', outcome: 'pending' })).to.be.undefined;
            expect(sanitizeTelemetryInspection(null)).to.be.undefined;
        });
    });

    describe('sanitizeTelemetryEnvelope & sanitizeTelemetryDocument', () => {
        it('validates envelope requirements and drops malformed envelopes', () => {
            const valid = {
                version: 1,
                workflowName: 'orderFlow',
                workflowVersion: 2,
                stepIdentity: 'chargeCard',
                attempt: 1,
                timestamp: '2026-11-11T12:00:00Z',
                inspection: {
                    version: 1,
                    kind: 'http',
                    outcome: 'success',
                    status: 200,
                },
            };

            const envelope = sanitizeTelemetryEnvelope(valid);
            expect(envelope).to.exist;
            expect(envelope?.workflowName).to.equal('orderFlow');
            expect(envelope?.stepIdentity).to.equal('chargeCard');
            expect(envelope?.attempt).to.equal(1);

            // Rejects empty workflowName
            expect(sanitizeTelemetryEnvelope({ ...valid, workflowName: '   ' })).to.be.undefined;
            // Rejects empty stepIdentity
            expect(sanitizeTelemetryEnvelope({ ...valid, stepIdentity: '' })).to.be.undefined;
            // Rejects invalid version
            expect(sanitizeTelemetryEnvelope({ ...valid, version: 99 })).to.be.undefined;
        });

        it('parses valid document or array of records, returning TelemetryRecordingDocument', () => {
            const records = [
                {
                    version: 1,
                    workflowName: 'orderFlow',
                    stepIdentity: 'chargeCard',
                    inspection: { version: 1, kind: 'http', outcome: 'success', status: 200 },
                },
                {
                    version: 1,
                    workflowName: 'orderFlow',
                    stepIdentity: 'analyzeFraud',
                    inspection: { version: 1, kind: 'ai', outcome: 'success', promptTokens: 100 },
                },
                {
                    version: 1,
                    workflowName: '', // invalid, should be filtered
                    stepIdentity: 'broken',
                    inspection: { version: 1, kind: 'http', outcome: 'success' },
                },
            ];

            const doc = sanitizeTelemetryDocument({ version: 1, records }, 'order-run.json');
            expect(doc).to.exist;
            expect(doc?.fileName).to.equal('order-run.json');
            expect(doc?.records).to.have.length(2);
            expect(doc?.records[0].stepIdentity).to.equal('chargeCard');
            expect(doc?.records[1].stepIdentity).to.equal('analyzeFraud');
        });
    });

    describe('matchTelemetryRecord (Source Matching)', () => {
        const record: EcosystemTelemetryEnvelope = {
            version: 1,
            workflowName: 'checkoutWorkflow',
            workflowVersion: '1.0.0',
            stepIdentity: 'step_chargeStripe_L10_C2',
            inspection: {
                version: 1,
                kind: 'http',
                outcome: 'success',
                status: 200,
            },
        };

        it('matches unambiguously by workflow name, version, and step id', () => {
            expect(matchTelemetryRecord(record, 'checkoutWorkflow', '1.0.0', 'step_chargeStripe_L10_C2', 'chargeStripe')).to.be.true;
        });

        it('matches by step name if stepIdentity equals step name', () => {
            const nameRecord = { ...record, stepIdentity: 'chargeStripe' };
            expect(matchTelemetryRecord(nameRecord, 'checkoutWorkflow', '1.0.0', 'some_ast_id', 'chargeStripe')).to.be.true;
        });

        it('rejects mismatch on workflow name', () => {
            expect(matchTelemetryRecord(record, 'otherWorkflow', '1.0.0', 'step_chargeStripe_L10_C2')).to.be.false;
        });

        it('rejects mismatch on workflow version', () => {
            expect(matchTelemetryRecord(record, 'checkoutWorkflow', '2.0.0', 'step_chargeStripe_L10_C2')).to.be.false;
        });

        it('rejects mismatch on step identity', () => {
            expect(matchTelemetryRecord(record, 'checkoutWorkflow', '1.0.0', 'different_step', 'otherName')).to.be.false;
        });
    });
});
