import { expect } from 'chai';
import { flow } from '@siglo/core';
import { maskFieldsStep, maskPatterns } from '../src';

describe('Context Redaction & Masking (maskFieldsStep)', () => {
    it('masks sensitive fields with default last4 pattern', async () => {
        const step = maskFieldsStep('sanitize', {
            fields: ['card', 'phone'],
        });

        const result = await step.execute({
            name: 'John Doe',
            card: '4111222233334444',
            phone: '1234567890',
        });

        expect(result.name).to.equal('John Doe');
        expect(result.card).to.equal('************4444');
        expect(result.phone).to.equal('******7890');
    });

    it('masks short strings with asterisks', async () => {
        const step = maskFieldsStep('sanitizeShort', {
            fields: ['pin'],
        });

        const result = await step.execute({ pin: '1234' });
        expect(result.pin).to.equal('****');
    });

    it('supports maskPatterns.redact preset', async () => {
        const step = maskFieldsStep('redactSecret', {
            fields: ['apiToken'],
            maskPattern: maskPatterns.redact,
        });

        const result = await step.execute({ apiToken: 'sk_live_secret_value_xyz' });
        expect(result.apiToken).to.equal('[REDACTED]');
    });

    it('supports maskPatterns.creditCard preset', async () => {
        const step = maskFieldsStep('maskCreditCard', {
            fields: ['card'],
            maskPattern: maskPatterns.creditCard,
        });

        const result = await step.execute({ card: '4111-2222-3333-5678' });
        expect(result.card).to.equal('****-****-****-5678');
    });

    it('supports maskPatterns.ssn preset', async () => {
        const step = maskFieldsStep('maskSsn', {
            fields: ['ssn'],
            maskPattern: maskPatterns.ssn,
        });

        const result = await step.execute({ ssn: '123-45-6789' });
        expect(result.ssn).to.equal('***-**-6789');
    });

    it('supports maskPatterns.email preset', async () => {
        const step = maskFieldsStep('maskEmail', {
            fields: ['email'],
            maskPattern: maskPatterns.email,
        });

        const result = await step.execute({ email: 'john.doe@example.com' });
        expect(result.email).to.equal('j***@example.com');
    });

    it('supports custom lambda mask pattern', async () => {
        const step = maskFieldsStep('customMask', {
            fields: ['secret'],
            maskPattern: val => `MASKED(${String(val).length})`,
        });

        const result = await step.execute({ secret: 'abracadabra' });
        expect(result.secret).to.equal('MASKED(11)');
    });

    it('runs within a multi-step flow pipeline', async () => {
        const pipeline = flow(
            maskFieldsStep('maskForDevTools', {
                fields: ['ssn'],
                maskPattern: maskPatterns.ssn,
            }),
        );

        const result = await pipeline.run({
            account: 'acc_555',
            ssn: '987-65-4321',
        });

        expect(result.account).to.equal('acc_555');
        expect(result.ssn).to.equal('***-**-4321');
    });
});
