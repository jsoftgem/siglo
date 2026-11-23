#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import { Flow, getErrorMessage } from '@siglo/core';
import {
    initProject,
    installSkills,
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
    GenerateStepOptions,
} from './index';

function printHelp(): void {
    console.log(`
siglo CLI v1.3.0

USAGE:
    siglo <command> [arguments] [options]

COMMANDS:
    init [dir]                     Scaffold a starter siglo project with skills
    skills [install]               Install Siglo Agent Skills into .agents/skills
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
    --dir=<path>                   Target directory for skills install
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

function parseEnumOption<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    fallback: T,
    flag: string,
): T {
    if (value === undefined) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    throw new Error(`Invalid ${flag} value '${value}'. Expected one of: ${allowed.join(', ')}`);
}

async function loadWorkflowFromFile(filePath: string): Promise<Flow> {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Workflow file not found: ${resolvedPath}`);
    }

    // Dynamic import of target workflow file
    const mod = (await import(resolvedPath)) as Record<string, unknown>;
    const isFlowLike = (v: unknown): boolean =>
        (typeof v === 'object' || typeof v === 'function') &&
        v !== null &&
        ('isFlow' in v
            ? Boolean((v as { isFlow?: unknown }).isFlow)
            : typeof (v as { run?: unknown }).run === 'function');
    const flowCandidate = mod.default || mod.workflow || mod.pipeline || Object.values(mod).find(isFlowLike);
    if (!flowCandidate) {
        throw new Error(`No exported Flow found in ${resolvedPath}. Export a flow as default or named export.`);
    }

    if (
        typeof flowCandidate === 'function' &&
        !('isFlow' in flowCandidate && (flowCandidate as { isFlow?: unknown }).isFlow)
    ) {
        return (flowCandidate as () => Flow)();
    }
    return flowCandidate as Flow;
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
        console.log('1.3.0');
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

            case 'skills': {
                const subCommand = target || 'install';
                if (subCommand === 'install' || subCommand === 'add') {
                    const dirOption = getOption(args, '--dir=');
                    const targetDir = dirOption
                        ? path.resolve(process.cwd(), dirOption)
                        : path.resolve(process.cwd(), '.agents', 'skills');
                    const res = installSkills(targetDir);
                    console.log(
                        `\n✔ Installed ${res.skillsInstalled.length} Siglo Agent Skills into ${res.destination}`,
                    );
                    for (const s of res.skillsInstalled) {
                        console.log(`  + ${s}`);
                    }
                } else {
                    console.error(`Unknown skills command: '${subCommand}'. Use 'install'.`);
                    process.exit(1);
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
                        if (!match || match[1] in options)
                            throw new Error(`Invalid or duplicate generator option: ${arg}`);
                        options[match[1]] =
                            match[1] === 'interactive'
                                ? match[2] === 'true'
                                    ? true
                                    : match[2] === 'false'
                                      ? false
                                      : match[2]
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
                const format = parseEnumOption(
                    getOption(args, '--format='),
                    ['mermaid', 'dot', 'json'] as const,
                    'mermaid',
                    '--format',
                );
                const direction = parseEnumOption(
                    getOption(args, '--direction='),
                    ['TD', 'LR', 'TB'] as const,
                    'TD',
                    '--direction',
                );
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
                    console.log('✔ Workflow graph definition is valid (no cycles, reachable exit).');
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
                const redactArg = getOption(args, '--redact=');
                const redact = redactArg ? redactArg.split(',') : undefined;
                const insp = inspectWorkflow(wf, { redact });

                writeOutput(JSON.stringify(insp, null, 2), outArg);
                break;
            }

            case 'checkpoint': {
                if (!target) {
                    console.error('Error: specify checkpoint file path (e.g. siglo checkpoint checkpoint.json)');
                    process.exit(1);
                }
                const resolved = path.resolve(process.cwd(), target);
                if (!fs.existsSync(resolved)) {
                    throw new Error(`Checkpoint file not found: ${resolved}`);
                }
                const redactArg = getOption(args, '--redact=');
                const redact = redactArg ? redactArg.split(',') : undefined;
                const insp = inspectCheckpoint(fs.readFileSync(resolved, 'utf-8'), { redact });
                writeOutput(JSON.stringify(insp, null, 2), outArg);
                break;
            }

            case 'replay': {
                const fixturePath = target;
                const workflowPath = args[2];
                if (!fixturePath || !workflowPath) {
                    console.error(
                        'Error: specify fixture and workflow (e.g. siglo replay fixture.json src/workflow.ts)',
                    );
                    process.exit(1);
                }
                const wf = await loadWorkflowFromFile(workflowPath);
                const result = await replayFixture(wf, fixturePath);
                if (result.success) {
                    console.log(`✔ Replay passed in ${result.durationMs}ms`);
                } else {
                    console.error(`✖ Replay failed in ${result.durationMs}ms`);
                    if (result.diff) {
                        console.error('Discrepancies found:', JSON.stringify(result.diff, null, 2));
                    }
                    process.exit(1);
                }
                break;
            }

            case 'monitor': {
                const portArg = getOption(args, '--port=');
                const port = portArg !== undefined ? Number(portArg) : 4000;
                if (!Number.isInteger(port) || port < 0 || port > 65535) {
                    throw new Error(`Invalid --port value '${portArg}'`);
                }
                const host = getOption(args, '--host=') || '127.0.0.1';
                const namespace = getOption(args, '--namespace=');
                let flowCandidate: Flow | undefined;
                if (target) {
                    flowCandidate = await loadWorkflowFromFile(target);
                }
                console.log(`Starting Siglo Monitor dev dashboard on http://${host}:${port} ...`);
                await startMonitor({ port, host, namespace, flow: flowCandidate });
                break;
            }

            case 'reconcile': {
                let flowCandidate: Flow | undefined;
                if (target) {
                    flowCandidate = await loadWorkflowFromFile(target);
                }
                const staleThreshold = getOption(args, '--stale=');
                const action = parseEnumOption(
                    getOption(args, '--action='),
                    ['compensate', 'fail', 'inspect'] as const,
                    'compensate',
                    '--action',
                );
                const mode = parseEnumOption(
                    getOption(args, '--mode='),
                    ['strict', 'best-effort'] as const,
                    'best-effort',
                    '--mode',
                );
                const namespace = getOption(args, '--namespace=');

                console.log(`Reconciling abandoned workflow executions (threshold: ${staleThreshold || '10m'})...`);
                const report = await reconcileCommand({
                    staleThreshold,
                    action,
                    mode,
                    namespace,
                    flow: flowCandidate,
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
    } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main();
