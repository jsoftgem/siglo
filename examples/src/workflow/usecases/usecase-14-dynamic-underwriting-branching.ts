import { Step, flow, branch, when } from '@siglo/core';

export interface LoanApplicationInput {
    applicationId: string;
    applicantName: string;
    creditScore: number;
    annualIncome: number;
    requestedAmount: number;
    hasPartnerPromo?: boolean;
}

/**
 * Use Case 14: Dynamic Loan Underwriting Engine with Multi-Path Routing
 * Features demonstrated:
 * - branch(selector, branches, defaultBranch): Multi-way dynamic branch routing
 * - when(predicate, thenStep, elseStep): Conditional branching with fallback
 * - Branch context isolation & execution metadata recording
 */
export function createLoanUnderwritingPipeline() {
    // Step 1: Ingest Application & Determine Risk Tier
    const classifyRiskTier = Step.create('classifyRiskTier', async (param: any) => {
        const score = param.creditScore;
        let riskTier = 'SUBPRIME';
        if (score >= 750) {
            riskTier = 'PRIME';
        } else if (score >= 650) {
            riskTier = 'NEAR_PRIME';
        }

        return {
            riskTier,
            creditScore: score,
            annualIncome: param.annualIncome,
            requestedAmount: param.requestedAmount,
            applicantName: param.applicantName,
            applicationVerified: true
        };
    });

    // Subflow A: PRIME - Fast-Track Automated Approval
    const applyPartnerPromoRate = Step.create('applyPartnerPromoRate', async () => ({
        interestRate: 4.25,
        rateTier: 'PARTNER_PROMO',
        approved: true
    }));

    const applyStandardPrimeRate = Step.create('applyStandardPrimeRate', async () => ({
        interestRate: 4.85,
        rateTier: 'STANDARD_PRIME',
        approved: true
    }));

    const primeFlow = flow(
        when(
            (ctx) => ctx.hasPartnerPromo === true,
            applyPartnerPromoRate,
            applyStandardPrimeRate
        ),
        Step.create('finalizePrimeOffer', async (param: any) => ({
            decision: 'APPROVED_INSTANT',
            maxAllowedAmount: param.requestedAmount,
            stipulationsRequired: false
        }))
    );

    // Subflow B: NEAR_PRIME - Manual Review & Collateral Check
    const nearPrimeFlow = flow(
        Step.create('assessNearPrimeRisk', async (param: any) => {
            const income = Number(param.annualIncome || 1);
            const requested = Number(param.requestedAmount || 0);
            const debtToIncome = requested / income;

            return {
                decision: debtToIncome <= 0.4 ? 'APPROVED_WITH_CONDITIONS' : 'REFERRED_TO_ANALYST',
                interestRate: 7.5,
                stipulationsRequired: true,
                stipulationNotes: 'Requires 2 months of verified pay stubs'
            };
        })
    );

    // Subflow C: SUBPRIME - High Risk Queue / Auto-Decline
    const subprimeFlow = flow(
        Step.create('declineSubprime', async () => ({
            decision: 'DECLINED',
            adverseActionNoticeSent: true,
            declineReason: 'Credit score below minimum automated threshold (650)'
        }))
    );

    // Dynamic Multi-Way Router
    const dynamicRouting = branch(
        (ctx) => ctx.riskTier,
        {
            PRIME: primeFlow,
            NEAR_PRIME: nearPrimeFlow,
            SUBPRIME: subprimeFlow
        },
        subprimeFlow
    );

    // Final Step: Format Decision Summary
    const formatDecision = Step.create('formatDecision', async (param: any) => {
        return {
            pipelineStatus: 'PROCESSED',
            applicationId: param.applicationId,
            applicantName: param.applicantName,
            riskTier: param.riskTier,
            decision: param.decision,
            interestRate: param.interestRate ?? null,
            stipulationsRequired: param.stipulationsRequired ?? false
        };
    });

    return flow(
        classifyRiskTier,
        dynamicRouting,
        formatDecision
    );
}
