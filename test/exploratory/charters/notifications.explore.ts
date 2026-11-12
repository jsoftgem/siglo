import { Step, flow, waitForEvent, InMemoryIdempotencyStore, networkPolicyStorage } from '@siglo/core';
import { StaticKeyRing } from '@siglo/crypto';
import {
    sendNotificationStep,
    sendInteractiveApprovalStep,
    handleNotificationCallback,
    signActionToken,
    verifyActionToken,
} from '@siglo/notifications';
import { MockNotificationTransport } from '@siglo/notifications/testing';
import { RandomSource } from '../engine/property-generators';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { CharterResult } from './combinators.explore';

export async function runNotificationsCharter(iterations: number = 15, seed: number = 1111): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [3];

    for (let i = 0; i < iterations; i++) {
        try {
            // =========================================================================
            // Sub-test A: Dispatch Idempotency & Concurrency Exclusivity (Oracle 3)
            // =========================================================================
            const channel = rng.pick(['email', 'slack', 'sms'] as const);
            const transport = new MockNotificationTransport(channel);
            const idempotencyStore = new InMemoryIdempotencyStore();

            // Channel-specific recipient format matching Siglo validation schemas
            const recipient =
                channel === 'email'
                    ? `user_${i}_${rng.nextInt(100, 999)}@example.com`
                    : channel === 'sms'
                      ? `+1${rng.nextInt(1000000000, 9999999999)}`
                      : `C${rng.nextInt(10000000, 99999999)}`;

            const notificationStep = sendNotificationStep(`notify_${i}`, {
                channel,
                recipient,
                template: 'Order confirmed for #{{id}}',
                transport,
                idempotencyStore,
            });

            // Concurrently dispatch duplicate notifications with identical stackId
            const stackId = `stack_notif_${i}_${rng.nextInt(1000, 9999)}`;
            const concurrentCalls = rng.nextInt(3, 8);
            const dispatchPromises = Array.from({ length: concurrentCalls }, () =>
                notificationStep.execute({ id: `order_${i}` }, { stackId }),
            );

            const results = await Promise.all(dispatchPromises);

            // Assert Oracle 3: Exactly 1 dispatch reached the transport
            if (transport.messages.length !== 1) {
                errors.push(
                    `Iteration ${i} [Oracle 3]: Idempotency failure! Transport received ${transport.messages.length} messages for identical stackId, expected 1.`,
                );
            }

            // All duplicate executions must return the identical notificationId
            const firstId = results[0].notificationId;
            for (let r = 1; r < results.length; r++) {
                if (results[r].notificationId !== firstId) {
                    errors.push(
                        `Iteration ${i}: Inconsistent notificationId returned for duplicate dispatch: ${results[r].notificationId} vs ${firstId}`,
                    );
                }
            }

            // =========================================================================
            // Sub-test B: Cryptographic Token Tampering & Key Rotation (Oracle 1)
            // =========================================================================
            const oldSecret = `secret_v1_${rng.nextInt(1000, 9999)}`;
            const newSecret = `secret_v2_${rng.nextInt(1000, 9999)}`;
            const ring = new StaticKeyRing('key1', { key1: oldSecret });

            const payload = {
                stackId,
                correlationKey: `corr_${i}`,
                expectedEvent: 'PAYMENT_APPROVED',
                approved: true,
                expiresAt: Date.now() + 60000,
            };

            const token = await signActionToken(payload, ring, Date.now());

            // Key rotation: add new primary key
            ring.addKey('key2', newSecret, true);

            // Verified token should still validate against previous key in ring
            const verified = await verifyActionToken(token, ring);
            if (verified.correlationKey !== payload.correlationKey) {
                errors.push(`Iteration ${i}: Token verification mismatch after key rotation!`);
            }

            // Fuzz tampered token variations
            const tamperedVariants = [
                token + 'tampered',
                'malformed.token.format',
                token.slice(0, token.length - 6) + 'xxxxxx',
            ];

            for (const badToken of tamperedVariants) {
                let rejected = false;
                try {
                    await verifyActionToken(badToken, ring);
                } catch {
                    rejected = true;
                }
                if (!rejected) {
                    errors.push(`Iteration ${i}: Tampered token was incorrectly accepted by verifier: ${badToken}`);
                }
            }

            // =========================================================================
            // Sub-test C: Interactive Approval Concurrent Callback Race Condition (Oracle 3)
            // =========================================================================
            const approvalTransport = new MockNotificationTransport('email');
            const correlationKey = `approval_corr_${i}_${Date.now()}`;
            const signingSecret = `sign_sec_${i}`;

            const approvalFlow = flow(
                sendInteractiveApprovalStep(`approval_step_${i}`, {
                    channel: 'email',
                    recipient: `approver_${i}@example.com`,
                    title: 'Authorize Payment?',
                    correlationKey,
                    timeout: '1h',
                    onApproveEvent: 'APPROVED',
                    onRejectEvent: 'REJECTED',
                    callbackBaseUrl: 'https://api.siglo.internal/approval',
                    signingSecret,
                    transport: approvalTransport,
                }),
                waitForEvent('APPROVED', { correlationKey, timeout: '1h' }),
                Step.create(`approved_effect_${i}`, async () => ({ executed: true })),
            );

            // Execute up to suspension
            try {
                await approvalFlow.run({}, { durable: true });
            } catch (suspendErr: any) {
                if (!/suspend/i.test(suspendErr.message)) {
                    errors.push(`Iteration ${i}: Unexpected approval suspension error: ${suspendErr.message}`);
                }
            }

            if (approvalTransport.messages.length > 0) {
                const approveUrl = approvalTransport.messages[0].interactiveActions?.approveUrl;
                if (!approveUrl) {
                    errors.push(`Iteration ${i}: Interactive approval message missing approveUrl`);
                } else {
                    const parsedToken = new URL(approveUrl).searchParams.get('token')!;

                    // Concurrently submit callback resolution
                    const callbackResolutions = await Promise.all([
                        handleNotificationCallback(parsedToken, {
                            workflow: approvalFlow,
                            allowBearerApproval: true,
                            signingSecret,
                        }),
                        handleNotificationCallback(parsedToken, {
                            workflow: approvalFlow,
                            allowBearerApproval: true,
                            signingSecret,
                        }),
                    ]);

                    const statuses = callbackResolutions.map(r => r.status).sort();
                    // Exactly one 200 OK and one 409 Conflict
                    if (statuses[0] !== 200 || statuses[1] !== 409) {
                        errors.push(
                            `Iteration ${i} [Oracle 3]: Concurrent approval resolution race violation! Expected [200, 409], got ${JSON.stringify(statuses)}`,
                        );
                    }
                }
            }
        } catch (charterErr: any) {
            errors.push(`Iteration ${i} Unhandled Exception: ${charterErr.message}`);
        }
    }

    return {
        charterName: 'Charter 11: Notification Deduplication, Token Tampering & Approval Races',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors,
    };
}
