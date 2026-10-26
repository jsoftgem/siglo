import { Step, flow } from 'fluid-func';

export interface RawTelemetryReading {
    sensorId: string;
    temperatureFahrenheit: number;
    pressurePsi: number;
    vibrationG: number;
    recordedAt: number;
}

export interface IotBatchInput {
    deviceId: string;
    fleetId: string;
    readings: RawTelemetryReading[];
    batchSequence: number;
}

/**
 * Use Case 5: High-Throughput IoT Telemetry & Anomaly Detection
 * Flow: ingestSensorBatch -> normalizeUnits -> evaluateThresholds -> triggerAlert -> archiveColdStorage
 * Features:
 * - Data normalization via spec transformer converting raw sensor units (Fahrenheit to Celsius, PSI to Bar)
 * - Real-time threshold evaluation for industrial IoT anomalies
 * - Partition-ready cold storage serialization
 * - Step.create(...).modern() for idiomatic POJO parameter unwrapping
 */
export function createIotTelemetryPipeline() {
    // Step 1: Ingest Sensor Batch
    const ingestSensorBatch = Step.create('iotIngestSensorBatch', async (param: any) => {
        const { readings } = param;

        return {
            batchAccepted: true,
            sampleCount: readings.length,
            ingestedAt: Date.now()
        };
    }).modern()
      .spec('deviceId', { require: true })
      .spec('readings', {
          require: true,
          validator: async (r: any[]) => {
              if (!Array.isArray(r) || r.length === 0) {
                  throw new Error('Readings must be a non-empty array');
              }
          }
      });

    // Step 2: Normalize Units (Fahrenheit -> Celsius, PSI -> Bar)
    const normalizeUnits = Step.create('iotNormalizeUnits', async (param: any) => {
        const readings: RawTelemetryReading[] = param.readings;

        const normalized = readings.map(r => ({
            sensorId: r.sensorId,
            temperatureCelsius: +(((r.temperatureFahrenheit - 32) * 5) / 9).toFixed(2),
            pressureBar: +(r.pressurePsi * 0.0689476).toFixed(2),
            vibrationG: r.vibrationG,
            timestamp: r.recordedAt
        }));

        // Compute batch averages
        const avgTempCelsius = +(normalized.reduce((s, r) => s + r.temperatureCelsius, 0) / normalized.length).toFixed(2);
        const avgPressureBar = +(normalized.reduce((s, r) => s + r.pressureBar, 0) / normalized.length).toFixed(2);
        const maxVibration = Math.max(...normalized.map(r => r.vibrationG));

        return {
            normalizedReadings: normalized,
            metrics: {
                avgTempCelsius,
                avgPressureBar,
                maxVibration
            }
        };
    }).modern();

    // Step 3: Evaluate Thresholds for Anomalies
    const evaluateThresholds = Step.create('iotEvaluateThresholds', async (param: any) => {
        const metrics = param.metrics;

        const isOverheated = metrics.avgTempCelsius > 80.0; // > 80C threshold
        const isOverpressured = metrics.avgPressureBar > 10.0; // > 10 Bar threshold
        const isExcessiveVibration = metrics.maxVibration > 4.5; // > 4.5G vibration threshold

        const hasAnomaly = isOverheated || isOverpressured || isExcessiveVibration;
        const reasons: string[] = [];

        if (isOverheated) reasons.push(`Overheating detected (${metrics.avgTempCelsius}°C > 80°C)`);
        if (isOverpressured) reasons.push(`Overpressure detected (${metrics.avgPressureBar} Bar > 10 Bar)`);
        if (isExcessiveVibration) reasons.push(`Excessive vibration detected (${metrics.maxVibration}G > 4.5G)`);

        return {
            anomalyDetected: hasAnomaly,
            severity: isOverheated && isOverpressured ? 'CRITICAL' : hasAnomaly ? 'WARNING' : 'NORMAL',
            anomalyReasons: reasons
        };
    }).modern();

    // Step 4: Trigger Alert (if anomaly detected)
    const triggerAlert = Step.create('iotTriggerAlert', async (param: any) => {
        const { deviceId, anomalyDetected, severity, anomalyReasons: reasons } = param;

        let alertDispatched = false;
        let alertId: string | null = null;

        if (anomalyDetected) {
            alertDispatched = true;
            alertId = `ALERT-${deviceId}-${Date.now()}`;
        }

        return {
            alertDispatched,
            alertId,
            alertSummary: anomalyDetected ? `[${severity}] ${reasons.join(', ')}` : 'All metrics nominal'
        };
    }).modern();

    // Step 5: Archive Cold Storage (Parquet / S3 partitioning)
    const archiveColdStorage = Step.create('iotArchiveColdStorage', async (param: any) => {
        const { deviceId, fleetId, sampleCount, metrics, alertDispatched, alertId, anomalyDetected, batchAccepted } = param;

        const coldStoragePartition = `year=2026/month=10/fleet=${fleetId}/device=${deviceId}`;
        const archiveKey = `s3://telemetry-lakehouse/${coldStoragePartition}/batch_${Date.now()}.parquet`;

        return {
            iotPipelineStatus: 'PROCESSED',
            batchAccepted,
            deviceId,
            fleetId,
            sampleCount,
            samplesArchived: sampleCount,
            metrics,
            anomalyDetected,
            alertDispatched,
            alertId,
            archiveKey,
            archivedAt: new Date().toISOString()
        };
    }).modern();

    return flow(
        ingestSensorBatch,
        normalizeUnits,
        evaluateThresholds,
        triggerAlert,
        archiveColdStorage
    );
}
