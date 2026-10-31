import { expect } from 'chai';
import Context from './index';
import Spec from '../spec';
import { FunctionAsValueException, InvalidJSONValueException } from './set';

describe('context.unit.test', () => {

    it('should create new context', () => {
        const context = new Context('0001');
        expect(context).to.be.not.undefined;
        expect(context.$stepId).to.equal('0001');
    });


    it("supports stackId in constructor, static createContext, and setStackId", () => {
        const ctx1 = new Context("chain_1", "stack_1");
        expect(ctx1.$stackId).to.equal("stack_1");

        ctx1.setStackId("stack_updated");
        expect(ctx1.$stackId).to.equal("stack_updated");
        expect(ctx1.getData().$stackId()).to.equal("stack_updated");

        const ctx2 = Context.createContext("chain_2", "stack_2");
        expect(ctx2.$stackId).to.equal("stack_2");
        expect(ctx2.getData().$stackId()).to.equal("stack_2");
    });

    it('should create context via static method', () => {
        const context = Context.createContext('0001_static');
        expect(context).to.be.not.undefined;
        expect(context.$stepId).to.equal('0001_static');
        expect(context.getData().$stepId()).to.equal('0001_static');
    });

    it('should set context value', () => {
        const context = new Context('0002');
        expect(context).to.be.not.undefined;
        context.set('sampleField', 'sampleValue');
        const contextData = context.getData();
        expect(contextData.sampleField).to.be.not.undefined;
        expect(contextData.sampleField()).to.be.equal('sampleValue');
    });

    it('should throw FunctionAsValueException when setting function as value', () => {
        const context = new Context('0002_fn');
        expect(() => {
            context.set('sampleField', () => 'invalid');
        }).to.throw(FunctionAsValueException);
    });

    it('instantiates InvalidJSONValueException', () => {
        const err = new InvalidJSONValueException('testVal');
        expect(err.message).to.include('testVal');
    });

    it('should add validator', () => {
        const context = new Context('0003');
        expect(context).to.be.not.undefined;
        context.set('sampleField', 'sampleValue');
        context.addSpec({ name: 'spec' });
        const contextData = context.getData();
        expect(contextData.sampleField).to.be.not.undefined;
        expect(contextData.sampleField()).to.be.equal('sampleValue');
        expect(contextData.$$$validators).to.be.not.undefined;
        expect(contextData.$$$validators()[0].name).to.be.equal('spec');
    });

    it('should validate the context values and catch errors', done => {
        const context = new Context('0004');
        const spec = new Spec('field_1');
        spec.require(true, 'Field 1 is required');
        const spec2 = new Spec('field_2');
        spec2.require(true, 'Field 2 is required');

        context.addSpec(spec);
        context.addSpec(spec2);
        context.set('field_1', 'value');
        context.runSpecs().catch(error => {
            expect(error[0].error.message).to.be.equal('Field 2 is required');
            done();
        });
    });

    it('context.validate passes when no errors', async () => {
        const context = new Context('0004_valid');
        const spec = new Spec('field_1');
        spec.validate(() => Promise.resolve(true));
        context.addSpec(spec);
        await context.validate();
    });

    it('context.validate rejects when validator fails', done => {
        const context = new Context('0004_invalid');
        const spec = new Spec('field_1');
        spec.validate(() => Promise.reject(new Error('Validation failed')));
        context.addSpec(spec);
        context.validate().catch(errors => {
            expect(errors.length).to.be.greaterThan(0);
            done();
        });
    });

    it('context.validate resolves when no validators present', async () => {
        const context = new Context('0004_empty');
        await context.validate();
    });

    it('context.runSpecs resolves when no validators present', async () => {
        const context = new Context('0004_run_empty');
        await context.runSpecs();
    });

    it('context.runSpecs handles unknown spec action by resolving', async () => {
        const context = new Context('0004_unknown_action');
        const spec: any = new Spec('field_unknown');
        spec.actions = ['custom_nonexistent_action'];
        context.addSpec(spec);
        await context.runSpecs();
    });

    it('should run specs of all fields in context', done => {
        const context = new Context('0005');
        const spec = new Spec('field_1');
        spec.default('hello');
        spec.require(true, 'field 1 is required');
        spec.transform((_currentValue) => new Promise((resolve) => {
            resolve('transformedValue');
        }));
        spec.translate((currentValue, ctx) => new Promise((resolve) => {
            ctx.set('translatedField', currentValue);
            resolve(undefined);
        }));
        spec.validate((_currentValue) => new Promise((resolve) => {
            resolve(undefined);
        }));
        context.addSpec(spec);

        context.runSpecs().then(() => {
            const { translatedField, field_1 } = context.getData();
            expect(translatedField).to.not.be.undefined;
            expect(translatedField()).to.be.equal('hello');
            expect(field_1()).to.be.equal('transformedValue');
            done();
        }).catch(error => {
            done(error);
        });
    });
});
