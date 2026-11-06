import { type WorkflowEventEmitter, Step, flow } from '@siglo/core';
import { instrumentWorkflow } from '@siglo/opentelemetry';
import { SpanStatusCode } from '@opentelemetry/api';
import { initTelemetry, getRecordedSpans, clearRecordedSpans, printTraceWaterfall, runScenario } from '../tracer';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Scenario 3: Sagas and Compensation Rollbacks
 * Demonstrates distributed transaction rollbacks in reverse (LIFO) order
 * when a downstream step fails, fully tracked in OpenTelemetry.
 */
export async function runSagaRollbackScenario(options: { silent?: boolean; emitter?: WorkflowEventEmitter } = {}) {
    clearRecordedSpans();
    const tracer = initTelemetry({ serviceName: 'travel-booking-service' });

    const auditTrail: string[] = [];

    // Step 1: Hotel Reservation with compensation
    const reserveHotelRoom = Step.create('reserveHotelRoom', async (param: any) => {
        await sleep(30);
        auditTrail.push('HOTEL_RESERVED');
        return { bookingId: param.bookingId, hotelConf: 'HTL-8821' };
    })
        .compensate(async (output: any) => {
            const span = tracer.startSpan('compensation:releaseHotelRoom', {
                attributes: { 'saga.action': 'rollback', 'hotel.conf': output?.hotelConf }
            });
            await sleep(25);
            auditTrail.push('HOTEL_CANCELLED');
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
        })
        ;

    // Step 2: Payment Authorization with compensation
    const chargeTravelerCard = Step.create('chargeTravelerCard', async (param: any) => {
        await sleep(40);
        auditTrail.push('PAYMENT_CHARGED');
        return { chargeId: 'CHG-9932', amountCharged: 450.0 };
    })
        .compensate(async (output: any) => {
            const span = tracer.startSpan('compensation:refundPayment', {
                attributes: { 'saga.action': 'rollback', 'charge.id': output?.chargeId }
            });
            await sleep(20);
            auditTrail.push('PAYMENT_REFUNDED');
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
        })
        ;

    // Step 3: Flight Booking (Fails due to sold out inventory!)
    const bookFlightSeat = Step.create('bookFlightSeat', async () => {
        await sleep(35);
        throw new Error('AirlineInventoryExhausted: No seats available on flight FL-302');
    });

    const bookingSaga = flow(
        reserveHotelRoom,
        chargeTravelerCard,
        bookFlightSeat
    );

    if (options.emitter) bookingSaga.monitor(options.emitter);

    const monitoredSaga = instrumentWorkflow(bookingSaga, {
        tracer,
        workflowName: 'HolidayBookingSaga',
        workflowVersion: '1.0.0'
    });

    let caughtError: Error | null = null;
    try {
        await monitoredSaga.run({ bookingId: 'BK-5501' });
    } catch (err: any) {
        caughtError = err;
    }

    const spans = getRecordedSpans();

    if (!options.silent) {
        printTraceWaterfall('Scenario 3: Saga Failure & LIFO Compensation Rollbacks', spans);
    }

    return { caughtError, auditTrail, spans };
}

if (process.argv[1]?.endsWith('3-saga-rollback.ts')) {
    void runScenario(() => runSagaRollbackScenario());
}
