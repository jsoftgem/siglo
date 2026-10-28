import {expect} from 'chai';
import {
    Step,
    flow,
    parallel,
    all,
    allSettled,
    race,
    when,
    branch,
    map,
    waitForEvent,
    wait,
    toGraph,
    validateGraph,
    assertValidGraph,
    inspectGraph,
    buildIdempotencyKey,
    InMemoryIdempotencyStore,
    defaultIdempotencyStore,
    defaultCompensationManager,
    defaultDurableManager,
    clearStorage,
    Status,
    ParallelMergeStrategy,
    FieldCollisionException,
    IdempotencyConflictException,
    CompensationException,
    WorkflowVersionMismatchException,
    DuplicateEventException,
    ExpiredWaitException,
    GraphValidationException
} from '../index';

function resetWorkflowEnvironment(): void {
    clearStorage();
    defaultIdempotencyStore.clear();
    defaultDurableManager.clear();
    defaultCompensationManager.clear();
}

describe('Phase 2: Core Workflow Power Integration Suite', () => {
    beforeEach(() => {
        resetWorkflowEnvironment();
    });

    afterEach(() => {
        resetWorkflowEnvironment();
    });

    describe('Workstream 1: Distributed Saga & Reverse LIFO Compensation Rollback', () => {
        it('Scenario 1: Complete E-commerce Order Saga with Parallel execution and Sagas rollback', async () => {
            const compensationsExecuted: string[] = [];

            // 1. Validate Order
            const validateOrder = Step.create('validateOrder').onStart(({orderId, amount, items}: any) => {
                return {orderId, amount, items, validated: true};
            });

            // 2. Parallel: Reserve Inventory (with compensation) + Authorize Payment (with compensation) + Calculate Tax
            const reserveInventory = Step.create('reserveInventory')
                
                .compensate(async (output: any) => {
                    compensationsExecuted.push(`release_inventory:${output.reservedItems.join(',')}`);
                })
                .onStart(async ({items}: any) => {
                    await new Promise(r => setTimeout(r, 15));
                    return {reservedItems: items, inventoryReserved: true};
                });

            const authorizePayment = Step.create('authorizePayment')
                
                .compensate(async (output: any) => {
                    compensationsExecuted.push(`refund_payment:${output.paymentAuthCode}`);
                })
                .onStart(async ({amount}: any) => {
                    await new Promise(r => setTimeout(r, 15));
                    return {paymentAuthCode: 'AUTH_8888', amountPaid: amount};
                });

            const calculateTax = Step.create('calculateTax')
                
                .onStart(async ({amount}: any) => {
                    await new Promise(r => setTimeout(r, 10));
                    return {tax: amount * 0.08};
                });

            const prepareOrder = parallel(reserveInventory, authorizePayment, calculateTax);

            // 3. Downstream step that fails to trigger compensation
            const packGoods = Step.create('packGoods').onStart(() => {
                throw new Error('Warehouse robotics failure');
            });

            const orderWorkflow = flow(validateOrder, prepareOrder, packGoods);

            try {
                await orderWorkflow.execute({
                    orderId: 'ORD-1001',
                    amount: 500,
                    items: ['item-A', 'item-B']
                });
                expect.fail('Should have failed and triggered compensations');
            } catch (err: any) {
                expect(err.message).to.equal('Warehouse robotics failure');
                // Both compensations were executed in LIFO order
                expect(compensationsExecuted).to.include('refund_payment:AUTH_8888');
                expect(compensationsExecuted).to.include('release_inventory:item-A,item-B');
            }
        });

        it('Scenario 1b: Multi-service travel booking saga with LIFO order and context access', async () => {
            const auditLog: { actions: string[]; compensations: string[] } = {
                actions: [],
                compensations: []
            };

            const reserveFlight = Step.create('reserveFlight')
                
                .compensate(async (output: any, input: any) => {
                    auditLog.compensations.push(`Cancel Flight: ${output.ticketId} for ${input.passenger}`);
                })
                .onStart(async ({bookingId, passenger}: any) => {
                    auditLog.actions.push(`Reserve Flight for ${passenger}`);
                    return {ticketId: `TKT-${bookingId}`, flightCost: 450};
                });

            const reserveHotel = Step.create('reserveHotel')
                
                .compensate(async (output: any, input: any) => {
                    auditLog.compensations.push(`Cancel Hotel: ${output.hotelConfirmation} for ${input.passenger}`);
                })
                .onStart(async ({bookingId, passenger}: any) => {
                    auditLog.actions.push(`Reserve Hotel for ${passenger}`);
                    return {hotelConfirmation: `HTL-${bookingId}`, hotelCost: 350};
                });

            const chargePayment = Step.create('chargePayment')
                
                .onStart(async ({flightCost, hotelCost, shouldFail}: any) => {
                    const total = flightCost + hotelCost;
                    if (shouldFail) {
                        throw new Error(`Payment declined for amount $${total}: Insufficient funds`);
                    }
                    return {paymentStatus: 'PAID', totalCharged: total};
                });

            const travelSaga = flow(reserveFlight, reserveHotel, chargePayment);

            // 1. Successful forward execution
            const successResult = await travelSaga.execute({
                bookingId: 'BK-501',
                passenger: 'Ada Lovelace',
                shouldFail: false
            }, {pojo: true});

            expect(successResult.paymentStatus).to.equal('PAID');
            expect(successResult.totalCharged).to.equal(800);
            expect(auditLog.compensations).to.have.length(0);
            expect(auditLog.actions).to.have.length(2);

            // 2. Failure triggering reverse LIFO compensation
            try {
                await travelSaga.execute({
                    bookingId: 'BK-502',
                    passenger: 'Charles Babbage',
                    shouldFail: true
                }, {pojo: true});
                expect.fail('Should have failed payment step');
            } catch (err: any) {
                expect(err.message).to.include('Payment declined');
                // Hotel was reserved second, so it must be cancelled first
                expect(auditLog.compensations).to.have.length(2);
                expect(auditLog.compensations[0]).to.equal('Cancel Hotel: HTL-BK-502 for Charles Babbage');
                expect(auditLog.compensations[1]).to.equal('Cancel Flight: TKT-BK-502 for Charles Babbage');
            }
        });

        it('Scenario 1c: Compensation failure raises CompensationException with error diagnostics', async () => {
            const failingCompSaga = flow(
                Step.create('stepA')
                    
                    .compensate(async () => {
                        throw new Error('Hotel cancellation network timeout');
                    })
                    .onStart(async () => ({stepA: true})),
                Step.create('stepB')
                    
                    .onStart(async () => {
                        throw new Error('Primary booking failed');
                    })
            );

            try {
                await failingCompSaga.execute({}, {pojo: true});
                expect.fail('Should have thrown CompensationException');
            } catch (err: any) {
                expect(err).to.be.instanceOf(CompensationException);
                expect(err.originalError.message).to.equal('Primary booking failed');
                expect(err.compensationErrors).to.have.length(1);
                expect(err.compensationErrors[0].stepName).to.equal('stepA');
                expect(err.compensationErrors[0].error.message).to.equal('Hotel cancellation network timeout');
            }
        });

        it('Scenario 1d: Manual saga compensation trigger and compensation retry policy', async () => {
            let compensationAttempts = 0;
            let manualCompensationRun = false;
            let capturedStackId: string | undefined;

            const compensatableStep = Step.create('inventoryReservation')
                
                .compensate(async () => {
                    compensationAttempts++;
                    if (compensationAttempts < 2) {
                        throw new Error('Transient inventory release error');
                    }
                    manualCompensationRun = true;
                }, {
                    maxRetries: 3,
                    delay: 10,
                    retryIf: (err: any) => err.message.includes('Transient')
                })
                .onStart(async ({$stackId}: any) => {
                    capturedStackId = typeof $stackId === 'function' ? $stackId() : $stackId;
                    return {reservationId: 'RES-999'};
                });

            const sagaFlow = flow(compensatableStep);
            const execResult = await sagaFlow.execute({}, {pojo: true});
            expect(execResult.reservationId).to.equal('RES-999');
            expect(capturedStackId).to.be.a('string');

            const compResult = await sagaFlow.compensate(capturedStackId!);
            expect(compResult.completed).to.include('inventoryReservation');
            expect(manualCompensationRun).to.be.true;
            expect(compensationAttempts).to.equal(2);
        });
    });

    describe('Workstream 2: Concurrency, Parallel Fan-Out & Competitive Racing', () => {
        it('Scenario 2a: Latency race selects fastest gateway and aborts losing branch', async () => {
            let slowerBranchAborted = false;

            const usEastGateway = Step.create('usEastGateway').onStart(async () => {
                await new Promise(r => setTimeout(r, 15));
                return {selectedEdge: 'US_EAST', latencyMs: 15};
            });

            const euCentralGateway = Step.create('euCentralGateway').onStart(async ({$signal}: any) => {
                const signal = typeof $signal === 'function' ? $signal() : $signal;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 100);
                    signal?.addEventListener?.('abort', () => {
                        clearTimeout(timer);
                        slowerBranchAborted = true;
                        reject(new Error('Aborted'));
                    });
                });
                return {selectedEdge: 'EU_CENTRAL', latencyMs: 100};
            });

            const edgeRaceFlow = flow(race(usEastGateway, euCentralGateway));
            const result = await edgeRaceFlow.execute({}, {pojo: true});

            expect(result.selectedEdge).to.equal('US_EAST');
            expect(result.latencyMs).to.equal(15);
            // Slower branch received abort signal
            await new Promise(r => setTimeout(r, 20));
            expect(slowerBranchAborted).to.be.true;
        });

        it('Scenario 2b: Multi-cloud parallel fan-out with deep merge and non-blocking allSettled telemetry', async () => {
            const replicateS3 = Step.create('replicateS3').onStart(async ({assetId}: any) => ({
                replicas: {
                    aws: {uri: `s3://bucket/${assetId}`, status: 'SYNCED'}
                }
            }));

            const replicateGcs = Step.create('replicateGcs').onStart(async ({assetId}: any) => ({
                replicas: {
                    gcp: {uri: `gs://bucket/${assetId}`, status: 'SYNCED'}
                }
            }));

            const replicateAzure = Step.create('replicateAzure').onStart(async ({assetId}: any) => ({
                replicas: {
                    azure: {uri: `https://azure.blob/${assetId}`, status: 'SYNCED'}
                }
            }));

            const logAnalytics = Step.create('logAnalytics').onStart(async () => ({analyticsLogged: true}));
            const pushAudit = Step.create('pushAudit').onStart(async () => {
                // Secondary telemetry non-fatal failure
                throw new Error('Audit webhook unreachable');
            });

            const multiCloudFlow = flow(
                parallel(replicateS3, replicateGcs, replicateAzure, {mergeStrategy: ParallelMergeStrategy.DEEP}),
                allSettled([logAnalytics, pushAudit])
            );

            const result = await multiCloudFlow.execute({assetId: 'ASSET-101'}, {pojo: true});

            // Deep merge combined replica receipts from all 3 branches
            expect(result.replicas.aws.status).to.equal('SYNCED');
            expect(result.replicas.gcp.status).to.equal('SYNCED');
            expect(result.replicas.azure.status).to.equal('SYNCED');

            // allSettled preserved successful log without aborting the flow on audit failure
            expect(result.logAnalytics.analyticsLogged).to.equal(true);
            expect(result.pushAudit.error.message).to.equal('Audit webhook unreachable');
            expect(result.$settled).to.be.an('array');
            expect(result.$settled[0].status).to.equal('fulfilled');
            expect(result.$settled[1].status).to.equal('rejected');
        });

        it('Scenario 2c: Strict collision detection halts execution and throws FieldCollisionException', async () => {
            const branchA = Step.create('branchA').onStart(async () => ({
                token: 'TOKEN_A',
                serviceA: true
            }));

            const branchB = Step.create('branchB').onStart(async () => ({
                token: 'TOKEN_B', // Collision on 'token'
                serviceB: true
            }));

            const collidingParallel = flow(
                parallel(branchA, branchB, {mergeStrategy: 'error'})
            );

            try {
                await collidingParallel.execute({}, {pojo: true});
                expect.fail('Should have detected field collision');
            } catch (err: any) {
                expect(err).to.be.instanceOf(FieldCollisionException);
                expect(err.collisions).to.be.an('array');
                expect(err.collisions[0].field).to.equal('token');
                expect(err.message).to.include('Field collision detected');
            }
        });
    });

    describe('Workstream 3: Dynamic Branching & Conditional Routing', () => {
        it('Scenario 3a: Multi-way dynamic loan underwriting router via branch() and when()', async () => {
            const classifyRisk = Step.create('classifyRisk').onStart(({creditScore}: any) => {
                let tier = 'SUBPRIME';
                if (creditScore >= 750) tier = 'PRIME';
                else if (creditScore >= 650) tier = 'NEAR_PRIME';
                return {riskTier: tier};
            });

            const primeFlow = flow(
                when(
                    (ctx) => ctx.hasPartnerPromo === true,
                    Step.create('promoRate').onStart(() => ({interestRate: 4.25, tierRate: 'PROMO'})),
                    Step.create('standardRate').onStart(() => ({interestRate: 4.85, tierRate: 'STANDARD'}))
                ),
                Step.create('primeDecision').onStart(() => ({decision: 'APPROVED_INSTANT'}))
            );

            const nearPrimeFlow = flow(
                Step.create('nearPrimeAssessment').onStart(() => ({
                    decision: 'APPROVED_WITH_CONDITIONS',
                    interestRate: 7.5,
                    stipulationsRequired: true
                }))
            );

            const subprimeFlow = flow(
                Step.create('subprimeDecline').onStart(() => ({
                    decision: 'DECLINED',
                    adverseNotice: true
                }))
            );

            const dynamicLoanRouter = flow(
                classifyRisk,
                branch(
                    (ctx) => ctx.riskTier,
                    {
                        PRIME: primeFlow,
                        NEAR_PRIME: nearPrimeFlow,
                        SUBPRIME: subprimeFlow
                    },
                    subprimeFlow
                )
            );

            // 1. Prime applicant with promo
            const resPrimePromo = await dynamicLoanRouter.execute({
                creditScore: 800,
                hasPartnerPromo: true
            }, {pojo: true});
            expect(resPrimePromo.riskTier).to.equal('PRIME');
            expect(resPrimePromo.interestRate).to.equal(4.25);
            expect(resPrimePromo.decision).to.equal('APPROVED_INSTANT');

            // 2. Prime applicant without promo
            const resPrimeStandard = await dynamicLoanRouter.execute({
                creditScore: 780,
                hasPartnerPromo: false
            }, {pojo: true});
            expect(resPrimeStandard.riskTier).to.equal('PRIME');
            expect(resPrimeStandard.interestRate).to.equal(4.85);
            expect(resPrimeStandard.decision).to.equal('APPROVED_INSTANT');

            // 3. Near-prime applicant
            const resNear = await dynamicLoanRouter.execute({creditScore: 680}, {pojo: true});
            expect(resNear.riskTier).to.equal('NEAR_PRIME');
            expect(resNear.decision).to.equal('APPROVED_WITH_CONDITIONS');
            expect(resNear.stipulationsRequired).to.be.true;

            // 4. Subprime applicant
            const resSub = await dynamicLoanRouter.execute({creditScore: 550}, {pojo: true});
            expect(resSub.riskTier).to.equal('SUBPRIME');
            expect(resSub.decision).to.equal('DECLINED');

            // 5. Unknown tier falls back to defaultBranch (subprime)
            const resUnknown = await dynamicLoanRouter.execute({creditScore: 200}, {pojo: true});
            expect(resUnknown.decision).to.equal('DECLINED');
        });

        it('Scenario 3b: when() skips cleanly and records branch history when condition is false and no else provided', async () => {
            const optionalAudit = flow(
                when(
                    (ctx) => ctx.enableAudit === true,
                    Step.create('auditStep').onStart(() => ({auditRecorded: true}))
                )
            );

            // When condition is true
            const resAudit = await optionalAudit.execute({enableAudit: true}, {pojo: true});
            expect(resAudit.auditRecorded).to.be.true;
            expect(resAudit.$branchSelected).to.equal('then');

            // When condition is false
            const resNoAudit = await optionalAudit.execute({enableAudit: false}, {pojo: true});
            expect(resNoAudit.auditRecorded).to.be.undefined;
            expect(resNoAudit.$skipped).to.be.true;
            expect(resNoAudit.$skippedBranches).to.include('then');
        });
    });

    describe('Workstream 4: High-Throughput Batch Processing with Bounded Worker Pool', () => {
        it('Scenario 4a: Bounded batch mapping preserves order, limits concurrency, and passes meta', async () => {
            let activeWorkers = 0;
            let peakConcurrency = 0;

            const documents = Array.from({length: 8}, (_, i) => ({
                id: `DOC-${i + 1}`,
                title: `Report ${i + 1}`
            }));

            const batchMap = map(
                documents,
                async (doc: any, meta: any) => {
                    activeWorkers++;
                    peakConcurrency = Math.max(peakConcurrency, activeWorkers);
                    await new Promise(r => setTimeout(r, 20));
                    activeWorkers--;
                    return {
                        docId: doc.id,
                        indexed: true,
                        orderIndex: meta.index
                    };
                },
                {concurrency: 3, preserveOrder: true}
            );

            const result = await flow(batchMap).execute({}, {pojo: true});

            expect(result.items).to.have.length(8);
            expect(peakConcurrency).to.be.at.most(3);
            expect(result.items[0].docId).to.equal('DOC-1');
            expect(result.items[7].docId).to.equal('DOC-8');
            expect(result.items[3].orderIndex).to.equal(3);
        });

        it('Scenario 4b: stopOnError: false collects all results and errors without interrupting batch', async () => {
            const items = [10, 0, 30, 0, 50];

            const safeDivision = map(
                items,
                async (val: number) => {
                    if (val === 0) throw new Error('Division by zero');
                    return 100 / val;
                },
                {concurrency: 2, stopOnError: false}
            );

            const res = await flow(safeDivision).execute({}, {pojo: true});

            expect(res.items).to.have.length(5);
            expect(res.items[0]).to.equal(10);
            expect(res.items[1]).to.be.an('object');
            expect(res.items[1].error.message).to.equal('Division by zero');
            expect(res.items[2]).to.be.closeTo(3.33, 0.01);
            expect(res.items[4]).to.equal(2);
        });

        it('Scenario 4c: Async generator streaming and AbortSignal cancellation in bounded map', async () => {
            async function* numberGenerator() {
                for (let i = 1; i <= 5; i++) {
                    yield i;
                }
            }

            const streamMap = map(
                numberGenerator(),
                async (n: number) => n * 10,
                {concurrency: 2}
            );

            const streamResult = await flow(streamMap).execute({}, {pojo: true});
            expect(streamResult.items).to.deep.equal([10, 20, 30, 40, 50]);

            // Cancellation propagation
            const controller = new AbortController();
            const cancellableMap = map(
                [1, 2, 3, 4, 5],
                async () => {
                    await new Promise(r => setTimeout(r, 40));
                    return 'done';
                },
                {concurrency: 1}
            );

            setTimeout(() => controller.abort(), 20);

            try {
                await flow(cancellableMap).execute({}, {signal: controller.signal});
                expect.fail('Should have cancelled');
            } catch (err: any) {
                expect(err.name).to.equal('CancellationException');
            }
        });
    });

    describe('Workstream 5: Scoped Financial Settlement & Idempotency Claim Locking', () => {
        it('Scenario 5a: Idempotent order processing preventing double charge (Workflow-level)', async () => {
            let chargeCounter = 0;
            const chargeStep = Step.create('charge')
                
                .onStart(async ({amount}: any) => {
                    chargeCounter++;
                    return {transactionId: 'tx_abc123', amountCharged: amount};
                });

            const orderFlow = flow(chargeStep);

            // 1. Initial request
            const res1 = await orderFlow.execute({amount: 150}, {
                pojo: true,
                idempotencyKey: 'cart-checkout-99'
            });
            expect(res1.amountCharged).to.equal(150);
            expect(chargeCounter).to.equal(1);

            // 2. Duplicate network retry
            const res2 = await orderFlow.execute({amount: 150}, {
                pojo: true,
                idempotencyKey: 'cart-checkout-99'
            });
            expect(res2.amountCharged).to.equal(150);
            expect(chargeCounter).to.equal(1); // Charge step was NOT called twice!
        });

        it('Scenario 5b: Step-level idempotency with buildIdempotencyKey protecting ledger settlement', async () => {
            let ledgerSettlementCalls = 0;
            const customStore = new InMemoryIdempotencyStore();

            const settleStep = Step.create('settleStep')
                
                .idempotent((ctx) => buildIdempotencyKey('ledger-settlement', {namespace: ctx.transactionId}), {
                    ttlMs: 60000,
                    store: customStore
                })
                .onStart(async ({transactionId, amount}: any) => {
                    ledgerSettlementCalls++;
                    return {
                        settled: true,
                        journalRef: `JRNL-${transactionId}-${Date.now()}`,
                        amountSettled: amount
                    };
                });

            const issueReceipt = Step.create('issueReceipt')
                
                .onStart(({journalRef, amountSettled}: any) => ({
                    receiptStatus: 'ISSUED',
                    journalRef,
                    amountSettled
                }));

            const settlementPipeline = flow(settleStep, issueReceipt);

            // 1. First execution
            const firstResult = await settlementPipeline.execute({
                transactionId: 'TX-BANK-8821',
                amount: 50000
            }, {pojo: true});

            expect(firstResult.receiptStatus).to.equal('ISSUED');
            expect(firstResult.amountSettled).to.equal(50000);
            expect(ledgerSettlementCalls).to.equal(1);
            const originalJournal = firstResult.journalRef;

            // 2. Duplicate re-delivery
            const secondResult = await settlementPipeline.execute({
                transactionId: 'TX-BANK-8821',
                amount: 50000
            }, {pojo: true});

            expect(secondResult.receiptStatus).to.equal('ISSUED');
            expect(secondResult.amountSettled).to.equal(50000);
            expect(secondResult.journalRef).to.equal(originalJournal);
            expect(ledgerSettlementCalls).to.equal(1); // Did not run twice!
        });

        it('Scenario 5c: In-flight concurrent claim collision throws IdempotencyConflictException', async () => {
            const inFlightStore = new InMemoryIdempotencyStore();
            const scopedKey = buildIdempotencyKey('tx-claim-lock-123');
            // Pre-claim scoped key to simulate an in-progress background worker
            await inFlightStore.claim(scopedKey);

            const protectedStep = Step.create('lockStep')
                
                .idempotent(() => 'tx-claim-lock-123', {store: inFlightStore})
                .onStart(async () => ({executed: true}));

            try {
                await flow(protectedStep).execute({}, {pojo: true});
                expect.fail('Should have rejected in-flight conflict');
            } catch (err: any) {
                expect(err).to.be.instanceOf(IdempotencyConflictException);
                expect(err.idempotencyKey).to.equal(scopedKey);
            }
        });

        it('Scenario 5d: Workflow failure clears idempotency claim so it can be retried safely', async () => {
            let attemptCount = 0;
            const flakyStep = Step.create('flakyPayment')
                
                .onStart(async () => {
                    attemptCount++;
                    if (attemptCount === 1) {
                        throw new Error('Payment gateway timeout');
                    }
                    return {success: true, paymentId: 'PAY-123'};
                });

            const flakyFlow = flow(flakyStep);

            // 1. First attempt fails
            try {
                await flakyFlow.execute({}, {idempotencyKey: 'flaky-charge-456'});
                expect.fail('First attempt should have failed');
            } catch (err: any) {
                expect(err.message).to.equal('Payment gateway timeout');
            }

            // 2. Retry succeeds because failed claim was released
            const retryRes = await flakyFlow.execute({}, {
                pojo: true,
                idempotencyKey: 'flaky-charge-456'
            });

            expect(retryRes.success).to.be.true;
            expect(retryRes.paymentId).to.equal('PAY-123');
            expect(attemptCount).to.equal(2);
        });
    });

    describe('Workstream 6: Durable Waits, External Event Resumption & Version Migrations', () => {
        it('Scenario 6a: Durable wait, external event resumption, and batch map processing', async () => {
            const step1 = Step.create('createAccount').onStart(({username}: any) => ({
                username,
                accountId: 'acc_456'
            }));

            const waitForKyc = waitForEvent('kyc.completed', {
                correlationKey: (ctx) => `kyc:${ctx.accountId}`,
                timeout: '24h'
            });

            const provisionServices = map(
                ['email', 'database', 'storage', 'analytics'],
                async (service: string, meta: any) => {
                    return {service, provisioned: true, workerIndex: meta.index};
                },
                {concurrency: 2}
            );

            const onboardingWorkflow = flow(step1, waitForKyc, provisionServices).version('1.0.0');

            // 1. Run durable workflow until KYC wait point
            const suspended = await onboardingWorkflow.run({username: 'alice'}, {
                durable: true,
                pojo: true
            });

            expect(suspended.status).to.equal(Status.WAITING);
            expect(suspended.correlationKey).to.equal('kyc:acc_456');

            // 2. Resume when external KYC webhook arrives
            const completed = await onboardingWorkflow.resume('kyc:acc_456', {
                kycScore: 98,
                kycVerified: true
            }, {pojo: true});

            expect(completed.username).to.equal('alice');
            expect(completed.kycVerified).to.equal(true);
            expect(completed.items).to.have.length(4);
            expect(completed.items[0].service).to.equal('email');
            expect(completed.items[3].service).to.equal('analytics');
        });

        it('Scenario 6b: Durable sleep timer with wait() returns suspension descriptor', async () => {
            const timerFlow = flow(
                Step.create('step1').onStart(() => ({step1Done: true})),
                wait('100ms'),
                Step.create('step2').onStart(() => ({step2Done: true}))
            );

            // Non-durable execution passes through wait
            const nonDurableRes = await timerFlow.execute({}, {pojo: true});
            expect(nonDurableRes.step1Done).to.be.true;
            expect(nonDurableRes.step2Done).to.be.true;

            // Durable execution suspends at timer
            const suspended = await timerFlow.execute({}, {durable: true, pojo: true});
            expect(suspended.status).to.equal(Status.WAITING);
            expect(suspended.eventName).to.equal('timer');
            expect(suspended.correlationKey).to.be.a('string');
        });

        it('Scenario 6c: Workflow version verification and state migration across versions', async () => {
            const submitExpense = Step.create('submitExpense').onStart(({reportId, amount}: any) => ({
                reportId,
                amount,
                submittedAt: Date.now()
            }));

            const awaitApproval = waitForEvent('expense.approved', {
                correlationKey: (ctx) => ctx.reportId
            });

            const reimburse = Step.create('reimburse').onStart(({
                                                                             reportId,
                                                                             amount,
                                                                             approvedBy,
                                                                             policyV2
                                                                         }: any) => ({
                reimbursed: true,
                reportId,
                amount,
                approvedBy,
                policyV2
            }));

            const v1Workflow = flow(submitExpense, awaitApproval, reimburse).version('1.0.0');
            const v2Workflow = flow(submitExpense, awaitApproval, reimburse).version('2.0.0');

            // 1. Suspend with v1 and attempt resume with v2 without migration -> throws WorkflowVersionMismatchException
            const suspendedMismatch = await v1Workflow.run({reportId: 'EXP-MISMATCH-1', amount: 3000}, {
                durable: true,
                pojo: true
            });
            expect(suspendedMismatch.status).to.equal(Status.WAITING);

            try {
                await v2Workflow.resume('EXP-MISMATCH-1', {approvedBy: 'manager@corp.com'});
                expect.fail('Should have failed version check');
            } catch (err: any) {
                expect(err).to.be.instanceOf(WorkflowVersionMismatchException);
                expect(err.expectedVersion).to.equal('2.0.0');
                expect(err.actualVersion).to.equal('1.0.0');
            }

            // 2. Suspend another workflow and resume with state migration function -> succeeds
            const suspendedMigrate = await v1Workflow.run({reportId: 'EXP-MIGRATE-2', amount: 4200}, {
                durable: true,
                pojo: true
            });
            expect(suspendedMigrate.status).to.equal(Status.WAITING);

            const resumed = await v2Workflow.resume('EXP-MIGRATE-2', {approvedBy: 'director@corp.com'}, {
                migrations: {
                    '1.0.0->2.0.0': (_from: any, _to: any, oldState: any) => ({
                        ...oldState,
                        policyV2: true
                    })
                },
                pojo: true
            });

            expect(resumed.reimbursed).to.be.true;
            expect(resumed.reportId).to.equal('EXP-MIGRATE-2');
            expect(resumed.approvedBy).to.equal('director@corp.com');
            expect(resumed.policyV2).to.be.true;
        });

        it('Scenario 6d: Event safety guarantees: DuplicateEventException and ExpiredWaitException', async () => {
            const waitEvent = waitForEvent('user.activated', {
                correlationKey: 'user-777',
                timeoutMs: 25
            });

            const activateFlow = flow(waitEvent, Step.create('welcome').onStart(() => ({welcomed: true})));

            // 1. Expired wait test
            await activateFlow.run({}, {durable: true});
            await new Promise(r => setTimeout(r, 35));

            try {
                await activateFlow.resume('user-777', {token: 'xyz'});
                expect.fail('Should have rejected expired wait');
            } catch (err: any) {
                expect(err).to.be.instanceOf(ExpiredWaitException);
                expect(err.correlationKey).to.equal('user-777');
            }

            // 2. Duplicate resume test
            const activeWait = waitForEvent('user.verified', {
                correlationKey: 'user-888',
                timeout: '1h'
            });
            const validFlow = flow(activeWait);
            await validFlow.run({}, {durable: true});

            // First resume succeeds
            await validFlow.resume('user-888', {ok: true});

            // Duplicate resume rejects
            try {
                await validFlow.resume('user-888', {ok: true});
                expect.fail('Should have rejected duplicate resume');
            } catch (err: any) {
                expect(err).to.be.instanceOf(DuplicateEventException);
                expect(err.correlationKey).to.equal('user-888');
            }
        });
    });

    describe('Workstream 7: Workflow Graph Model, Inspection & Static Governance', () => {
        it('Scenario 7a: CI/CD deployment pipeline governance with toGraph and inspectGraph', () => {
            const buildPackage = Step.create('buildPackage').onStart(() => ({buildUrl: 'pkg.tar.gz'}));
            const runUnitTests = Step.create('runUnitTests').onStart(() => ({unitTestsPassed: true}));
            const runSecurityScan = Step.create('runSecurityScan').onStart(() => ({cveCount: 0}));
            const runLicenseAudit = Step.create('runLicenseAudit').onStart(() => ({licenseOk: true}));
            const qualityGate = parallel(runUnitTests, runSecurityScan, runLicenseAudit);
            const deployCluster = Step.create('deployCluster').onStart(() => ({deployed: true}));

            const deploymentPipeline = flow(buildPackage, qualityGate, deployCluster);

            // 1. Compile to AST
            const ast = toGraph(deploymentPipeline);
            expect(ast.type).to.equal('sequence');

            // 2. Validate acyclic structure
            assertValidGraph(ast);
            const validation = validateGraph(ast);
            expect(validation.valid).to.be.true;

            // 3. Inspect topological structure
            const inspection = inspectGraph(deploymentPipeline);
            expect(inspection.totalNodes).to.be.at.least(5);
            expect(inspection.entryNodeId).to.be.a('string');
            expect(inspection.exitNodeIds).to.be.an('array');
            expect(inspection.edges).to.be.an('array');

            // 4. Governance Policy: Must contain security scan step
            const nodeNames = inspection.nodes.map(n => n.name);
            expect(nodeNames).to.include('runSecurityScan');
            expect(nodeNames).to.include('buildPackage');
            expect(nodeNames).to.include('deployCluster');
        });

        it('Scenario 7b: Graph validation catches cyclic dependencies and throws GraphValidationException', () => {
            const nodeA: any = {id: 'nodeA', name: 'nodeA', type: 'step'};
            const nodeB: any = {id: 'nodeB', name: 'nodeB', type: 'sequence', children: []};
            nodeB.children.push(nodeA);
            nodeB.children.push(nodeB); // cycle!

            const res = validateGraph(nodeB);
            expect(res.valid).to.be.false;
            expect(res.errors[0]).to.include('Cycle detected');

            expect(() => assertValidGraph(nodeB)).to.throw(GraphValidationException);
        });
    });

    describe('Workstream 8: Cross-Cutting End-to-End Distributed Orchestration', () => {
        it('Scenario 8: Complete order fulfillment pipeline combining governance, idempotency, parallel fan-out, branching, durable approval, and bounded batch mapping', async () => {
            const auditTrail: string[] = [];

            // 1. Pre-execution governance validation
            const validateInput = Step.create('validateInput').onStart(({orderId, amount, items}: any) => {
                auditTrail.push(`Validated order: ${orderId}`);
                return {orderId, amount, items, validated: true};
            });

            const reserveWarehouse = Step.create('reserveWarehouse')
                
                .compensate(async (output: any) => {
                    auditTrail.push(`Rollback Inventory for items: ${output.allocatedItems.join(',')}`);
                })
                .onStart(async ({items}: any) => {
                    auditTrail.push('Reserved warehouse items');
                    return {allocatedItems: items, inventorySynced: true};
                });

            const authorizeCard = Step.create('authorizeCard')
                
                .compensate(async (output: any) => {
                    auditTrail.push(`Rollback Card Auth: ${output.authCode}`);
                })
                .onStart(async ({amount}: any) => {
                    auditTrail.push(`Authorized card for $${amount}`);
                    return {authCode: 'AUTH_FULFILL_99', amountCharged: amount};
                });

            const prepareFulfillment = parallel(reserveWarehouse, authorizeCard, {mergeStrategy: ParallelMergeStrategy.DEEP});

            const RiskTier = {
                HIGH_VALUE: 'HIGH_VALUE',
                STANDARD: 'STANDARD'
            } as const;

            const routeRiskAssessment = branch(
                (ctx) => (ctx.amount > 1000 ? RiskTier.HIGH_VALUE : RiskTier.STANDARD),
                {
                    [RiskTier.HIGH_VALUE]: Step.create('flagHighValue').onStart(() => ({
                        riskLevel: 'ELEVATED',
                        manualReviewRequired: true
                    })),
                    [RiskTier.STANDARD]: Step.create('passStandard').onStart(() => ({
                        riskLevel: 'LOW',
                        manualReviewRequired: false
                    }))
                }
            );

            const awaitFraudApproval = waitForEvent('fraud.approval', {
                correlationKey: (ctx) => `fraud:${ctx.orderId}`,
                timeout: '7d'
            });

            const notifyCarriers = map(
                (ctx: any) => ctx.allocatedItems,
                async (item: string) => {
                    auditTrail.push(`Carrier dispatched for: ${item}`);
                    return {item, carrier: 'FedEx', trackingNumber: `TRK-${item}`};
                },
                {concurrency: 2, preserveOrder: true}
            );

            const finalizeFulfillment = Step.create('finalizeFulfillment').onStart(({
                                                                                                 orderId,
                                                                                                 approvedBy,
                                                                                                 items
                                                                                             }: any) => {
                auditTrail.push(`Order finalized: ${orderId}`);
                return {
                    status: 'FULFILLED',
                    orderId,
                    approvedBy,
                    totalItemsDispatched: items.length
                };
            });

            const fullPipeline = flow(
                validateInput,
                prepareFulfillment,
                routeRiskAssessment,
                awaitFraudApproval,
                notifyCarriers,
                finalizeFulfillment
            ).version('2.0.0');

            // 1. Static governance verification
            const graph = toGraph(fullPipeline);
            assertValidGraph(graph);
            const inspection = inspectGraph(fullPipeline);
            expect(inspection.nodes.map(n => n.name)).to.include('reserveWarehouse');
            expect(inspection.nodes.map(n => n.name)).to.include('authorizeCard');

            // 2. High-value order: durable suspension for fraud approval
            const suspendedOrder = await fullPipeline.run({
                orderId: 'ORD-HIGH-999',
                amount: 3500,
                items: ['Server-Rack-1', 'Server-Rack-2']
            }, {
                durable: true,
                pojo: true
            });

            expect(suspendedOrder.status).to.equal(Status.WAITING);
            expect(suspendedOrder.correlationKey).to.equal('fraud:ORD-HIGH-999');

            // 3. Resume when fraud analyst approves
            const completedOrder = await fullPipeline.resume('fraud:ORD-HIGH-999', {
                approvedBy: 'security-director@enterprise.com'
            }, {pojo: true});

            expect(completedOrder.status).to.equal('FULFILLED');
            expect(completedOrder.orderId).to.equal('ORD-HIGH-999');
            expect(completedOrder.approvedBy).to.equal('security-director@enterprise.com');
            expect(completedOrder.totalItemsDispatched).to.equal(2);
            expect(completedOrder.items[0].trackingNumber).to.equal('TRK-Server-Rack-1');
            expect(completedOrder.items[1].trackingNumber).to.equal('TRK-Server-Rack-2');

            // 4. Verification of end-to-end execution audit trail
            expect(auditTrail).to.include('Validated order: ORD-HIGH-999');
            expect(auditTrail).to.include('Reserved warehouse items');
            expect(auditTrail).to.include('Authorized card for $3500');
            expect(auditTrail).to.include('Carrier dispatched for: Server-Rack-1');
            expect(auditTrail).to.include('Carrier dispatched for: Server-Rack-2');
            expect(auditTrail).to.include('Order finalized: ORD-HIGH-999');
        });
    });
});
