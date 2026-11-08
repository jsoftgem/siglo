import { expect } from 'chai';
import crypto from 'node:crypto';
import { FakeClock } from '@siglo/testing';
import { ValidationException } from '@siglo/core';
import { verifyWebhookStep } from '../src';

describe('Replay Attack Defense & Clock Drift Simulation', () => {
    const secret = 'whsec_replay_test_key';
    const payload = '{"event":"user.created"}';

    it('rejects webhooks with timestamp older than tolerance (301 seconds past)', async () => {
        const fixedNowMs = 1700000000000;
        const clock = new FakeClock(fixedNowMs);
        const nowSec = Math.floor(fixedNowMs / 1000);

        // Timestamp is 301 seconds in the past
        const staleTimestamp = nowSec - 301;
        const toSign = `${staleTimestamp}.${payload}`;
        const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
        const header = `t=${staleTimestamp},v1=${sig}`;

        const step = verifyWebhookStep('checkReplay', {
            provider: 'stripe',
            secret,
            payload: (ctx: any) => ctx.body,
            signature: (ctx: any) => ctx.headers['stripe-signature'],
            toleranceSeconds: 300,
            clock,
        });

        try {
            await step.execute({
                body: payload,
                headers: { 'stripe-signature': header },
            });
            expect.fail('Expected replay attack to be rejected with ValidationException');
        } catch (err: any) {
            expect(err).to.be.instanceOf(ValidationException);
            expect(err.errors[0].field).to.equal('timestamp');
            expect(err.errors[0].message).to.include('outside tolerance window');
            expect(err.phase).to.equal('action');
            expect(err.retryable).to.be.false;
        }
    });

    it('rejects webhooks with timestamp in the far future (> 300s)', async () => {
        const fixedNowMs = 1700000000000;
        const clock = new FakeClock(fixedNowMs);
        const nowSec = Math.floor(fixedNowMs / 1000);

        const futureTimestamp = nowSec + 305;
        const toSign = `${futureTimestamp}.${payload}`;
        const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
        const header = `t=${futureTimestamp},v1=${sig}`;

        const step = verifyWebhookStep('checkFutureTimestamp', {
            provider: 'stripe',
            secret,
            payload: (ctx: any) => ctx.body,
            signature: (ctx: any) => ctx.headers['stripe-signature'],
            toleranceSeconds: 300,
            clock,
        });

        try {
            await step.execute({
                body: payload,
                headers: { 'stripe-signature': header },
            });
            expect.fail('Expected future timestamp to fail');
        } catch (err: any) {
            expect(err).to.be.instanceOf(ValidationException);
            expect(err.errors[0].field).to.equal('timestamp');
        }
    });

    it('accepts webhooks with timestamp within the tolerance window (e.g. 290 seconds past)', async () => {
        const fixedNowMs = 1700000000000;
        const clock = new FakeClock(fixedNowMs);
        const nowSec = Math.floor(fixedNowMs / 1000);

        const validTimestamp = nowSec - 290;
        const toSign = `${validTimestamp}.${payload}`;
        const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
        const header = `t=${validTimestamp},v1=${sig}`;

        const step = verifyWebhookStep('checkValidTolerance', {
            provider: 'stripe',
            secret,
            payload: (ctx: any) => ctx.body,
            signature: (ctx: any) => ctx.headers['stripe-signature'],
            toleranceSeconds: 300,
            clock,
        });

        const result = await step.execute({
            body: payload,
            headers: { 'stripe-signature': header },
        });

        expect(result.webhookVerified).to.be.true;
        expect(result.verifiedAt).to.equal(validTimestamp);
    });

    it('enforces custom toleranceSeconds configuration (e.g. 60 seconds)', async () => {
        const fixedNowMs = 1700000000000;
        const clock = new FakeClock(fixedNowMs);
        const nowSec = Math.floor(fixedNowMs / 1000);

        const step = verifyWebhookStep('customTolerance', {
            provider: 'stripe',
            secret,
            payload: (ctx: any) => ctx.body,
            signature: (ctx: any) => ctx.headers['stripe-signature'],
            toleranceSeconds: 60,
            clock,
        });

        // 65 seconds in the past should fail
        const ts65 = nowSec - 65;
        const sig65 = crypto.createHmac('sha256', secret).update(`${ts65}.${payload}`).digest('hex');
        try {
            await step.execute({
                body: payload,
                headers: { 'stripe-signature': `t=${ts65},v1=${sig65}` },
            });
            expect.fail('Expected 65s drift to fail with 60s tolerance');
        } catch (err: any) {
            expect(err).to.be.instanceOf(ValidationException);
            expect(err.errors[0].field).to.equal('timestamp');
        }

        // 45 seconds in the past should succeed
        const ts45 = nowSec - 45;
        const sig45 = crypto.createHmac('sha256', secret).update(`${ts45}.${payload}`).digest('hex');
        const validRes = await step.execute({
            body: payload,
            headers: { 'stripe-signature': `t=${ts45},v1=${sig45}` },
        });
        expect(validRes.webhookVerified).to.be.true;
    });
});
