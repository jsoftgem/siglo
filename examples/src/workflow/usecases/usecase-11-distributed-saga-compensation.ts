import { Step, flow } from 'rivulet';

export interface TravelBookingInput {
    bookingId: string;
    passengerName: string;
    flightNumber: string;
    hotelName: string;
    shouldFailPayment?: boolean;
}

export interface TravelBookingAudit {
    actions: string[];
    compensations: string[];
}

/**
 * Use Case 11: Multi-Service Travel Booking Saga with Automatic LIFO Compensations
 * Flow: reserveFlight -> reserveHotel -> processPayment -> issueVouchers
 * Features demonstrated:
 * - Step.create(...) for idiomatic POJO parameter access
 * - Step.create(...).compensate(undoAction)
 * - Automatic reverse LIFO compensation rollback upon workflow failure
 * - Passing execution context to compensation handlers
 * - Compensation auditing and recovery verification
 */
export function createTravelBookingSagaPipeline(auditLog: TravelBookingAudit = { actions: [], compensations: [] }) {
    // Step 1: Reserve Flight (Compensatable)
    const reserveFlight = Step.create('reserveFlight', async (param: any) => {
        const { bookingId, flightNumber } = param;

        auditLog.actions.push(`Flight reserved: ${flightNumber}`);
        const flightTicketId = `TKT-${bookingId}-FLIGHT`;

        return {
            flightTicketId,
            flightStatus: 'CONFIRMED',
            flightCost: 450
        };
    }).compensate(async (ctx: any) => {
        const ticketId = ctx?.flightTicketId || ctx?.output?.flightTicketId;
        auditLog.compensations.push(`Cancelled Flight: ${ticketId}`);
    });

    // Step 2: Reserve Hotel (Compensatable)
    const reserveHotel = Step.create('reserveHotel', async (param: any) => {
        const { bookingId, hotelName } = param;

        auditLog.actions.push(`Hotel reserved: ${hotelName}`);
        const hotelReservationId = `HOTEL-${bookingId}-ROOM`;

        return {
            hotelReservationId,
            hotelStatus: 'CONFIRMED',
            hotelCost: 350
        };
    }).compensate(async (ctx: any) => {
        const reservationId = ctx?.hotelReservationId || ctx?.output?.hotelReservationId;
        auditLog.compensations.push(`Cancelled Hotel: ${reservationId}`);
    });

    // Step 3: Process Consolidated Payment (Trigger for Saga Failure if flagged)
    const processPayment = Step.create('processPayment', async (param: any) => {
        const shouldFail = param.shouldFailPayment === true;
        const totalAmount = (param.flightCost || 0) + (param.hotelCost || 0);

        if (shouldFail) {
            throw new Error(`Payment gateway declined transaction for $${totalAmount}: Insufficient funds`);
        }

        auditLog.actions.push(`Payment charged: $${totalAmount}`);
        return {
            paymentStatus: 'PAID',
            totalAmount,
            transactionId: `TXN-SAGA-${Date.now()}`
        };
    });

    // Step 4: Issue Travel Vouchers
    const issueVouchers = Step.create('issueVouchers', async (param: any) => {
        const { bookingId, passengerName, totalAmount } = param;

        auditLog.actions.push(`Vouchers issued for ${passengerName}`);
        return {
            sagaStatus: 'COMPLETED',
            bookingId,
            passengerName,
            totalAmount,
            vouchersIssued: true,
            confirmationNumber: `CONF-${bookingId}`
        };
    });

    return flow(
        reserveFlight,
        reserveHotel,
        processPayment,
        issueVouchers
    );
}
