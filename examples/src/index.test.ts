import test from "node:test";
import assert from "node:assert/strict";
import { Step } from 'rivulet';
import { createRedisClient } from "./database/redis";
import { createMongoClient } from "./database/mongodb";
import { registerRedisMongoStorage } from "./plugin/redis-mongo-storage";
import { createOrderPipeline, OrderInput } from "./workflow/order-pipeline";

test("Order pipeline executes correctly using Redis & MongoDB storage adapter", async () => {
    const redis = createRedisClient();
    const mongo = createMongoClient();

    // Register adapter
    registerRedisMongoStorage(redis, mongo);

    // Initialize pipeline after adapter registration
    const pipeline = createOrderPipeline();

    const order: OrderInput = {
        orderId: "TEST-1001",
        customer: {
            name: "John Matrix",
            email: "matrix@command.com"
        },
        items: [
            { id: "1", name: "Item Alpha", price: 50, quantity: 2 } // $100 subtotal
        ],
        couponCode: "SAVE10"
    };

    const result = await pipeline.run(order);

    // 1. Verify pipeline business logic calculations
    assert.equal(result.invoiceStatus, "PAID");
    assert.equal(result.invoiceId, "INV-TEST-1001");
    assert.equal(result.subtotal, 100);
    assert.equal(result.discount, 10); // 10% of 100
    assert.equal(result.tax, 7.20);   // 8% of 90
    assert.equal(result.amountCharged, 97.20);

    // 2. Verify MongoDB persistent storage of execution logs
    const logsInDb = await mongo.collection("rivulet_execution_logs").find();
    assert.ok(logsInDb.length > 0, "Execution context logs should be recorded in MongoDB");

    // Verify 100% of execution logs have a valid, non-null stackId
    const nullStackLogs = logsInDb.filter(l => !l.stackId);
    assert.equal(nullStackLogs.length, 0, "No execution log entry should have a null or undefined stackId");
    assert.ok(logsInDb.every(l => typeof l.stackId === "string" && l.stackId.length > 0), "Every log must have a valid string stackId");

    // 3. Verify Redis context entries
    const firstStackId = logsInDb[0].stackId;
    const stackHash = await redis.hgetall(`rivulet:stack:${firstStackId}`);
    assert.ok(Object.keys(stackHash).length > 0, "Redis should have context keys grouped under rivulet:stack:{stackId}");

    // 4. Verify durable checkpoint retrieval from storage adapter
    const retrievedChk = await Step.getCheckpoint(firstStackId);
    assert.ok(retrievedChk !== undefined, "Checkpoint should be saved and retrievable via storage adapter");
    assert.equal(retrievedChk?.stackId, firstStackId);
});
