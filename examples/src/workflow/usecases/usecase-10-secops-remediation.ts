import { Step, flow } from 'siglo';

export interface SecOpsIncidentInput {
    alertId: string;
    clusterName: string;
    nodeId: string;
    podId: string;
    anomalyMetric: string;
    metricValue: number;
    threshold: number;
    severity: 'HIGH' | 'CRITICAL';
    maintenanceWindowActive?: boolean;
}

/**
 * Use Case 10: Automated SecOps & Infrastructure Incident Remediation
 * Flow: receiveMonitoringAlert -> correlateLogs -> executeRemediation -> verifyHealth -> postSlackSummary
 * Features:
 * - Safe execution lifecycle with onBefore check verifying no maintenance conflicts
 * - Diagnostic log correlation and automated containment (cordoning node, terminating compromised pod)
 * - Forensic incident envelope capturing full execution context and Slack dispatch
 * - Step.create(...) for idiomatic POJO parameter unwrapping
 */
export function createSecOpsRemediationPipeline() {
    // Step 1: Receive Monitoring Alert
    const receiveMonitoringAlert = Step.create('secopsReceiveAlert', async (param: any) => {
        const { alertId, clusterName: cluster, severity, anomalyMetric: metric } = param;

        return {
            incidentRegistered: true,
            incidentTicket: `INC-${alertId}`,
            cluster,
            severity,
            metric
        };
    })
      .spec('alertId', { require: true })
      .spec('clusterName', { require: true })
      .spec('nodeId', { require: true })
      .spec('podId', { require: true });

    // Step 2: Correlate Logs & Validate Blast Radius (with onBefore safety check)
    const correlateLogs = Step.create('secopsCorrelateLogs', async (param: any) => {
        const { podId, nodeId } = param;

        // Correlate logs to find runaway CPU process / abnormal outbound traffic
        return {
            rootCauseIdentified: true,
            suspectProcess: 'crypto_miner_daemon',
            affectedPod: podId,
            hostNode: nodeId,
            blastRadius: 'ISOLATED_POD'
        };
    }).onBefore(async (param: any) => {
        // Enforce safety constraint: Ensure remediation is allowed unless maintenance freeze
        const isMaintenance = typeof param?.maintenanceWindowActive === 'function'
            ? param.maintenanceWindowActive()
            : (param?.maintenanceWindowActive?.val ?? param?.maintenanceWindowActive ?? false);
        if (isMaintenance) {
            console.log('[SecOps Safety] Maintenance window active, pausing automated disruption');
            return false;
        }
        return true;
    });

    // Step 3: Execute Remediation Actions
    const executeRemediation = Step.create('secopsExecuteRemediation', async (param: any) => {
        const { affectedPod, hostNode } = param;

        // Actions: 1) Cordon node, 2) Terminate rogue pod, 3) Rotate node service account token
        const actionsTaken = [
            `kubectl cordon ${hostNode}`,
            `kubectl delete pod ${affectedPod} --force --grace-period=0`,
            `vault token revoke -role=k8s-node-${hostNode}`
        ];

        return {
            remediationExecuted: true,
            actionsTaken,
            quarantinedNode: hostNode,
            terminatedPod: affectedPod
        };
    });

    // Step 4: Verify Infrastructure Health Post-Remediation
    const verifyHealth = Step.create('secopsVerifyHealth', async () => {
        // Health check telemetry returns to normal baseline
        return {
            clusterHealthy: true,
            cpuUtilizationPercent: 24.2,
            memoryUtilizationPercent: 41.5,
            healthStatus: 'HEALTHY'
        };
    });

    // Step 5: Post Slack Incident Post-Mortem Summary
    const postSlackSummary = Step.create('secopsPostSlackSummary', async (param: any) => {
        const {
            incidentTicket,
            cluster,
            actionsTaken: actions,
            healthStatus: health,
            incidentRegistered,
            rootCauseIdentified,
            remediationExecuted,
            quarantinedNode,
            clusterHealthy
        } = param;

        const slackMessage = `🚨 *Resolved Incident:* ${incidentTicket} on cluster \`${cluster}\`\n` +
            `*Actions:* ${actions.join('; ')}\n` +
            `*Cluster Health:* ${health}`;

        return {
            secopsPipelineStatus: 'RESOLVED',
            incidentTicket,
            incidentRegistered,
            rootCauseIdentified,
            remediationExecuted,
            quarantinedNode,
            clusterHealthy,
            slackDispatched: true,
            slackChannel: '#secops-alerts',
            slackMessage,
            resolvedAt: new Date().toISOString()
        };
    });

    return flow(
        receiveMonitoringAlert,
        correlateLogs,
        executeRemediation,
        verifyHealth,
        postSlackSummary
    );
}
