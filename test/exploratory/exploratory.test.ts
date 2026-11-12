/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { charterRegistry } from './registry';
import { runAllExploratoryCharters } from './runner';

describe('Automated Exploratory Testing Suite', function () {
    this.timeout(30000);
    for (const charter of charterRegistry.filter(c => !c.integration)) {
        it(charter.id, async () => {
            const result = await runAllExploratoryCharters({
                iterations: charter.smokeIterations,
                seed: 100,
                charterFilter: charter.id,
            });
            assert.equal(result.passed, true, result.results.flatMap(r => r.errors).join('\n'));
        });
    }
});
