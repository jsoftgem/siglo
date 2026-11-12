import { expect } from 'chai';
import { parseWorkflowFile } from '../src/parser';

describe('Milestone 2: Static Diagnostics', () => {
    it('warns on cyclic dependencies in DAG topology (SIGLO_STATIC_CYCLE)', () => {
        // Constructing a cycle: stepA -> stepB -> stepA
        const content = `
            import { flow, Step } from '@siglo/core';
            const stepA = Step.create('stepA', () => {});
            const stepB = Step.create('stepB', () => {});
            const flowWithCycle = flow(stepA).then(stepB).then(stepA);
        `;
        const doc = parseWorkflowFile({ uri: '/cyclic.ts', content });
        expect(doc.diagnostics.length).to.be.greaterThan(0);
        const cycleDiags = doc.diagnostics.filter(d => d.code === 'SIGLO_STATIC_CYCLE');
        expect(cycleDiags.length).to.be.greaterThan(0);
        expect(cycleDiags[0].severity).to.equal('warning');
        expect(cycleDiags[0].message).to.include('Cyclic workflow dependency detected');
        expect(cycleDiags[0].range.start.line).to.be.at.least(0);
    });

    it('warns on missing compensations for sagas with side-effect steps (SIGLO_MISSING_COMPENSATION)', () => {
        const content = `
            import { flow, Step } from '@siglo/core';
            import { httpStep } from '@siglo/http';
            import { encryptFieldsStep } from '@siglo/crypto';

            const stepFetch = Step.create('fetchUser', () => {});
            const chargeCard = httpStep('chargeCard', { method: 'POST', url: 'https://api.stripe.com/charges' });
            const encryptPayload = encryptFieldsStep('encryptPayload', { fields: ['cardNumber'] });
            const refundStep = Step.create('refund', () => {});

            // In this saga flow, chargeCard has compensation attached, but encryptPayload does not!
            export const paymentSaga = flow('paymentSaga')
                .then(stepFetch)
                .then(chargeCard)
                .compensate(refundStep)
                .then(encryptPayload);
        `;
        const doc = parseWorkflowFile({ uri: '/saga.ts', content });
        const compDiags = doc.diagnostics.filter(d => d.code === 'SIGLO_MISSING_COMPENSATION');
        expect(compDiags).to.have.lengthOf(1);
        expect(compDiags[0].message).to.include('encryptPayload');
        expect(compDiags[0].message).to.include('without a registered compensation step');
        expect(compDiags[0].severity).to.equal('warning');
        expect(compDiags[0].fixAvailable).to.be.true;
    });

    it('warns on unhandled error branches in durable workflows (SIGLO_UNHANDLED_ERROR_BRANCH)', () => {
        // Durable workflow with a branch that lacks a default/fallback branch
        const content = `
            import { flow, Step, waitForEvent, branch } from '@siglo/core';

            const awaitApproval = waitForEvent('order.approved', { timeout: '24h' });
            const ship = Step.create('shipOrder', () => {});
            const expedite = Step.create('expediteOrder', () => {});

            // Branch has only specific cases but NO default fallback in durable flow!
            const branchStep = branch(ctx => ctx.priority, {
                HIGH: expedite,
                NORMAL: ship,
            });

            export const durableFulfillment = flow('durableFulfillment', awaitApproval, branchStep);
        `;
        const doc = parseWorkflowFile({ uri: '/durable.ts', content });
        const durableDiags = doc.diagnostics.filter(d => d.code === 'SIGLO_UNHANDLED_ERROR_BRANCH');
        expect(durableDiags.length).to.be.greaterThan(0);
        expect(durableDiags[0].severity).to.equal('warning');
        expect(durableDiags[0].message).to.include('unhandled error/default branch');
    });

    it('flags duplicate step IDs within the same workflow (SIGLO_DUPLICATE_STEP_ID)', () => {
        const content = `
            import { flow, Step } from '@siglo/core';

            const stepA1 = Step.create('validateCustomer', () => {});
            const stepA2 = Step.create('validateCustomer', () => {});
            const stepB = Step.create('processOrder', () => {});

            export const duplicateFlow = flow('duplicateFlow', stepA1, stepA2, stepB);
        `;
        const doc = parseWorkflowFile({ uri: '/duplicate.ts', content });
        const dupDiags = doc.diagnostics.filter(d => d.code === 'SIGLO_DUPLICATE_STEP_ID');
        expect(dupDiags).to.have.lengthOf(2);
        expect(dupDiags[0].severity).to.equal('error');
        expect(dupDiags[0].message).to.equal('Duplicate step ID detected: "validateCustomer"');
        expect(dupDiags[1].message).to.equal('Duplicate step ID detected: "validateCustomer"');
        expect(dupDiags[0].range.start.line).to.not.equal(dupDiags[1].range.start.line);
    });

    it('validates that clean workflows have zero diagnostics', () => {
        const content = `
            import { flow, Step } from '@siglo/core';
            const a = Step.create('stepA', () => {});
            const b = Step.create('stepB', () => {});
            export const cleanFlow = flow('cleanFlow', a, b);
        `;
        const doc = parseWorkflowFile({ uri: '/clean.ts', content });
        expect(doc.diagnostics).to.have.lengthOf(0);
    });
});
