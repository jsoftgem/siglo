package io.siglo.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import io.siglo.idea.process.GraphDocument
import io.siglo.idea.process.NodeDiscoveryService
import io.siglo.idea.process.SigloAnalyzerService
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files

class SigloAnalyzerBundlingTest {
    private val gson = Gson()

    private fun proxyProject(basePath: String?): Project {
        return Proxy.newProxyInstance(
            Project::class.java.classLoader,
            arrayOf(Project::class.java)
        ) { _, method, _ ->
            when (method.name) {
                "getBasePath" -> basePath
                "getName" -> "external-test-project"
                "isDisposed" -> false
                else -> when (method.returnType) {
                    Boolean::class.javaPrimitiveType -> false
                    Int::class.javaPrimitiveType -> 0
                    Long::class.javaPrimitiveType -> 0L
                    else -> null
                }
            }
        } as Project
    }

    @Test
    fun testBundledAnalyzerResourceExistsAndExtractsForExternalProjects() {
        val resourceStream = SigloAnalyzerService::class.java.getResourceAsStream("/ide-analysis/analyzer.js")
        assertNotNull(resourceStream, "Bundled /ide-analysis/analyzer.js resource must be present")
        resourceStream?.close()

        val externalDir = Files.createTempDirectory("siglo-ext-project-").toFile()
        val workflowFile = File(externalDir, "workflow.ts")
        workflowFile.writeText(
            """
            import { Step, flow } from '@siglo/core';
            export function createOrderWorkflow() {
                const validate = Step.create('validateOrder', async (input: any) => input);
                const tax = Step.compute('calcTax', (input: any) => ({ tax: 10 })).cache('5m');
                const charge = Step.create('chargeCard', async (input: any) => input);
                return flow(validate, tax, charge);
            }
            """.trimIndent(),
            Charsets.UTF_8
        )

        val service = SigloAnalyzerService(proxyProject(externalDir.absolutePath))
        try {
            val binaryPath = service.findAnalyzerBinary()
            assertNotNull(binaryPath, "findAnalyzerBinary() should resolve bundled analyzer for external project")
            val binaryFile = File(binaryPath!!)
            assertTrue(binaryFile.exists(), "Extracted analyzer.js must exist on disk")
            assertFalse(
                binaryFile.absolutePath.startsWith(externalDir.absolutePath),
                "External project should use extracted bundled analyzer rather than nonexistent workspace node_modules"
            )

            // Reusing cached extraction should return the exact same file path
            assertEquals(binaryPath, service.findAnalyzerBinary())

            val node = NodeDiscoveryService.findNodeExecutable()
            if (node != null) {
                val proc = ProcessBuilder(node, binaryPath)
                    .directory(externalDir)
                    .start()
                try {
                    val initReq = gson.toJson(
                        mapOf(
                            "jsonrpc" to "2.0",
                            "id" to 1,
                            "method" to "siglo/initialize",
                            "params" to mapOf("clientName" to "test", "rootUri" to externalDir.toURI().toString())
                        )
                    )
                    val graphReq = gson.toJson(
                        mapOf(
                            "jsonrpc" to "2.0",
                            "id" to 2,
                            "method" to "siglo/getGraph",
                            "params" to mapOf(
                                "uri" to workflowFile.toURI().toString(),
                                "documentVersion" to 1,
                                "content" to workflowFile.readText(Charsets.UTF_8)
                            )
                        )
                    )
                    proc.outputStream.bufferedWriter(Charsets.UTF_8).use { writer ->
                        writer.write(initReq + "\n")
                        writer.write(graphReq + "\n")
                        writer.flush()
                    }
                    val lines = proc.inputStream.bufferedReader(Charsets.UTF_8).readLines()
                    assertTrue(lines.size >= 2, "Expected initialize and getGraph responses, got ${lines.size}")
                    val graphResp = gson.fromJson(lines[1], JsonObject::class.java)
                    val result = graphResp.getAsJsonObject("result")
                    assertEquals("createOrderWorkflow", result.get("workflowName").asString)
                    val nodes = result.getAsJsonArray("nodes")
                    assertEquals(3, nodes.size())
                    val computeNode = nodes.map { it.asJsonObject }.first { it.get("name").asString == "calcTax" }
                    assertEquals("compute", computeNode.get("stepKind").asString)
                    assertEquals("deny", computeNode.getAsJsonObject("properties").get("networkPolicy").asString)
                } finally {
                    proc.destroyForcibly()
                }
            }
        } finally {
            val extractedPath = service.findAnalyzerBinary()
            service.dispose()
            if (extractedPath != null) {
                assertFalse(File(extractedPath).exists(), "dispose() should clean up extracted analyzer directory")
            }
            externalDir.deleteRecursively()
        }
    }

    @Test
    fun testStepComputeAnalysisDiagnosticsAndBundledRunnerExecution() {
        val node = NodeDiscoveryService.findNodeExecutable() ?: return

        val repoRoot = File("../..").canonicalFile
        val externalDir = Files.createTempDirectory(repoRoot.toPath(), ".intellij-compute-e2e-").toFile()
        val workflowFile = File(externalDir, "compute.workflow.ts")
        val workflowSource = """
            import { Step, ComputeStep, flow } from '@siglo/core';
            const calcDiscount = Step.compute(
                'calcDiscount',
                ({ subtotal }: { subtotal: number }) => ({ discounted: subtotal * 0.9 })
            )
                .spec('subtotal', { require: true, validate: (v: number) => v > 0 })
                .cache('5m');
            const addHandling = new ComputeStep(
                'addHandling',
                ({ discounted }: { discounted: number }) => ({ total: discounted + 5 })
            ).cache({ ttl: '1m', maxEntries: 100 });
            export const pricingWorkflow = flow(calcDiscount, addHandling);
        """.trimIndent()
        workflowFile.writeText(workflowSource, Charsets.UTF_8)

        val sagaWithComputeSource = """
            import { Step, flow } from '@siglo/core';
            import { httpStep } from '@siglo/http';
            import { encryptFieldsStep } from '@siglo/crypto';
            const calcTotals = Step.compute('calcTotals', (ctx: { subtotal: number }) => ({ total: ctx.subtotal * 1.08 })).cache('5m');
            const refundCard = Step.create('refundCard', () => {});
            const chargeCard = httpStep('chargeCard', { method: 'POST', url: 'https://api.stripe.com/charges' }).compensate(refundCard);
            const encryptReceipt = encryptFieldsStep('encryptReceipt', { fields: ['cardNumber'] });
            export const checkoutSaga = flow('checkoutSaga', calcTotals, chargeCard, encryptReceipt);
        """.trimIndent()

        val service = SigloAnalyzerService(proxyProject(externalDir.absolutePath))
        val runnerDir = Files.createTempDirectory("siglo-runner-e2e-").toFile()
        try {
            val binaryPath = service.findAnalyzerBinary()
            assertNotNull(binaryPath)

            // 1. Analyze workflow with Step.compute via bundled analyzer.js and deserialize into GraphDocument
            val analyzerProc = ProcessBuilder(node, binaryPath!!)
                .directory(externalDir)
                .start()
            val graphDoc: GraphDocument
            val sagaGraphDoc: GraphDocument
            try {
                val initReq = gson.toJson(
                    mapOf(
                        "jsonrpc" to "2.0",
                        "id" to 1,
                        "method" to "siglo/initialize",
                        "params" to mapOf("clientName" to "intellij-test", "rootUri" to "file://${externalDir.absolutePath}")
                    )
                )
                val graphReq = gson.toJson(
                    mapOf(
                        "jsonrpc" to "2.0",
                        "id" to 2,
                        "method" to "siglo/getGraph",
                        "params" to mapOf(
                            "uri" to "file://${workflowFile.absolutePath}",
                            "documentVersion" to 1,
                            "content" to workflowSource
                        )
                    )
                )
                val sagaGraphReq = gson.toJson(
                    mapOf(
                        "jsonrpc" to "2.0",
                        "id" to 3,
                        "method" to "siglo/getGraph",
                        "params" to mapOf(
                            "uri" to "file://${File(externalDir, "saga.workflow.ts").absolutePath}",
                            "documentVersion" to 1,
                            "content" to sagaWithComputeSource
                        )
                    )
                )
                analyzerProc.outputStream.bufferedWriter(Charsets.UTF_8).use { writer ->
                    writer.write(initReq + "\n")
                    writer.write(graphReq + "\n")
                    writer.write(sagaGraphReq + "\n")
                    writer.flush()
                }
                val lines = analyzerProc.inputStream.bufferedReader(Charsets.UTF_8).readLines()
                assertTrue(lines.size >= 3)
                val graphResp = gson.fromJson(lines[1], JsonObject::class.java)
                graphDoc = gson.fromJson(graphResp.getAsJsonObject("result"), GraphDocument::class.java)
                val sagaResp = gson.fromJson(lines[2], JsonObject::class.java)
                sagaGraphDoc = gson.fromJson(sagaResp.getAsJsonObject("result"), GraphDocument::class.java)
            } finally {
                analyzerProc.destroyForcibly()
            }

            assertEquals("pricingWorkflow", graphDoc.workflowName)
            val discountNode = graphDoc.nodes.firstOrNull { it.name == "calcDiscount" }
            assertNotNull(discountNode, "Expected calcDiscount compute node")
            assertEquals("compute", discountNode!!.stepKind)
            assertEquals("Step.compute", discountNode.properties?.get("operation"))
            assertEquals("deny", discountNode.properties?.get("networkPolicy"))
            assertEquals("'5m'", discountNode.properties?.get("cache"))
            assertNotNull(discountNode.specs)
            assertEquals("subtotal", discountNode.specs!!.first().field)
            assertEquals("pricingWorkflow", discountNode.executionTarget?.exportName)
            assertEquals(0, discountNode.executionTarget?.stepIndex)

            val handlingNode = graphDoc.nodes.firstOrNull { it.name == "addHandling" }
            assertNotNull(handlingNode, "Expected addHandling ComputeStep node")
            assertEquals("compute", handlingNode!!.stepKind)
            assertEquals("ComputeStep", handlingNode.properties?.get("operation"))
            assertEquals("deny", handlingNode.properties?.get("networkPolicy"))
            assertEquals("{ ttl: '1m', maxEntries: 100 }", handlingNode.properties?.get("cache"))
            assertEquals(1, handlingNode.executionTarget?.stepIndex)

            // Verify Step.compute is exempt from SIGLO_MISSING_COMPENSATION in sagas while uncompensated side-effect steps are flagged
            val sagaDiags = (sagaGraphDoc.diagnostics + sagaGraphDoc.workflows.flatMap { it.diagnostics })
                .distinctBy { "${it.code}:${it.range.start.line}:${it.range.start.character}:${it.message}" }
                .filter { it.code == "SIGLO_MISSING_COMPENSATION" }
            assertEquals(1, sagaDiags.size)
            assertTrue(sagaDiags.first().message.contains("encryptReceipt"))

            // 2. Execute the Step.compute nodes (ranged execution calcDiscount -> addHandling) through bundled /ide-runner
            for (name in listOf("supervisor.cjs", "worker.cjs", "prepare.cjs")) {
                val input = javaClass.getResourceAsStream("/ide-runner/$name")
                assertNotNull(input, "Bundled /ide-runner/$name resource must be present")
                input!!.use { src -> File(runnerDir, name).outputStream().use { src.copyTo(it) } }
            }

            val inputObj = JsonObject().apply { addProperty("subtotal", 200) }
            val runRequest = JsonObject().apply {
                addProperty("type", "runSteps")
                addProperty("runId", "intellij-compute-run-1")
                addProperty("uri", graphDoc.uri)
                addProperty("documentVersion", graphDoc.documentVersion)
                addProperty("workflowName", graphDoc.workflowName)
                add("nodeIds", gson.toJsonTree(listOf(discountNode.id, handlingNode.id)))
                add("input", inputObj)
                add("document", gson.toJsonTree(graphDoc))
                addProperty("source", workflowSource)
                addProperty("cwd", externalDir.absolutePath)
            }

            val runnerProc = ProcessBuilder(node, File(runnerDir, "supervisor.cjs").absolutePath)
                .directory(externalDir)
                .start()
            try {
                runnerProc.outputStream.write((gson.toJson(runRequest) + "\n").toByteArray(Charsets.UTF_8))
                runnerProc.outputStream.flush()
                val eventLines = runnerProc.inputStream.bufferedReader(Charsets.UTF_8).readLines()
                runnerProc.waitFor()
                val events = eventLines.mapNotNull { line ->
                    try { gson.fromJson(line, JsonObject::class.java) } catch (_: Exception) { null }
                }

                val failedEvent = events.firstOrNull { it.get("status")?.asString == "failed" }
                assertNull(failedEvent, "Expected no failure event, got: $eventLines")

                val discountCompleted = events.firstOrNull {
                    it.get("status")?.asString == "step" &&
                        it.get("nodeId")?.asString == discountNode.id &&
                        it.has("output")
                }
                assertNotNull(discountCompleted, "Expected step output event for calcDiscount Step.compute node: $eventLines")
                assertEquals(180, discountCompleted!!.getAsJsonObject("output").get("discounted").asInt)

                val handlingCompleted = events.firstOrNull {
                    it.get("status")?.asString == "step" &&
                        it.get("nodeId")?.asString == handlingNode.id &&
                        it.has("output")
                }
                assertNotNull(handlingCompleted, "Expected step output event for addHandling ComputeStep node: $eventLines")
                assertEquals(185, handlingCompleted!!.getAsJsonObject("output").get("total").asInt)

                val runCompleted = events.firstOrNull { it.get("status")?.asString == "completed" }
                assertNotNull(runCompleted, "Expected completed event for Step.compute run: $eventLines")
                assertEquals(185, runCompleted!!.getAsJsonObject("output").get("total").asInt)
            } finally {
                runnerProc.destroyForcibly()
            }
        } finally {
            service.dispose()
            runnerDir.deleteRecursively()
            externalDir.deleteRecursively()
        }
    }
}
