import { Step, flow, parallel, toGraph, validateGraph, inspectGraph, assertValidGraph } from 'rivulet';

export interface DeploymentInput {
    releaseId: string;
    commitSha: string;
    environment: 'staging' | 'production';
}

/**
 * Use Case 17: CI/CD Pipeline Governance with Workflow Graph AST Inspection
 * Features demonstrated:
 * - toGraph(workflow): Compilation of workflows into pure WorkflowNode ASTs
 * - validateGraph(graph): Static graph cycle validation and integrity checking
 * - inspectGraph(graph): Topological calculation of depth, node counts, and edges
 * - Automated governance guardrails enforcing security steps in workflow AST
 */
export function createGovernedDeploymentPipeline() {
    // Stage 1: Build & Package
    const buildPackage = Step.create('buildPackage', async (param: any) => ({
        artifactUrl: `https://artifacts.corp/builds/${param.commitSha}.tar.gz`,
        buildSuccess: true
    })).modern();

    // Stage 2: Parallel Quality & Compliance Checks
    const runUnitTests = Step.create('runUnitTests', async () => ({ unitTestsPassed: true })).modern();
    const runSecurityScan = Step.create('runSecurityScan', async () => ({
        cveVulnerabilitiesCount: 0,
        securityPassed: true
    })).modern();
    const runLicenseAudit = Step.create('runLicenseAudit', async () => ({ licenseCompliant: true })).modern();

    const qualityGate = parallel(runUnitTests, runSecurityScan, runLicenseAudit);

    // Stage 3: Deploy to Target Cluster
    const deployToCluster = Step.create('deployToCluster', async (param: any) => ({
        deploymentStatus: 'DEPLOYED',
        releaseId: param.releaseId,
        activeCluster: `k8s-${param.environment}-cluster-1`
    })).modern();

    // Compose Full Workflow
    const deploymentWorkflow = flow(
        buildPackage,
        qualityGate,
        deployToCluster
    );

    // Governance Inspection Function
    function auditWorkflowGovernance() {
        const ast = toGraph(deploymentWorkflow);

        // 1. Assert Acyclic Graph
        assertValidGraph(ast);
        const validation = validateGraph(ast);

        // 2. Structural Inspection
        const metrics = inspectGraph(deploymentWorkflow);

        // 3. Policy Enforcement: Security Scan step MUST be present in the AST
        const nodeNames = metrics.nodes.map(n => n.name);
        const hasSecurityScan = nodeNames.includes('runSecurityScan');
        if (!hasSecurityScan) {
            throw new Error('Compliance Violation: Workflow does not contain required runSecurityScan step');
        }

        return {
            isCompliant: validation.valid && hasSecurityScan,
            metrics,
            validation
        };
    }

    return {
        workflow: deploymentWorkflow,
        auditWorkflowGovernance
    };
}
