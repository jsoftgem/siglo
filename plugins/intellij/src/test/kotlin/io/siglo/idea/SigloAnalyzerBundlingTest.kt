package io.siglo.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
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
                const charge = Step.create('chargeCard', async (input: any) => input);
                return flow(validate, charge);
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
                    assertEquals(2, result.getAsJsonArray("nodes").size())
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
}
