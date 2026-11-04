#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import {
    initProject,
    visualizeWorkflow,
    validateWorkflow,
    inspectWorkflow,
    inspectCheckpoint,
    generateWorkflow,
    generateStep,
    replayFixture,
    exportWorkflow,
    startMonitor,
    reconcileCommand,
    GenerateStepOptions
} from './index';

function printHelp(): void {
    console.log(`
siglo CLI v1.0.0

USAGE:
    siglo <command> [arguments] [options]

COMMANDS:
    init [dir]                     Scaffold a starter siglo project
    generate workflow <name>       Scaffold a new typed workflow with test
    generate step <name>           Scaffold a new typed step with test
    visualize <workflow-file>      Render workflow graph as Mermaid or text diagram
    export <workflow-file>         Export workflow graph as mermaid, json, or dot
    validate <workflow-file>       Statically validate workflow definitions for cycles
    inspect <workflow-file>        Display workflow AST metrics and step summary
    checkpoint <file>              Inspect a serialized checkpoint state JSON
    replay <fixture> [workflow]    Replay execution against a recorded test fixture
    monitor [workflow-file]        Launch live workflow monitoring dashboard
    reconcile [workflow-file]      Reconcile and compensate abandoned/stuck workflows

OPTIONS:
    --type=generic|http|crypto|notification|ai  Step template (default: generic)
    --url=<url> --provider=<provider> --model=<id>  Template configuration
    --channel=<channel> --interactive=true|false   Notification configuration
    --format=mermaid|text|dot|json Output format (default: mermaid)
    --direction=TD|LR|TB           Diagram flow direction (default: TD)
    --out=<file>                   Write output directly to file instead of stdout
    --redact=field1,field2         Comma-separated list of fields/nodes to redact
    --help, -h                     Show this help documentation
    --version, -v                  Print version
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

function getOption(args: string[], prefix: string): string | undefined {
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : undefined;
}

function writeOutput(content: string, outPath?: string): void {
    if (outPath) {
        const resolved = path.resolve(process.cwd(), outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf-8');
        console.log(`✔ Output written to ${resolved}`);
    } else {
        console.log(content);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }

    if (args.includes('--version') || args.includes('-v')) {
        console.log('1.0.0');
        return;
    }

    const command = args[0];
    const target = args[1];
    const outArg = getOption(args, '--out=');

    try {
        switch (command) {
            case 'init': {
                const targetDir = target || process.cwd();
                const res = initProject(targetDir);
                console.log(`\n✔ Initialized siglo workflow project in ${targetDir}`);
                for (const f of res.filesCreated) {
                    console.log(`  + ${f}`);
                }
                break;
            }

            case 'generate': {
                const subType = target;
                const name = args[2];
                if (!subType || !name) {
                    console.error('Error: specify generator type and name (e.g. siglo generate workflow order)');
                    process.exit(1);
                }
                if (subType === 'workflow') {
                    const res = generateWorkflow(name);
                    console.log(`✔ Generated workflow in ${res.filePath}`);
                    console.log(`✔ Generated workflow test in ${res.testPath}`);
                } else if (subType === 'step') {
                    const options: Record<string, unknown> = {};
                    for (const arg of args.slice(3)) {
                        const match = /^--(type|url|provider|model|channel|interactive)=(.*)$/.exec(arg);
                        if (!match || match[1] in options) throw new Error(`Invalid or duplicate generator option: ${arg}`);
                        options[match[1]] = match[1] === 'interactive'
                            ? match[2] === 'true' ? true : match[2] === 'false' ? false : match[2]
                            : match[2];
                    }
                    const res = generateStep(name, process.cwd(), options as GenerateStepOptions);
                    console.log(`✔ Generated step in ${res.filePath}`);
                    console.log(`✔ Generated step test in ${res.testPath}`);
                } else {
                    console.error(`Unknown generator type: '${subType}'. Use 'workflow' or 'step'.`);
                    process.exit(1);
                }
                break;
            }

            case 'visualize': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. siglo visualize src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const format = getOption(args, '--format=') || 'mermaid';
                const vis = visualizeWorkflow(wf);

                const content = format === 'text' ? vis.text : vis.mermaid;
                writeOutput(content, outArg);
                break;
            }

            case 'export': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. siglo export src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const format = (getOption(args, '--format=') || 'mermaid') as 'mermaid' | 'dot' | 'json';
                const direction = (getOption(args, '--direction=') || 'TD') as 'TD' | 'LR' | 'TB';
                const exported = exportWorkflow(wf, { format, direction });
                writeOutput(exported, outArg);
                break;
            }

            case 'validate': {
                if (!target) {
                    console.error('Error: specify workflow file path (e.g. siglo validate src/workflow.ts)');
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
                    console.error('Error: specify workflow file path (e.g. siglo inspect src/workflow.ts)');
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(target);
                const redactStr = getOption(args, '--redact=');
                const redactList = redactStr ? redactStr.split(',') : [];
                const report = inspectWorkflow(wf, { redact: redactList });
                writeOutput(JSON.stringify(report, null, 2), outArg);
                break;
            }

            case 'checkpoint': {
                if (!target) {
                    console.error('Error: specify checkpoint JSON file (e.g. siglo checkpoint stack-state.json)');
                    process.exit(1);
                }
                const cpPath = path.resolve(process.cwd(), target);
                const content = fs.readFileSync(cpPath, 'utf-8');
                const redactStr = getOption(args, '--redact=');
                const redactList = redactStr ? redactStr.split(',') : [];
                const inspected = inspectCheckpoint(content, { redact: redactList });
                writeOutput(JSON.stringify(inspected, null, 2), outArg);
                break;
            }

            case 'replay': {
                if (!target) {
                    console.error('Error: specify fixture file (e.g. siglo replay fixture.json [workflow.ts])');
                    process.exit(1);
                }
                const wfPath = args[2] || 'src/workflow.ts';
                const wf = await loadWorkflowFromFile(wfPath);
                const fixturePath = path.resolve(process.cwd(), target);
                const result = await replayFixture(wf, fixturePath);
                if (result.success) {
                    console.log(`✔ Replay passed in ${result.durationMs}ms`);
                } else {
                    console.error('✖ Replay failed with discrepancies:', JSON.stringify(result.diff, null, 2));
                    process.exit(1);
                }
                break;
            }

            case 'monitor': {
                const portStr = getOption(args, '--port=');
                const port = portStr ? parseInt(portStr, 10) : 4000;
                const host = getOption(args, '--host=') || '0.0.0.0';
                const ns = getOption(args, '--namespace=');
                let wf: any;
                if (target && !target.startsWith('--')) {
                    try {
                        wf = await loadWorkflowFromFile(target);
                    } catch (e: any) {
                        console.warn(`Warning: Could not load workflow ${target}: ${e.message}`);
                    }
                }
                const monitor = await startMonitor({ port, host, namespace: ns, flow: wf });
                console.log(`🚀 Siglo Live Monitor running at http://${host === "0.0.0.0" ? "localhost" : host}:${monitor.port}`);
                console.log(`   - Dashboard: http://localhost:${monitor.port}/`);
                console.log(`   - SSE Stream: http://localhost:${monitor.port}/events`);
                console.log(`   - WebSocket: ws://localhost:${monitor.port}/ws`);
                console.log(`   - Prometheus Metrics: http://localhost:${monitor.port}/metrics`);
                break;
            }

            case 'reconcile': {
                const staleStr = getOption(args, '--stale-threshold=') || '10m';
                const actionArg = (getOption(args, '--action=') || 'compensate') as 'compensate' | 'fail' | 'inspect';
                const modeArg = (getOption(args, '--mode=') || 'best-effort') as 'strict' | 'best-effort';
                const ns = getOption(args, '--namespace=');
                let wf: any;
                if (target && !target.startsWith('--')) {
                    try {
                        wf = await loadWorkflowFromFile(target);
                    } catch (e: any) {
                        console.warn(`Warning: Could not load workflow ${target}: ${e.message}`);
                    }
                }
                const report = await reconcileCommand({
                    staleThreshold: staleStr,
                    action: actionArg,
                    mode: modeArg,
                    namespace: ns,
                    flow: wf
                });
                writeOutput(JSON.stringify(report, null, 2), outArg);
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
