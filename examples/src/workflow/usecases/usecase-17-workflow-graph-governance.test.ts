import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowFile } from '@siglo/ide-analysis';

// Static governance can run before deployment without invoking any workflow action.
test('deployment source governance detects duplicate IDs and clears diagnostics after correction', () => {
    const source = `import { Step, flow } from '@siglo/core';
const build = Step.create('build', () => { throw new Error('must never execute'); });
const scan = Step.create('build', () => ({}));
export const deploy = flow(build, scan);`;
    const before = parseWorkflowFile({ uri: '/deployment.ts', content: source });
    assert.equal(before.diagnostics.filter(d => d.code === 'SIGLO_DUPLICATE_STEP_ID').length, 2);
    const corrected = source.replace("const scan = Step.create('build'", "const scan = Step.create('securityScan'");
    const after = parseWorkflowFile({ uri: '/deployment.ts', content: corrected });
    assert.equal(after.diagnostics.length, 0);
    assert.ok(after.nodes.some(node => node.name === 'securityScan'));
});
