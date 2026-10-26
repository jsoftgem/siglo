import { expect } from 'chai';
import Step, {
    flow,
    parallel,
    branch,
    wait,
    map,
    toMermaid,
    toJSON,
    toDot
} from '../../index';

describe('Phase 4: TypeScript and Developer Experience', () => {
    describe('Accumulated Context & Typed Step History', () => {
        it('should accumulate context across sequential steps and record history', async () => {
            const step1 = Step.create('fetchUser', (param: { userId: string }) => {
                return { name: 'Alice', age: 30 };
            });

            const step2 = Step.create('enrichProfile', (param: { name: string; age: number; $steps?: any }) => {
                expect(param.name).to.equal('Alice');
                expect(param.age).to.equal(30);
                expect(param.$steps?.fetchUser).to.deep.equal({ name: 'Alice', age: 30 });
                return { role: 'admin' };
            });

            const workflow = flow(step1, step2);
            const result = await workflow.run({ userId: 'u-123' }, { pojo: true });

            expect(result.name).to.equal('Alice');
            expect(result.age).to.equal(30);
            expect(result.role).to.equal('admin');
            expect(result.$steps?.fetchUser).to.deep.equal({ name: 'Alice', age: 30 });
            expect(result.$steps?.enrichProfile).to.deep.equal({ role: 'admin' });
        });

        it('should handle void step output without altering context', async () => {
            const step1 = Step.create('init', () => ({ count: 1 }));
            const step2 = Step.create('noop', (_param: { count: number }) => {
                // returns undefined / void
            });
            const step3 = Step.create('inc', (param: { count: number }) => ({ count: param.count + 1 }));

            const workflow = flow(step1, step2, step3);
            const result = await workflow.run({}, { pojo: true });
            expect(result.count).to.equal(2);
        });
    });

    describe('Dependency Injection & Services', () => {
        it('should inject step-level dependencies via withDependencies() and requireDependency()', async () => {
            const step = Step.create('callApi', (param: any) => {
                const client = param.$services?.apiClient || param.$dependencies?.apiClient;
                return { fetched: client.getData() };
            });

            step.withDependencies({
                apiClient: { getData: () => 'from-dep' }
            });

            expect(step.requireDependency('apiClient')).to.deep.equal({ getData: step.dependencies!.apiClient.getData });
            expect(() => step.requireDependency('missingDep')).to.throw("Missing required dependency 'missingDep' for step 'callApi'");

            const anonStep = Step.create(() => ({}));
            expect(() => anonStep.requireDependency('foo')).to.throw("Missing required dependency 'foo' for step 'anonymous'");

            const result = await step.execute({}, { pojo: true });
            expect(result.fetched).to.equal('from-dep');
        });

        it('should inject workflow-level services via options.services and merge with step dependencies', async () => {
            const loggerMock = { log: (msg: string) => msg };
            const dbMock = { query: () => ['row1'] };

            let capturedServices: any;
            let capturedDeps: any;
            let capturedDollarDeps: any;

            const step = Step.create('dbStep', (param: any) => {
                capturedServices = param.$services;
                capturedDeps = param.$dependencies;
                capturedDollarDeps = param.$deps;
                return {
                    dbResult: param.$services.db.query(),
                    logged: param.$services.logger.log('hello')
                };
            }).withDependencies({
                db: dbMock
            });

            const wf = flow(step);
            const result = await wf.run({}, {
                pojo: true,
                services: {
                    logger: loggerMock
                }
            });

            expect(result.dbResult).to.deep.equal(['row1']);
            expect(result.logged).to.equal('hello');
            expect(capturedServices.logger).to.equal(loggerMock);
            expect(capturedServices.db).to.equal(dbMock);
            expect(capturedDeps).to.equal(capturedServices);
            expect(capturedDollarDeps).to.equal(capturedServices);
        });

        it('should support options.dependencies fallback for services', async () => {
            const step = Step.create('testStep', (param: any) => {
                return { configVal: param.$services.config.env };
            });

            const res = await step.execute({}, {
                pojo: true,
                dependencies: {
                    config: { env: 'staging' }
                }
            });

            expect(res.configVal).to.equal('staging');
        });
    });

    describe('Workflow Visualization & Export APIs', () => {
        it('should export workflow and steps to Mermaid diagram with badges', () => {
            const s1 = Step.create('step1', () => ({ a: 1 }))
                .timeout(5000)
                .onFail({ maxRetries: 3, delayMs: 100 })
                .cache(2000)
                .compensate(() => {});

            const s2 = wait(1000, { name: 'waitAWhile' });
            const s3 = branch(
                (p: any) => p.a === 1,
                Step.create('branchTrue', () => ({ ok: true })),
                Step.create('branchFalse', () => ({ ok: false }))
            );
            const s4 = parallel([
                Step.create('parallelA', () => ({ a: 'done' })),
                Step.create('parallelB', () => ({ b: 'done' }))
            ]);
            const s5 = map(
                (p: any) => p.items,
                Step.create('mapItem', (item: any) => item * 2)
            );

            const wf = flow(s1, s2, s3, s4, s5);

            // flow.toMermaid()
            const mermaidTD = wf.toMermaid();
            expect(mermaidTD).to.include('flowchart TD');
            expect(mermaidTD).to.include('⏱️ 5000ms');
            expect(mermaidTD).to.include('🔁 retry(3)');
            expect(mermaidTD).to.include('⏪ saga');
            expect(mermaidTD).to.include('💾 cache');
            expect(mermaidTD).to.include('⏳ wait');

            // options.direction & includeBadges
            const mermaidLR = toMermaid(wf, { direction: 'LR', includeBadges: false });
            expect(mermaidLR).to.include('flowchart LR');
            expect(mermaidLR).to.not.include('⏱️');

            // static Step.toMermaid
            const stepMermaid = Step.toMermaid(s1);
            expect(stepMermaid).to.include('flowchart TD');
            expect(stepMermaid).to.include('step1');
        });

        it('should export workflow to JSON AST and sanitize functions', () => {
            const s1 = Step.create('step1', () => ({ a: 1 }));
            const s2 = Step.create('step2', () => ({ b: 2 }));
            const wf = flow(s1, s2);

            const jsonStr = wf.toJSON();
            const parsed = JSON.parse(jsonStr);
            expect(parsed).to.have.property('type', 'sequence');
            expect(parsed).to.have.property('children');
            expect(parsed.children[0]).to.have.property('name', 'step1');
            expect(jsonStr).to.not.include('"action"');

            // Static Step.toJSON
            const stepJson = Step.toJSON(s1);
            const parsedStep = JSON.parse(stepJson);
            expect(parsedStep.name).to.equal('step1');
        });

        it('should export workflow to Graphviz DOT format', () => {
            const s1 = Step.create('step1', () => ({ a: 1 }))
                .timeout(3000)
                .onFail({ retries: 2 });
            const s2 = wait(500, { name: 'timerWait' });
            const s3 = branch(
                () => true,
                Step.create('branchA', () => ({})),
                Step.create('branchB', () => ({}))
            );
            const s4 = parallel([Step.create('pA', () => ({}))]);
            const s5 = map((p: any) => p.list, Step.create('mItem', () => ({})));

            const wf = flow(s1, s2, s3, s4, s5);

            const dotStr = wf.toDot({ graphName: 'CustomPipeline', direction: 'LR' });
            expect(dotStr).to.include('digraph CustomPipeline {');
            expect(dotStr).to.include('rankdir=LR;');
            expect(dotStr).to.include('shape=diamond');
            expect(dotStr).to.include('shape=ellipse');
            expect(dotStr).to.include('shape=component');
            expect(dotStr).to.include('shape=parallelogram');
            expect(dotStr).to.include('->');

            // Static Step.toDot
            const stepDot = Step.toDot(s1);
            expect(stepDot).to.include('digraph Workflow {');
            expect(stepDot).to.include('rankdir=TB;');
        });

        it('should format retry badge with auto when retries and maxRetries are undefined', () => {
            const s = Step.create('retryAuto', () => ({})).onFail({} as any);
            const mermaid = toMermaid(s);
            expect(mermaid).to.include('retry(auto)');
        });
    });
});
