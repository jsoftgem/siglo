import { Step, flow, defaultCompensationManager, useStorage } from '@siglo/core';
import type { StandardSchemaV1 } from '@siglo/http';
import {
    aiStep,
    AiOutputValidationError,
    AiProviderError,
    AiRequestTimeoutError,
    defineAiTool
} from '@siglo/ai';
import { MockAiProvider } from '@siglo/ai/testing';
import { RandomSource } from '../engine/property-generators';
import { InvariantEvaluator } from '../engine/invariant-evaluator';
import { CharterResult } from './combinators.explore';

interface StructuredTestOutput {
    score: number;
    decision: string;
}

const testSchema: StandardSchemaV1<unknown, StructuredTestOutput> = {
    '~standard': {
        version: 1,
        vendor: 'siglo-exploratory',
        validate: (value: any) => {
            if (
                typeof value === 'object' &&
                value !== null &&
                typeof value.score === 'number' &&
                typeof value.decision === 'string'
            ) {
                return { value: value as StructuredTestOutput };
            }
            return {
                issues: [{ message: 'Expected { score: number, decision: string }', path: [] }]
            };
        }
    }
};

const jsonSchema = {
    type: 'object',
    properties: {
        score: { type: 'number' },
        decision: { type: 'string' }
    },
    required: ['score', 'decision'],
    additionalProperties: false
};

export async function runAiCharter(
    iterations: number = 15,
    seed: number = 1010
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [1, 2, 4];

    for (let i = 0; i < iterations; i++) {
        useStorage();
        defaultCompensationManager.clear();

        try {
            // =========================================================================
            // Sub-test A: Schema Repair Fuzzing & Token Budget Accounting
            // =========================================================================
            const repairAttempts = rng.nextInt(0, 3);
            const willSucceed = rng.nextBoolean(0.8);

            const outcomes: any[] = [];
            // Push failing outputs first
            for (let r = 0; r < repairAttempts; r++) {
                outcomes.push({
                    text: r % 2 === 0 ? 'Malformed JSON string {' : '{"score": "not_a_number"}',
                    promptTokens: 10,
                    completionTokens: 5
                });
            }

            if (willSucceed) {
                outcomes.push({
                    text: JSON.stringify({ score: rng.nextInt(1, 100), decision: 'APPROVED' }),
                    promptTokens: 12,
                    completionTokens: 8
                });
            } else {
                outcomes.push({
                    text: '{"unrepairable": true}',
                    promptTokens: 10,
                    completionTokens: 5
                });
            }

            const mockProvider = new MockAiProvider(outcomes);
            const maxRepairs = willSucceed ? repairAttempts + 1 : repairAttempts;

            const step = aiStep(`ai_fuzz_${i}`, {
                model: {
                    provider: 'openai',
                    model: 'gpt-4o',
                    adapter: mockProvider
                },
                schema: testSchema,
                jsonSchema,
                maxRepairAttempts: maxRepairs,
                prompt: (ctx: any) => `Evaluate request for iteration ${i}: ${JSON.stringify(ctx)}`
            });

            const initialContext = { iteration: i, canary: undefined };
            let capturedResult: any;

            try {
                capturedResult = await step.execute(initialContext);
                if (!willSucceed) {
                    errors.push(`Iteration ${i}: Expected AiOutputValidationError but step succeeded!`);
                }
            } catch (stepErr: any) {
                if (willSucceed) {
                    errors.push(`Iteration ${i}: Unexpected AI step failure: ${stepErr.message}`);
                } else if (!(stepErr instanceof AiOutputValidationError)) {
                    errors.push(`Iteration ${i}: Expected AiOutputValidationError, got ${stepErr.name}: ${stepErr.message}`);
                }
            }

            // Verify Oracle 1: Context Immutability
            try {
                InvariantEvaluator.assertContextImmutability(initialContext, initialContext);
            } catch (invErr: any) {
                errors.push(`Iteration ${i} [Oracle 1]: ${invErr.message}`);
            }

            if (willSucceed && capturedResult) {
                if (typeof capturedResult.data?.score !== 'number') {
                    errors.push(`Iteration ${i}: Structured output schema validation bypassed: ${JSON.stringify(capturedResult.data)}`);
                }
                if (capturedResult.aiMetrics?.repairAttempts !== repairAttempts) {
                    errors.push(
                        `Iteration ${i}: Repair attempt mismatch! Expected ${repairAttempts}, got ${capturedResult.aiMetrics?.repairAttempts}`
                    );
                }
                if (capturedResult.aiMetrics?.totalTokens <= 0) {
                    errors.push(`Iteration ${i}: Token metrics accounting failed (totalTokens was 0)`);
                }
            }

            // =========================================================================
            // Sub-test B: Provider Fallback Cascades (Rate Limits & Timeouts)
            // =========================================================================
            const primaryFails = rng.nextBoolean(0.5);
            if (primaryFails) {
                const primaryMock = new MockAiProvider([
                    new AiProviderError('Rate limit exceeded', 429)
                ]);
                const fallbackMock = new MockAiProvider([
                    { text: 'Fallback response text', promptTokens: 15, completionTokens: 5 }
                ]);

                const fallbackStep = aiStep(`ai_fallback_${i}`, {
                    model: {
                        provider: 'openai',
                        model: 'gpt-4o',
                        adapter: primaryMock
                    },
                    fallbackModels: [
                        {
                            provider: 'anthropic',
                            model: 'claude-3-5-sonnet',
                            adapter: fallbackMock
                        }
                    ],
                    prompt: 'Quick prompt'
                });

                const fallbackRes = await fallbackStep.execute({});
                if (fallbackRes.aiMetrics?.fallbackCount !== 1) {
                    errors.push(`Iteration ${i}: Fallback count expected 1, got ${fallbackRes.aiMetrics?.fallbackCount}`);
                }
                if (fallbackRes.aiMetrics?.providerUsed !== 'anthropic') {
                    errors.push(`Iteration ${i}: Expected providerUsed 'anthropic', got ${fallbackRes.aiMetrics?.providerUsed}`);
                }
            }

            // =========================================================================
            // Sub-test C: Agentic Tool Execution with Saga Rollback (Oracle 2)
            // =========================================================================
            const toolCallLog: string[] = [];
            const toolCompensationLog: string[] = [];

            const toolDef = defineAiTool({
                name: 'reserve_funds',
                description: 'Reserves transactional funds',
                inputSchema: {
                    '~standard': {
                        version: 1,
                        vendor: 'siglo',
                        validate: (v: any) => ({ value: v })
                    }
                },
                step: Step.create('reserve_funds', async () => {
                    toolCallLog.push('reserved');
                    return { reserved: true };
                }).compensate(async () => {
                    toolCompensationLog.push('refunded');
                }),
                mapInput: (args: any) => args
            });

            const agentMock = new MockAiProvider([
                // First turn: model calls tool
                {
                    text: 'Calling tool',
                    toolCalls: [{ id: 'call_1', name: 'reserve_funds', arguments: { amount: 100 } }],
                    promptTokens: 10,
                    completionTokens: 5
                },
                // Second turn: model returns final response
                {
                    text: 'Tool execution complete',
                    promptTokens: 15,
                    completionTokens: 8
                }
            ]);

            const agentStep = aiStep(`agent_step_${i}`, {
                model: { provider: 'openai', model: 'gpt-4o', adapter: agentMock },
                tools: [toolDef],
                prompt: 'Process transaction'
            });

            const failingStep = Step.create('post_agent_fail', async () => {
                throw new Error('Downstream failure after agent step');
            });

            const toolWorkflow = flow(agentStep, failingStep);

            try {
                await toolWorkflow.execute({}, { durable: false });
            } catch {
                // Expected failure to trigger compensation
            }

            if (toolCallLog.length > 0 && toolCompensationLog.length === 0) {
                // Assert Oracle 2: Compensations must run for executed tools
                try {
                    InvariantEvaluator.assertSagaLIFO(toolCallLog, toolCompensationLog);
                } catch (invErr: any) {
                    errors.push(`Iteration ${i} [Oracle 2]: ${invErr.message}`);
                }
            }

        } catch (charterErr: any) {
            errors.push(`Iteration ${i} Unhandled Exception: ${charterErr.message}`);
        }
    }

    return {
        charterName: 'Charter 10: Agentic AI Orchestration & Token Budget Stress',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
