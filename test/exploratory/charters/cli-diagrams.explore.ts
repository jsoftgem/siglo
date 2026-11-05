import { FlowAstGenerator } from '../engine/ast-generator';
import { RandomSource } from '../engine/property-generators';
import { toMermaid, toDot, toGraph, validateGraph, inspectGraph } from '@siglo/core';
import { CharterResult } from './combinators.explore';

export async function runCliDiagramsCharter(
    iterations: number = 20,
    seed: number = 7007
): Promise<CharterResult> {
    const startTime = Date.now();
    const rng = new RandomSource(seed);
    const errors: string[] = [];
    const invariantsChecked = [6];

    for (let i = 0; i < iterations; i++) {
        const iterSeed = rng.nextInt(1, 100000);
        const fuzzer = new FlowAstGenerator(iterSeed);
        const depth = rng.nextInt(2, 4);

        const generated = fuzzer.generateFlow(`graph_fuzz_${i}`, depth, {
            compensationProbability: 0.5,
            timeoutProbability: 0.3
        });

        try {
            // 1. Graph Inspection
            const inspection = inspectGraph(generated.workflow);
            if (!inspection || inspection.totalNodes === 0) {
                errors.push(`Iteration ${i}: Graph inspection returned empty nodes!`);
            }

            // 2. Mermaid Export Syntax Verification
            const mermaidText = toMermaid(generated.workflow, {
                direction: rng.pick(['TD', 'LR', 'TB']),
                includeBadges: true
            });

            if (!mermaidText.startsWith('flowchart ')) {
                errors.push(`Iteration ${i}: Mermaid diagram does not start with flowchart declaration!`);
            }

            // Check that no raw unmatched double-quotes corrupted node labels
            const lines = mermaidText.split('\n');
            for (const line of lines) {
                if (line.includes('["') && !line.includes('"]')) {
                    errors.push(`Iteration ${i}: Malformed unclosed Mermaid label: ${line}`);
                }
            }

            // 3. Graphviz DOT Export Syntax Verification
            const dotText = toDot(generated.workflow, {
                graphName: `Graph_${i}`,
                direction: 'TB'
            });

            if (!dotText.includes('digraph')) {
                errors.push(`Iteration ${i}: DOT output missing 'digraph' header!`);
            }
            if (!dotText.includes('}')) {
                errors.push(`Iteration ${i}: DOT output missing closing brace!`);
            }

            // 4. Graph Structure Validation
            const workflowNode = toGraph(generated.workflow);
            const validation = validateGraph(workflowNode);
            if (!validation.valid) {
                const hasCycles = validation.errors.some(e => e.includes('Cycle detected'));
                if (hasCycles) {
                    errors.push(`Iteration ${i}: False positive cycle detected in tree workflow!`);
                } else {
                    errors.push(`Iteration ${i}: Graph validation failed: ${validation.errors.join('; ')}`);
                }
            }
        } catch (err: any) {
            errors.push(`Iteration ${i} Export Exception: ${err.message}`);
        }
    }

    return {
        charterName: 'Charter 7: CLI Tooling, Diagram Export & Validation',
        iterations,
        passed: errors.length === 0,
        durationMs: Date.now() - startTime,
        invariantsChecked,
        errors
    };
}
