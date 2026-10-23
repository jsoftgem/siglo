import Context from '../context';
import Spec from './index';
import { SpecFailedException } from './SpecFailedException';
import { expect } from 'chai';

describe('spec.unit.test', () => {

    it('should create spec with field name', () => {
        const spec = new Spec('fieldName');
        expect(spec).to.be.not.undefined;
        expect(spec.field).to.be.not.undefined;
        expect(spec.field).to.be.equal('fieldName');
    });

    it('should throw an error if field name is not specified', () => {
        expect(() => {
            new (Spec as any)();
        }).to.throw('Field name is required.');
    });

    it('should add spec actions', () => {
        const spec = new Spec('field');
        spec.require(true);
        expect(spec.actions[0]).to.be.equal('require');
        spec.transform();
        expect(spec.actions[1]).to.be.equal('transform');
        spec.translate();
        expect(spec.actions[2]).to.be.equal('translate');
        spec.default('hello');
        expect(spec.actions[3]).to.be.equal('default');
        spec.validate();
        expect(spec.actions[4]).to.be.equal('validate');
        spec.schema({});
        expect(spec.actions[5]).to.be.equal('schema');
    });

    it('should set a custom validator', done => {
        const context = new Context('_chained00');
        const spec = new Spec('validationField');
        spec.validate((currentValue: any) => new Promise((resolve, reject) => {
            if (currentValue > 0) {
                resolve(undefined);
            } else {
                reject('Value must be greater than 0');
            }
        }));
        context.set('validationField', 0);
        spec.runValidation(context)
            .catch(error => {
                expect(error.error).to.be.equal('Value must be greater than 0');
                done();
            });
    });

    it('runValidation resolves when validator resolves', async () => {
        const context = new Context('_chained00_pass');
        const spec = new Spec('passField');
        spec.validate((val: any) => Promise.resolve(val));
        context.set('passField', 'ok');
        await spec.runValidation(context);
    });

    it('runValidation resolves when validator is not set', async () => {
        const context = new Context('_chained00_noval');
        const spec = new Spec('noValField');
        await spec.runValidation(context);
    });

    it('should set context field default value', async () => {
        const context = new Context('_chained01');
        const spec = new Spec('defaultField');
        spec.default('defaultValue');
        context.addSpec(spec);
        await spec.runDefault(context);
        expect(context.getData()['defaultField']).to.be.not.undefined;
        expect(context.getData()['defaultField']()).to.be.equal('defaultValue');
    });

    it('runDefault does not overwrite existing value', async () => {
        const context = new Context('_chained01_exist');
        context.set('existingField', 'alreadySet');
        const spec = new Spec('existingField');
        spec.default('defaultValue');
        await spec.runDefault(context);
        expect(context.getData()['existingField']()).to.equal('alreadySet');
    });

    it('runDefault rejects when context throws', done => {
        const mockContext = {
            getData: () => { throw new Error('Context error'); },
            set: () => {}
        };
        const spec = new Spec('errField');
        spec.default('def');
        spec.runDefault(mockContext).catch(err => {
            expect(err.error.message).to.equal('Context error');
            done();
        });
    });

    it('should asynchronously change the field value', done => {
        const context = new Context('_chained02');
        const spec = new Spec('transformThisField');
        context.set('transformThisField', 'Hello world!');
        spec.transform(_currentValue => new Promise(resolve => {
            resolve('hello');
        }));
        spec.runTransform(context)
            .then(() => {
                expect(context.getData()['transformThisField']()).to.be.equal('hello');
                done();
            });
    });

    it('runTransform resolves when transformer is not set or field is missing', async () => {
        const context = new Context('_chained02_empty');
        const spec = new Spec('missingField');
        await spec.runTransform(context);

        spec.transform(() => Promise.resolve('val'));
        await spec.runTransform(context);
    });

    it('runTransform rejects when transformer fails', done => {
        const context = new Context('_chained02_err');
        context.set('errField', 'abc');
        const spec = new Spec('errField');
        spec.transform(() => Promise.reject(new Error('Transform error')));
        spec.runTransform(context).catch(err => {
            expect(err.error.message).to.equal('Transform error');
            done();
        });
    });

    it('should asynchronously translate the field value', done => {
        const context = new Context('_chained03');
        const spec = new Spec('translateThisField');
        context.set('translateThisField', 'Hello world!');
        spec.translate((_currentValue, ctx) => new Promise(resolve => {
            ctx.set('hello', 'hello');
            ctx.set('world', 'world');
            resolve(undefined);
        }));
        spec.runTranslate(context)
            .then(() => {
                expect(context.getData()['hello']()).to.be.equal('hello');
                expect(context.getData()['world']()).to.be.equal('world');
                done();
            });
    });

    it('runTranslate resolves when translator is not set or field is missing', async () => {
        const context = new Context('_chained03_empty');
        const spec = new Spec('missingField');
        await spec.runTranslate(context);

        spec.translate((_val, _ctx) => Promise.resolve());
        await spec.runTranslate(context);
    });

    it('runTranslate rejects when translator fails', done => {
        const context = new Context('_chained03_err');
        context.set('errField', 'abc');
        const spec = new Spec('errField');
        spec.translate(() => Promise.reject(new Error('Translate error')));
        spec.runTranslate(context).catch(err => {
            expect(err.error.message).to.equal('Translate error');
            done();
        });
    });

    it('SpecFailedException throws when reject is not supplied', () => {
        expect(() => {
            new SpecFailedException(() => {
                throw new Error('Boom');
            }, 'someField');
        }).to.throw('SpecFailedException: Boom');
    });

    it('SpecFailedException calls reject when supplied', done => {
        new SpecFailedException(
            () => { throw new Error('Boom'); },
            'someField',
            (reason) => {
                expect(reason.field).to.equal('someField');
                expect(reason.error.message).to.equal('Boom');
                done();
            }
        );
    });

    describe('Standard Schema and modern validation support', () => {
        it('runSchema resolves when schema is not set', async () => {
            const context = new Context('_schema_none');
            const spec = new Spec('someField');
            await spec.runSchema(context);
        });

        it('supports ~standard specification on root context', async () => {
            const context = new Context('_schema_std_root');
            context.set('email', 'alice@example.com');
            context.set('count', 5);

            const spec = new Spec('$root$');
            spec.schema({
                '~standard': {
                    version: 1,
                    vendor: 'test-vendor',
                    validate: (value: any) => {
                        return {
                            value: {
                                ...value,
                                count: value.count * 2
                            }
                        };
                    }
                }
            });

            await spec.runSchema(context);
            expect(context.getData()['count']()).to.equal(10);
            expect(context.getData()['email']()).to.equal('alice@example.com');
        });

        it('supports ~standard specification on single field', async () => {
            const context = new Context('_schema_std_field');
            context.set('username', 'bob');

            const spec = new Spec('username');
            spec.schema({
                '~standard': {
                    version: 1,
                    vendor: 'test-vendor',
                    validate: (value: any) => {
                        return { value: value.toUpperCase() };
                    }
                }
            });

            await spec.runSchema(context);
            expect(context.getData()['username']()).to.equal('BOB');
        });

        it('throws SpecFailedException when ~standard validation produces issues', async () => {
            const context = new Context('_schema_std_issues');
            context.set('age', 15);

            const spec = new Spec('age');
            spec.schema({
                '~standard': {
                    version: 1,
                    vendor: 'test-vendor',
                    validate: () => {
                        return {
                            issues: [
                                { path: ['age'], message: 'Must be at least 18' }
                            ]
                        };
                    }
                }
            });

            try {
                await spec.runSchema(context);
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('Must be at least 18');
            }
        });

        it('supports safeParse (Zod-like schema) on root and field', async () => {
            const context = new Context('_schema_safeparse');
            context.set('email', 'test@domain.com');

            const rootSpec = new Spec('$root$');
            rootSpec.schema({
                safeParse: (val: any) => {
                    return { success: true, data: { ...val, verified: true } };
                }
            });
            await rootSpec.runSchema(context);
            expect(context.getData()['verified']()).to.be.true;

            const fieldSpec = new Spec('email');
            fieldSpec.schema({
                safeParse: (val: any) => {
                    return { success: true, data: val.toLowerCase() };
                }
            });
            await fieldSpec.runSchema(context);
            expect(context.getData()['email']()).to.equal('test@domain.com');

            const failSpec = new Spec('email');
            failSpec.schema({
                safeParse: () => {
                    return {
                        success: false,
                        error: {
                            issues: [{ path: ['email'], message: 'Invalid email' }]
                        }
                    };
                }
            });
            try {
                await failSpec.runSchema(context);
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err.message).to.include('Invalid email');
            }
        });

        it('supports safeParse returning error without issues array', async () => {
            const context = new Context('_schema_safeparse_no_issues');
            const spec = new Spec('field');
            spec.schema({
                safeParse: () => ({ success: false, error: { message: 'Direct error' } })
            });
            try {
                await spec.runSchema(context);
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err.message).to.include('Direct error');
            }
        });

        it('supports parse() method (success and throw)', async () => {
            const context = new Context('_schema_parse');
            context.set('num', 42);

            const rootSpec = new Spec('$root$');
            rootSpec.schema({
                parse: (val: any) => ({ ...val, doubled: val.num * 2 })
            });
            await rootSpec.runSchema(context);
            expect(context.getData()['doubled']()).to.equal(84);

            const fieldSpec = new Spec('num');
            fieldSpec.schema({
                parse: (val: any) => val + 10
            });
            await fieldSpec.runSchema(context);
            expect(context.getData()['num']()).to.equal(52);

            const failSpec = new Spec('num');
            failSpec.schema({
                parse: () => { throw new Error('Parse error'); }
            });
            try {
                await failSpec.runSchema(context);
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err.message).to.include('Parse error');
            }
        });

        it('supports validate() method (success and throw)', async () => {
            const context = new Context('_schema_validate');
            context.set('active', true);

            const rootSpec = new Spec('$root$');
            rootSpec.schema({
                validate: (val: any) => ({ ...val, status: 'ok' })
            });
            await rootSpec.runSchema(context);
            expect(context.getData()['status']()).to.equal('ok');

            const fieldSpec = new Spec('active');
            fieldSpec.schema({
                validate: (val: any) => !val
            });
            await fieldSpec.runSchema(context);
            expect(context.getData()['active']()).to.be.false;

            const failSpec = new Spec('active');
            failSpec.schema({
                validate: () => { throw new Error('Validation failed'); }
            });
            try {
                await failSpec.runSchema(context);
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err.message).to.include('Validation failed');
            }
        });

        it('supports function predicate validator', async () => {
            const context = new Context('_schema_fn');
            context.set('code', 123);

            const passSpec = new Spec('code');
            passSpec.schema((val: any) => val === 123);
            await passSpec.runSchema(context);

            const failSpec = new Spec('code');
            failSpec.schema((val: any) => val === 999);
            try {
                await failSpec.runSchema(context);
                expect.fail('Should have failed');
            } catch (err: any) {
                expect(err.message).to.include('Validation failed for field "code"');
            }
        });

        it('integrates with context.validate() and context.runSpecs()', async () => {
            const context = new Context('_schema_ctx_integration');
            context.set('score', 95);

            const spec = new Spec('score');
            spec.schema({
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    validate: (val: any) => ({ value: val + 5 })
                }
            });
            context.addSpec(spec);

            await context.validate();
            expect(context.getData()['score']()).to.equal(100);

            await context.runSpecs();
            expect(context.getData()['score']()).to.equal(105);
        });
    });
});
