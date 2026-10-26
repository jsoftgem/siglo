#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import {
    initProject,
    visualizeWorkflow,
    validateWorkflow,
    inspectWorkflow,
    inspectCheckpoint
} from './index';

function printHelp(): void {
    console.log(`
fluid-func CLI v2.0.0

USAGE:
    fluid-func <command> [options]

COMMANDS:
    init [dir]                     Scaffold a starter fluid-func project
    visualize <workflow-file>      Render workflow graph as Mermaid or text diagram
    validate <workflow-file>       Statically validate workflow definitions for cycles
    inspect <workflow-file>        Display workflow AST metrics and step summary
    checkpoint <file>              Inspect a serialized checkpoint state JSON

OPTIONS:
    --format=mermaid|text          Visualization output format (default: mermaid)
    --redact=field1,field2         Comma-separated list of fields/nodes to redact
    --help                         Show this help documentation
    --version                      Print version
`);
}

async function loadWorkflowFromFile(filePath: string): Promise<any> {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Workflow file not found: ${resolvedPath}`);
    }

    // Dynamic import of target workflow file
    const mod = await import(resolvedPath);
    const flowCandidate = mod.default || mod.workflow || mod.pipeline || Object.values(mod).find((v: any) => v && (v.isFlow || typeof v.run === 'function'));
    if (!flowCandidate) {
        throw new Error(`No exported Flow found in ${resolvedPath}. Export a flow as default or named export.`);
    }

    if (typeof flowCandidate === 'function' && !flowCandidate.isFlow) {
        return flowCandidate();
    }
    return flowCandidate;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }

    if (args.includes('--version') || args.includes('-v')) {
        console.log('2.0.0');
        return;
    }

    const command = args[0];
    const target = args[1];

    try {
        switch (command) {
            case 'init': {
                const targetDir = target || process.cwd();
                const res = initProject(targetDir);
                console.log(`\n✔ Initialized fluid-func workflow project in ${targetDir}`);
                for (const f of res.filesCreated) {
                    console.log(`  + ${f}`);
                }
                break;
            }

            case 'visualize': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. fluid-func visualize src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const formatArg = args.find(a => a.startsWith('--format='));
                const format = formatArg ? formatArg.split('=')[1] : 'mermaid';
                const vis = visualizeWorkflow(wf);

                if (format === 'text') {
                    console.log(vis.text);
                } else {
                    console.log(vis.mermaid);
                }
                break;
            }

            case 'validate': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. fluid-func validate src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const val = validateWorkflow(wf);
                if (val.valid) {
                    console.log('✔ Workflow graph is valid (acyclic, reachable)');
                } else {
                    console.error('✖ Workflow validation failed:');
                    for (const err of val.errors) {
                        console.error(`  - ${err}`);
                    }
                    process.exit(1);
                }
                break;
            }

            case 'inspect': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. fluid-func inspect src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const redactArg = args.find(a => a.startsWith('--redact='));
                const redactList = redactArg ? redactArg.split('=')[1].split(',') : [];
                const report = inspectWorkflow(wf, { redact: redactList });
                console.log(JSON.stringify(report, null, 2));
                break;
            }

            case 'checkpoint': {
                if (!target) {
                    console.error('Error: specify checkpoint JSON file (e.g. fluid-func checkpoint stack-state.json)');
                    process.exit(1);
                }
                const cpPath = path.resolve(process.cwd(), target);
                const content = fs.readFileSync(cpPath, 'utf-8');
                const redactArg = args.find(a => a.startsWith('--redact='));
                const redactList = redactArg ? redactArg.split('=')[1].split(',') : [];
                const inspected = inspectCheckpoint(content, { redact: redactList });
                console.log(JSON.stringify(inspected, null, 2));
                break;
            }

            default: {
                console.error(`Unknown command: ${command}`);
                printHelp();
                process.exit(1);
            }
        }
    } catch (err: any) {
        console.error(`Error: ${err?.message || err}`);
        process.exit(1);
    }
}

main();
