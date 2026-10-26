import { expect } from 'chai';
import { WorkflowNodeType } from './WorkflowNodeType';

describe('shared.workflowNodeType.unit.test', () => {
    it('defines standard workflow node types', () => {
        expect(WorkflowNodeType.STEP).to.equal('step');
        expect(WorkflowNodeType.SEQUENCE).to.equal('sequence');
        expect(WorkflowNodeType.PARALLEL).to.equal('parallel');
        expect(WorkflowNodeType.BRANCH).to.equal('branch');
        expect(WorkflowNodeType.WAIT).to.equal('wait');
        expect(WorkflowNodeType.MAP).to.equal('map');
    });
});
