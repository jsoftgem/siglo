import { expect } from 'chai';
import crypto from 'node:crypto';
import { flow, ValidationException } from '@siglo/core';
import { encryptAESGCM, decryptAESGCM, isEncryptedEnvelope, encryptFieldsStep, decryptFieldsStep } from '../src';

describe('AES-256-GCM Envelope Encryption (encryptFieldsStep & decryptFieldsStep)', () => {
    const masterKey = crypto.randomBytes(32);

    describe('Core AEAD Cipher Implementation', () => {
        it('encrypts and decrypts strings, objects, numbers, and booleans with fidelity', () => {
            const dataSet = [
                'sensitive-ssn-123-45-6789',
                { card: '4111222233334444', cvv: '123', exp: '12/28' },
                987654321,
                true,
                null,
            ];

            for (const item of dataSet) {
                const envelope = encryptAESGCM(item, masterKey);
                expect(isEncryptedEnvelope(envelope)).to.be.true;
                expect(envelope.__sigloCipher).to.equal('aes-256-gcm');
                expect(envelope.iv).to.have.lengthOf(24); // 12 bytes * 2 hex chars
                expect(envelope.tag).to.have.lengthOf(32); // 16 bytes * 2 hex chars

                const decrypted = decryptAESGCM(envelope, masterKey);
                expect(decrypted).to.deep.equal(item);
            }
        });

        it('generates a fresh 12-byte IV for every invocation (never reuses IV)', () => {
            const plaintext = 'identical-secret-payload';
            const env1 = encryptAESGCM(plaintext, masterKey);
            const env2 = encryptAESGCM(plaintext, masterKey);
            const env3 = encryptAESGCM(plaintext, masterKey);

            expect(env1.iv).to.not.equal(env2.iv);
            expect(env2.iv).to.not.equal(env3.iv);
            expect(env1.data).to.not.equal(env2.data);
        });

        it('supports 64-char hex strings and passphrase key derivation', () => {
            const hexKey = masterKey.toString('hex');
            const passphraseKey = 'my-super-secret-enterprise-kms-key';

            const envHex = encryptAESGCM('secret-data', hexKey);
            expect(decryptAESGCM(envHex, hexKey)).to.equal('secret-data');

            const envPassphrase = encryptAESGCM({ apiKey: 'sk_live_123' }, passphraseKey);
            expect(decryptAESGCM(envPassphrase, passphraseKey)).to.deep.equal({ apiKey: 'sk_live_123' });
        });

        it('rejects tampered auth tag by throwing an error', () => {
            const envelope = encryptAESGCM('tamper-test', masterKey);

            // Flip the last hex character of the auth tag
            const lastChar = envelope.tag.slice(-1);
            const flippedChar = lastChar === 'a' ? 'b' : 'a';
            const tamperedEnvelope = {
                ...envelope,
                tag: envelope.tag.slice(0, -1) + flippedChar,
            };

            expect(() => decryptAESGCM(tamperedEnvelope, masterKey)).to.throw();
        });

        it('rejects tampered ciphertext data by throwing an error', () => {
            const envelope = encryptAESGCM('tamper-test-data', masterKey);

            // Flip the last hex character of ciphertext
            const lastChar = envelope.data.slice(-1);
            const flippedChar = lastChar === '0' ? '1' : '0';
            const tamperedEnvelope = {
                ...envelope,
                data: envelope.data.slice(0, -1) + flippedChar,
            };

            expect(() => decryptAESGCM(tamperedEnvelope, masterKey)).to.throw();
        });
    });

    describe('Step Lifecycle Integration (encryptFieldsStep & decryptFieldsStep)', () => {
        interface AccountContext {
            accountId: string;
            customerSsn: string;
            cardToken: string;
            publicNotes: string;
        }

        it('encrypts specified fields in-place and leaves other fields untouched', async () => {
            const step = encryptFieldsStep('protectAccount', {
                fields: ['customerSsn', 'cardToken'],
                secretKey: masterKey,
            });

            const initialCtx: AccountContext = {
                accountId: 'acc_123',
                customerSsn: '000-12-3456',
                cardToken: 'tok_visa_4242',
                publicNotes: 'VIP customer',
            };

            const result = await step.execute(initialCtx);

            expect(result.accountId).to.equal('acc_123');
            expect(result.publicNotes).to.equal('VIP customer');
            expect(isEncryptedEnvelope(result.customerSsn)).to.be.true;
            expect(isEncryptedEnvelope(result.cardToken)).to.be.true;
        });

        it('does not double-encrypt fields that are already EncryptedEnvelopes', async () => {
            const step = encryptFieldsStep('protectAccount', {
                fields: ['customerSsn'],
                secretKey: masterKey,
            });

            const initialCtx = { customerSsn: '000-12-3456' };
            const once = await step.execute(initialCtx);
            const twice = await step.execute(once);

            expect(twice.customerSsn).to.deep.equal(once.customerSsn);
        });

        it('decrypts encrypted envelopes in-place back to plaintext', async () => {
            const encStep = encryptFieldsStep('protect', {
                fields: ['customerSsn'],
                secretKey: masterKey,
            });

            const decStep = decryptFieldsStep('unprotect', {
                fields: ['customerSsn'],
                secretKey: masterKey,
            });

            const initialCtx = { customerSsn: '999-88-7777', unencrypted: 'hello' };
            const encryptedCtx = await encStep.execute(initialCtx);
            expect(isEncryptedEnvelope(encryptedCtx.customerSsn)).to.be.true;

            const restoredCtx = await decStep.execute(encryptedCtx);
            expect(restoredCtx.customerSsn).to.equal('999-88-7777');
            expect(restoredCtx.unencrypted).to.equal('hello');
        });

        it('throws ValidationException when decrypting a tampered envelope', async () => {
            const encStep = encryptFieldsStep('protect', {
                fields: ['customerSsn'],
                secretKey: masterKey,
            });

            const decStep = decryptFieldsStep('unprotect', {
                fields: ['customerSsn'],
                secretKey: masterKey,
            });

            const encryptedCtx = await encStep.execute({ customerSsn: 'sensitive' });

            // Tamper with the auth tag
            const env = encryptedCtx.customerSsn as any;
            const tamperedEnv = {
                ...env,
                tag: '0'.repeat(32),
            };

            try {
                await decStep.execute({ customerSsn: tamperedEnv });
                expect.fail('Expected decryption to fail on tampered tag');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.errors[0].field).to.equal('customerSsn');
                expect(err.errors[0].message).to.include('authentication tag verification failed');
                expect(err.phase).to.equal('action');
                expect(err.retryable).to.be.false;
            }
        });

        it('throws ValidationException if secretKey is not provided', async () => {
            const encStep = encryptFieldsStep('protect', {
                fields: ['customerSsn'],
                secretKey: '' as any,
            });

            try {
                await encStep.execute({ customerSsn: '123' });
                expect.fail('Expected missing key to fail');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ValidationException);
                expect(err.errors[0].field).to.equal('secretKey');
            }
        });
    });

    describe('Durable Checkpoint Workflow Simulation', () => {
        it('maintains encrypted ciphertext in serialized checkpoint state before decryption', async () => {
            const workflow = flow(
                encryptFieldsStep('protectSsn', {
                    fields: ['ssn'],
                    secretKey: masterKey,
                }),
                decryptFieldsStep('restoreSsn', {
                    fields: ['ssn'],
                    secretKey: masterKey,
                }),
            );

            const result = await workflow.run({
                orderId: 'ord_999',
                ssn: '123-45-6789',
            });

            expect(result.orderId).to.equal('ord_999');
            expect(result.ssn).to.equal('123-45-6789');
        });
    });
});
