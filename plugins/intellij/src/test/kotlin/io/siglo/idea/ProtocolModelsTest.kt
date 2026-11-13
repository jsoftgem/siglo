package io.siglo.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import io.siglo.idea.process.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File

class ProtocolModelsTest {
    private val gson = Gson()

    @Test
    fun testGraphDocumentSerialization() {
        val node = GraphNode(
            id = "step_charge_L10_C2",
            name = "chargeCard",
            stepKind = "http",
            location = SourceRange(
                start = SourcePosition(line = 9, character = 1),
                end = SourcePosition(line = 12, character = 4)
            ),
            declarationRange = SourceRange(
                start = SourcePosition(line = 9, character = 0),
                end = SourcePosition(line = 13, character = 0)
            ),
            executionConfig = ExecutionConfig(retries = 2, timeoutMs = 3000, hasCompensation = true),
            executionTarget = ExecutionTarget(exportName = "orderWorkflow", stepIndex = 0)
        )

        val edge = GraphEdge(
            id = "edge_1",
            from = "step_charge_L10_C2",
            to = "step_receipt_L15_C2",
            type = "sequential"
        )

        val doc = GraphDocument(
            uri = "file:///app/order.workflow.ts",
            documentVersion = 1,
            workflowName = "orderWorkflow",
            properties = mapOf("timeoutMs" to "1000", "workflowVersion" to "v2"),
            nodes = listOf(node),
            edges = listOf(edge),
            unresolved = emptyList(),
            diagnostics = emptyList(),
            workflows = listOf(
                WorkflowGraph(
                    name = "orderWorkflow",
                    properties = mapOf("timeoutMs" to "1000", "workflowVersion" to "v2"),
                    nodes = listOf(node),
                    edges = listOf(edge)
                ),
                WorkflowGraph(
                    name = "paymentWorkflow",
                    nodes = listOf(node),
                    edges = emptyList()
                )
            )
        )

        val json = gson.toJson(doc)
        val deserialized = gson.fromJson(json, GraphDocument::class.java)

        assertEquals("orderWorkflow", deserialized.workflowName)
        assertEquals(1, deserialized.nodes.size)
        assertEquals("http", deserialized.nodes[0].stepKind)
        assertEquals(2, deserialized.nodes[0].executionConfig?.retries)
        assertEquals(true, deserialized.nodes[0].executionConfig?.hasCompensation)
        assertEquals("orderWorkflow", deserialized.nodes[0].executionTarget?.exportName)
        assertEquals(0, deserialized.nodes[0].executionTarget?.stepIndex)
        assertEquals("sequential", deserialized.edges[0].type)
        assertEquals("v2", deserialized.properties?.get("workflowVersion"))
        assertEquals("1000", deserialized.workflows[0].properties?.get("timeoutMs"))
        assertEquals(2, deserialized.workflows.size)
        assertEquals("paymentWorkflow", deserialized.workflows[1].name)
    }

    @Test
    fun testStructuredSpecsSurviveHostRoundTrip() {
        val json = """{
            "id":"normalize", "name":"Normalize", "stepKind":"generic",
            "location":{"start":{"line":0,"character":0},"end":{"line":1,"character":0}},
            "declarationRange":{"start":{"line":0,"character":0},"end":{"line":1,"character":0}},
            "specs":[
                {"field":"email","rules":[{"kind":"required","value":"true","expression":false}]},
                {"field":"email","rules":[{"kind":"translate","value":"value => value","expression":true}]},
                {"field":"${'$'}root${'$'}","rules":[{"kind":"schema","value":"schema","expression":true,"description":"Valid email required"}]}
            ]
        }"""
        val node = gson.fromJson(json, GraphNode::class.java)
        val roundTrip = gson.fromJson(gson.toJson(node), GraphNode::class.java)
        assertEquals(3, roundTrip.specs?.size)
        assertEquals(false, roundTrip.specs?.get(0)?.rules?.get(0)?.expression)
        assertEquals("translate", roundTrip.specs?.get(1)?.rules?.get(0)?.kind)
        assertEquals("Valid email required", roundTrip.specs?.get(2)?.rules?.get(0)?.description)
    }

    @Test
    fun testJsonRpcRequestSerialization() {
        val req = JsonRpcRequest(
            id = 42L,
            method = "siglo/getGraph",
            params = mapOf("uri" to "file:///order.ts", "documentVersion" to 1)
        )
        val json = gson.toJson(req)
        assertTrue(json.contains("\"method\":\"siglo/getGraph\""))
        assertTrue(json.contains("\"id\":42"))
    }

    @Test
    fun testNodeDiscoveryProbing() {
        // Node discovery should either discover local Node (>= 18) or return null safely without throwing
        val nodeExecutable = NodeDiscoveryService.findNodeExecutable()
        if (nodeExecutable != null) {
            assertTrue(nodeExecutable.contains("node"))
        }
    }

    @Test
    fun testM4TelemetryRecordingDocumentParsing() {
        val fixtureFile = File("../../fixtures/telemetry/sample-order-recording.json")
        assertTrue(fixtureFile.exists(), "Telemetry fixture file should exist")
        val content = fixtureFile.readText(Charsets.UTF_8)
        val jsonObject = gson.fromJson(content, JsonObject::class.java)

        assertEquals(1, jsonObject.get("version").asInt)
        assertEquals("sample-order-recording.json", jsonObject.get("fileName").asString)
        val records = jsonObject.getAsJsonArray("records")
        assertEquals(4, records.size())

        val httpRecord = records.map { it.asJsonObject }.find { it.getAsJsonObject("inspection").get("kind").asString == "http" }
        assertNotNull(httpRecord)
        assertEquals("chargeCard", httpRecord!!.get("stepIdentity").asString)
        assertEquals(200, httpRecord.getAsJsonObject("inspection").get("status").asInt)

        val cryptoRecord = records.map { it.asJsonObject }.find { it.getAsJsonObject("inspection").get("kind").asString == "crypto" }
        assertNotNull(cryptoRecord)
        assertEquals("verified", cryptoRecord!!.getAsJsonObject("inspection").get("category").asString)
    }

    @Test
    fun testExecutionTargetAndProtocolEvents() {
        val target = ExecutionTarget(exportName = "flowWorkflow", stepIndex = 3)
        assertEquals("flowWorkflow", target.exportName)
        assertEquals(3, target.stepIndex)

        val runEvent = JsonObject()
        runEvent.addProperty("type", "runEvent")
        runEvent.addProperty("runId", "run-123")
        runEvent.addProperty("status", "completed")
        runEvent.addProperty("elapsedMs", 150)
        val outputObj = JsonObject()
        outputObj.addProperty("result", "ok")
        runEvent.add("output", outputObj)

        val serialized = gson.toJson(runEvent)
        assertTrue(serialized.contains("\"runId\":\"run-123\""))
        assertTrue(serialized.contains("\"status\":\"completed\""))
        assertTrue(serialized.contains("\"result\":\"ok\""))
    }
}
