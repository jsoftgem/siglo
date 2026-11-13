import { expect } from 'chai';
import { Step, flow } from '../step';
import { parallel } from '../combinators';
import Configurator from '../configurator';
import ResolveChain from './SingleChain/Helpers/ResolveChain';

describe('local step result observation', () => {
    it('observes resolved output after enrichment without redacting application data', async () => {
        Configurator.configure({
            plugins: [
                {
                    name: 'enriched',
                    action: () => true,
                    after: ['first'],
                },
            ],
        });
        const seen: Array<{ name: string; output: any }> = [];
        const first = Step.create('first', () => ({ email: 'test@example.com' }));
        const second = Step.create('second', () => ({ done: true }));
        await flow(first, second).run({}, { pojo: true, onStepResult: (name, output) => seen.push({ name, output }) });
        expect(seen.map(item => item.name)).to.deep.equal(['first', 'second']);
        expect(seen[0].output.email).to.equal('test@example.com');
        expect(seen[0].output.enriched).to.equal(true);
    });

    it('retains runtime references on nested graph leaves without serializing them', () => {
        const step = Step.create('nested', () => ({ ok: true }));
        const graph: any = flow(parallel(step)).toGraph();
        expect(graph.branches[0].step).to.equal(step);
        expect(JSON.stringify(graph)).not.to.contain('"step":');
    });

    it('notifies onStepResult for null context', done => {
        let notified = false;
        new ResolveChain(
            () => {
                expect(notified).to.be.true;
                done();
            },
            null,
            'null_step',
            () => {},
            undefined,
            undefined,
            undefined,
            {
                onStepResult: (name: string, val: any) => {
                    notified = true;
                    expect(name).to.equal('null_step');
                    expect(val).to.be.null;
                },
            },
        );
    });
});
