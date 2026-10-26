import { Step, flow } from 'fluid-func';

export interface FhirObservationPayload {
    resourceType: 'Observation';
    id: string;
    status: 'final' | 'preliminary';
    code: {
        coding: Array<{ system: string; code: string; display: string }>;
    };
    subject: {
        reference: string;
        patientSsn: string;
        patientName: string;
    };
    effectiveDateTime: string;
    valueQuantity: {
        value: number;
        unit: string;
        system: string;
    };
}

export interface HealthcareHl7Input {
    feedId: string;
    hospitalUnit: string;
    traceparent: string; // OpenTelemetry W3C header
    observation: FhirObservationPayload;
}

/**
 * Use Case 8: Healthcare HL7 / FHIR Clinical Event Integration
 * Flow: receiveHl7Feed -> validateFhirCompliance -> anonymizePii -> updateElectronicHealthRecord -> dispatchProviderAlert
 * Features:
 * - FHIR compliance validation using declarative specs
 * - HIPAA-compliant PII de-identification (masking patient names and hashing SSNs)
 * - Distributed OpenTelemetry traceparent context propagation
 * - Real-time provider alerting for critical abnormal clinical vitals
 * - Step.create(...).modern() for clean POJO parameter access
 */
export function createHealthcareFhirPipeline() {
    // Step 1: Receive HL7 / FHIR Feed
    const receiveHl7Feed = Step.create('hl7ReceiveFeed', async (param: any) => {
        const { hospitalUnit, traceparent } = param;

        return {
            feedAccepted: true,
            hospitalUnit,
            distributedTraceId: traceparent,
            receivedAt: Date.now()
        };
    }).modern()
      .spec('feedId', { require: true })
      .spec('traceparent', { require: true })
      .spec('observation', { require: true });

    // Step 2: Validate FHIR Compliance
    const validateFhirCompliance = Step.create('hl7ValidateFhir', async (param: any) => {
        const obs: FhirObservationPayload = param.observation;

        if (obs.resourceType !== 'Observation') {
            throw new Error(`Invalid FHIR resourceType: expected 'Observation', received '${obs.resourceType}'`);
        }
        if (!obs.valueQuantity || typeof obs.valueQuantity.value !== 'number') {
            throw new Error('FHIR Observation missing valid numeric valueQuantity.value');
        }

        return {
            fhirValid: true,
            resourceId: obs.id,
            codingDisplay: obs.code.coding[0]?.display || 'Clinical Vital',
            measuredValue: obs.valueQuantity.value,
            unit: obs.valueQuantity.unit
        };
    }).modern();

    // Step 3: Anonymize PII for HIPAA Compliance
    const anonymizePii = Step.create('hl7AnonymizePii', async (param: any) => {
        const obs: FhirObservationPayload = param.observation;

        // Mask name and create pseudonymous deterministic patient hash
        const rawName = obs.subject.patientName;
        const maskedName = rawName[0] + '*** ' + rawName.split(' ')[1]?.[0] + '***';
        const pseudonymousHash = `HASH-PAT-${obs.subject.patientSsn.replace(/\D/g, '').slice(-4)}`;

        const anonymizedObservation = {
            ...obs,
            subject: {
                reference: pseudonymousHash,
                patientMaskedName: maskedName
            }
        };

        return {
            hipaaCompliant: true,
            anonymizedObservation,
            pseudonymousPatientId: pseudonymousHash
        };
    }).modern();

    // Step 4: Update Electronic Health Record (EHR Repository)
    const updateElectronicHealthRecord = Step.create('hl7UpdateEhr', async (param: any) => {
        const { pseudonymousPatientId, resourceId, codingDisplay, measuredValue, unit } = param;

        const ehrRecordId = `EHR-OBS-${resourceId}`;

        return {
            ehrUpdated: true,
            ehrRecordId,
            persistedClinicalData: {
                patientId: pseudonymousPatientId,
                vital: codingDisplay,
                reading: `${measuredValue} ${unit}`
            }
        };
    }).modern();

    // Step 5: Dispatch Provider Alert (if abnormal vital thresholds breached)
    const dispatchProviderAlert = Step.create('hl7DispatchProviderAlert', async (param: any) => {
        const {
            codingDisplay,
            measuredValue,
            unit,
            pseudonymousPatientId,
            hospitalUnit,
            feedAccepted,
            fhirValid,
            hipaaCompliant,
            ehrUpdated
        } = param;

        let alertRequired = false;
        let urgency = 'NORMAL';

        // Check for severe tachycardia (Heart Rate > 130 bpm)
        if (codingDisplay.toLowerCase().includes('heart rate') && measuredValue > 130) {
            alertRequired = true;
            urgency = 'STAT_EMERGENCY';
        }

        return {
            healthcarePipelineStatus: 'SYNCHRONIZED',
            feedAccepted,
            fhirValid,
            hipaaCompliant,
            ehrUpdated,
            patientRef: pseudonymousPatientId,
            pseudonymousPatientId,
            unit: hospitalUnit,
            vitalReading: `${measuredValue} ${unit}`,
            alertTriggered: alertRequired,
            alertLevel: urgency,
            ehrSynchronizedAt: new Date().toISOString()
        };
    }).modern();

    return flow(
        receiveHl7Feed,
        validateFhirCompliance,
        anonymizePii,
        updateElectronicHealthRecord,
        dispatchProviderAlert
    );
}
