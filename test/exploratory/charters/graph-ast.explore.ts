import { RandomSource } from '../engine/property-generators';
import {
    Step,
    flow,
    toGraph,
    isWorkflowNode,
    validateGraph,
    inspectGraph,
    WorkflowNodeType,
    WorkflowNode,
    NetworkPolicyConfig
} from 'siglo';
import { CharterResult } from './combinators.explore';

export async function runGraphAstCharter(
    iterations: number = 25,
    seed: number = 8008
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [7, 8, 9];

    for (let i = 0; i < iterations; i++) {
        try {
            // =========================================================================
            // Sub-test A: Network Egress Policy Extraction Invariant (Recent Feature)
            // =========================================================================
            const allowedHosts = [
                `api-${rng.nextInt(1, 100)}.stripe.com`,
                `*.internal-${rng.nextInt(1, 50)}.net`,
                'localhost'
            ];
            const defaultPolicy = rng.pick(['allow', 'deny'] as const);

            const policyConfig: NetworkPolicyConfig = {
                enabled: true,
                defaultPolicy,
                allowedHosts,
                allowLocalhost: true
            };

            // 1. Step with declarative .allowNetwork / .denyNetwork / .networkPolicy
            const s1 = Step.create(`step_policy_${i}`, async () => ({ ok: true }));
            if (rng.nextBoolean()) {
                s1.networkPolicy(policyConfig);
            } else {
                s1.allowNetwork(allowedHosts);
            }

            const stepNode = toGraph(s1);
            if (!isWorkflowNode(stepNode)) {
                errors.push(`Iteration ${i}: Step graph node failed isWorkflowNode check!`);
            }
            if (stepNode.type !== 'step') {
                errors.push(`Iteration ${i}: Step node type is not 'step', got: ${stepNode.type}`);
            }

            // Verify networkPolicy metadata reflection in StepNode
            const stepMetadata = (stepNode as any).metadata;
            if (!stepMetadata || !stepMetadata.networkPolicy) {
                errors.push(`Iteration ${i}: StepNode missing networkPolicy in metadata!`);
            } else {
                const reflectedPolicy = stepMetadata.networkPolicy;
                if (typeof reflectedPolicy !== 'object' && typeof reflectedPolicy !== 'function') {
                    errors.push(`Iteration ${i}: Malformed reflected step network policy: ${typeof reflectedPolicy}`);
                }
            }

            // 2. Flow-level network policy reflection
            const s2 = Step.create(`step_child_${i}`, async () => ({ num: 42 }));
            const flowInstance = flow(s1, s2).networkPolicy(policyConfig);

            const flowNode = toGraph(flowInstance);
            if (!isWorkflowNode(flowNode)) {
                errors.push(`Iteration ${i}: Flow graph node failed isWorkflowNode check!`);
            }
            if (flowNode.type !== 'sequence') {
                errors.push(`Iteration ${i}: Multi-step flow should produce SEQUENCE node, got: ${flowNode.type}`);
            }

            const flowMetadata = (flowNode as any).metadata;
            if (!flowMetadata || !flowMetadata.networkPolicy) {
                errors.push(`Iteration ${i}: FlowNode missing networkPolicy in metadata!`);
            } else {
                const flowReflected = flowMetadata.networkPolicy;
                if (flowReflected.defaultPolicy !== defaultPolicy) {
                    errors.push(
                        `Iteration ${i}: Flow network policy defaultPolicy mismatch! Expected ${defaultPolicy}, got ${flowReflected.defaultPolicy}`
                    );
                }
            }

            // 3. Functional networkPolicy callback on Step & Flow
            const getterOnlyStep = {
                $stepId: `getter_step_${i}`,
                name: 'getterOnly',
                networkPolicy: () => ({
                    enabled: true,
                    defaultPolicy: 'deny' as const,
                    allowedHosts: ['dynamic.domain.com']
                })
            };
            const dynamicNode = toGraph(getterOnlyStep);
            const dynamicMetadata = (dynamicNode as any).metadata;
            if (!dynamicMetadata?.networkPolicy?.allowedHosts?.includes('dynamic.domain.com')) {
                errors.push(`Iteration ${i}: Dynamic network policy function was not resolved in Step metadata!`);
            }

            // =========================================================================
            // Sub-test B: Single-Step Unwrapping Invariant
            // =========================================================================
            // Single-step array unwrap: [S] -> S
            const singleArr = [s1];
            const unwrappedArrNode = toGraph(singleArr);
            if (unwrappedArrNode.id !== stepNode.id) {
                errors.push(`Iteration ${i}: Single-element array did not unwrap to child node ID!`);
            }

            // Single-step flow unwrap: flow(S) -> S
            const singleFlow = flow(s1);
            const unwrappedFlowNode = toGraph(singleFlow);
            if (unwrappedFlowNode.id !== stepNode.id) {
                errors.push(`Iteration ${i}: Single-step flow did not unwrap to child step node ID!`);
            }

            // Deep nested single-item chain: [[[[flow([S])]]]] -> must unwrap to S
            const deeplyNested = [[[[flow([s1])]]]];
            const deepUnwrapped = toGraph(deeplyNested);
            if (deepUnwrapped.id !== stepNode.id || deepUnwrapped.type !== 'step') {
                errors.push(`Iteration ${i}: Deeply nested single-step structure failed to unwrap to leaf StepNode!`);
            }

            // Multi-step array must NOT unwrap: [S1, S2] -> SEQUENCE with 2 children
            const multiArr = [s1, s2];
            const multiNode = toGraph(multiArr);
            if (multiNode.type !== 'sequence' || (multiNode as any).children?.length !== 2) {
                errors.push(`Iteration ${i}: Multi-step array did not produce SEQUENCE with 2 children!`);
            }

            // =========================================================================
            // Sub-test C: Idempotency & Re-entrancy Invariant (toGraph(toGraph(X)) === toGraph(X))
            // =========================================================================
            const firstPass = toGraph(flowInstance);
            const secondPass = toGraph(firstPass);
            // Must return identical reference
            if (firstPass !== secondPass) {
                errors.push(`Iteration ${i}: toGraph on already converted WorkflowNode did not return identical reference!`);
            }

            // Object containing .workflowNode property
            const wrappedNode = { workflowNode: firstPass };
            const unwrappedRef = toGraph(wrappedNode);
            if (unwrappedRef !== firstPass) {
                errors.push(`Iteration ${i}: toGraph({ workflowNode }) did not return the enclosed WorkflowNode!`);
            }

            // =========================================================================
            // Sub-test D: Degenerate & Malformed Input Fuzzing Robustness
            // =========================================================================
            const degenerateInputs = [
                null,
                undefined,
                0,
                -1,
                12345,
                '',
                'plain-string-step',
                true,
                false,
                NaN,
                Symbol('fuzz-sym'),
                () => 'plain-anonymous-fn',
                function namedFuzzFn() { return 1; },
                [],
                {},
                { unknownProp: true, nested: { deeper: null } }
            ];

            for (const badInput of degenerateInputs) {
                const node = toGraph(badInput);
                if (!isWorkflowNode(node)) {
                    errors.push(`Iteration ${i}: Degenerate input ${String(badInput)} failed isWorkflowNode!`);
                }
                if (!node.id || typeof node.id !== 'string') {
                    errors.push(`Iteration ${i}: Degenerate input ${String(badInput)} produced invalid node.id!`);
                }
                if (!node.type || typeof node.type !== 'string') {
                    errors.push(`Iteration ${i}: Degenerate input ${String(badInput)} produced invalid node.type!`);
                }
            }

            // =========================================================================
            // Sub-test E: Structural Graph Validation Roundtrip
            // =========================================================================
            const complexWorkflow = flow(
                Step.create('stepA').allowNetwork(['api.stripe.com']),
                flow(
                    Step.create('stepB1').timeout(5000),
                    Step.create('stepB2').compensate(async () => {})
                ).networkPolicy({ defaultPolicy: 'deny', allowedHosts: ['internal.auth'] }),
                Step.create('stepC')
            );

            const complexGraph = toGraph(complexWorkflow);
            const validation = validateGraph(complexGraph);
            if (!validation.valid) {
                errors.push(`Iteration ${i}: Complex hierarchical graph validation failed: ${validation.errors.join('; ')}`);
            }

            const inspection = inspectGraph(complexWorkflow);
            if (inspection.totalNodes < 4) {
                errors.push(`Iteration ${i}: inspectGraph totalNodes count mismatch: got ${inspection.totalNodes}`);
            }
        } catch (err: any) {
            errors.push(`Iteration ${i} Unhandled Exception: ${err.message}\n${err.stack}`);
        }
    }

    return {
        charterName: 'Charter 8: Graph AST Generation & Network Policy Reflection (toGraph)',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
