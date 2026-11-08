import { Step, flow } from '@siglo/core';

export interface KycApplicationInput {
    applicantId: string;
    fullName: string;
    country: string;
    idType: 'PASSPORT' | 'DRIVERS_LICENSE';
    documentNumber: string;
    documentBase64: string;
    selfieBase64: string;
}

/**
 * Use Case 7: Customer Onboarding & Identity Verification (KYC/AML)
 * Flow: submitApplication -> ocrDocument -> verifyFacialBiometrics -> screenSanctionsWatchlist -> activateAccount
 * Features:
 * - Sensitive PII isolation: raw biometrics & passport images stay in encrypted storage hooks
 * - Multi-service orchestration: OCR scanning, biometric facial matching, OFAC watchlist screening
 * - Automatic retry policy with onFail for external compliance gateway requests
 * - Step.create(...) for idiomatic POJO parameter access
 */
export function createKycOnboardingPipeline() {
    let ocrAttempts = 0;

    // Step 1: Submit Application
    const submitApplication = Step.create('kycSubmitApplication', async (param: any) => {
        const { applicantId } = param;

        return {
            applicationReceived: true,
            submissionId: `KYC-SUB-${applicantId}`,
            submittedAt: Date.now(),
        };
    })
        .spec('applicantId', { require: true })
        .spec('fullName', { require: true })
        .spec('documentNumber', { require: true });

    // Step 2: OCR Document Parsing (with onFail retries for external service latency)
    const ocrDocument = Step.create('kycOcrDocument', async (param: any) => {
        ocrAttempts++;
        const docNum = param.documentNumber;

        // Simulate transient OCR gateway hiccup on initial try
        if (ocrAttempts === 1) {
            throw new Error('OCR external service gateway timeout (HTTP 504)');
        }

        return {
            ocrSuccess: true,
            extractedDocumentNumber: docNum,
            extractedBirthDate: '1985-06-15',
            documentExpiry: '2030-01-01',
            mrzChecksumValid: true,
        };
    }).onFail({
        maxRetries: 2,
        delay: 15,
        backoff: 'exponential',
    });

    // Step 3: Verify Facial Biometrics (Selfie vs Document photo)
    const verifyFacialBiometrics = Step.create('kycVerifyFacialBiometrics', async () => {
        // Simulated liveness and 1:1 facial match computation
        const matchConfidence = 0.98; // 98% similarity
        const livenessCheckPassed = true;

        if (matchConfidence < 0.9 || !livenessCheckPassed) {
            throw new Error(`Facial biometric match failed: confidence ${matchConfidence} is below 0.90 threshold`);
        }

        return {
            biometricsVerified: true,
            matchConfidence,
            livenessCheckPassed,
        };
    });

    // Step 4: Screen Sanctions & AML Watchlist
    const screenSanctionsWatchlist = Step.create('kycScreenSanctions', async (param: any) => {
        const { fullName } = param;

        // Check against known sanction lists (OFAC, PEP, Interpol)
        const sanctionedNames = ['BLOFIELD', 'VILLAIN_X'];
        const isSanctioned = sanctionedNames.some(name => fullName.toUpperCase().includes(name));

        if (isSanctioned) {
            throw new Error(`AML Sanctions alert: Applicant ${fullName} appears on high-risk watch list`);
        }

        return {
            sanctionsScreeningPassed: true,
            riskClassification: 'LOW',
            checkedDatabases: ['OFAC_SDN', 'UN_SANCTIONS', 'PEP_GLOBAL'],
        };
    });

    // Step 5: Activate Account
    const activateAccount = Step.create('kycActivateAccount', async (param: any) => {
        const {
            applicantId,
            submissionId,
            applicationReceived,
            ocrSuccess,
            biometricsVerified,
            matchConfidence,
            sanctionsScreeningPassed,
        } = param;

        const customerAccountNumber = `ACC-${Math.floor(100000000 + Math.random() * 900000000)}`;

        return {
            kycPipelineStatus: 'APPROVED',
            applicantId,
            submissionId,
            applicationReceived,
            ocrSuccess,
            biometricsVerified,
            matchConfidence,
            sanctionsScreeningPassed,
            customerAccountNumber,
            accountStatus: 'ACTIVE',
            approvedAt: new Date().toISOString(),
        };
    });

    return flow(submitApplication, ocrDocument, verifyFacialBiometrics, screenSanctionsWatchlist, activateAccount);
}
