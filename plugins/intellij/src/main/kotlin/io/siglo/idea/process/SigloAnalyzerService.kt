package io.siglo.idea.process

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import java.io.File
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

@Service(Service.Level.PROJECT)
class SigloAnalyzerService(private val project: Project) : Disposable {
    private val LOG = Logger.getInstance(SigloAnalyzerService::class.java)
    private val gson = Gson()
    private val requestId = AtomicLong(1)
    private val pendingRequests = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()

    private var processHandler: OSProcessHandler? = null
    private var processWriter: OutputStreamWriter? = null
    private val lineBuffer = StringBuilder()
    private var isInitialized = false

    companion object {
        fun getInstance(project: Project): SigloAnalyzerService {
            return project.getService(SigloAnalyzerService::class.java)
        }
    }

    private fun isProjectTrusted(project: Project): Boolean {
        return try {
            val trustedProjectsClass = Class.forName("com.intellij.ide.trustedProjects.TrustedProjects")
            val method = trustedProjectsClass.methods.firstOrNull {
                it.name == "isProjectTrusted" && it.parameterCount == 1
            }
            if (method != null) {
                val target = if (java.lang.reflect.Modifier.isStatic(method.modifiers)) null else {
                    trustedProjectsClass.getField("INSTANCE").get(null)
                }
                if (method.parameterTypes[0].isAssignableFrom(project.javaClass)) {
                    method.invoke(target, project) as Boolean
                } else {
                    val locatorClass = Class.forName("com.intellij.ide.trustedProjects.TrustedProjectsLocator")
                    val locateMethod = locatorClass.getMethod("locateProject", Project::class.java)
                    val located = locateMethod.invoke(null, project)
                    method.invoke(target, located) as Boolean
                }
            } else {
                true
            }
        } catch (_: Throwable) {
            try {
                val oldClass = Class.forName("com.intellij.ide.impl.TrustedProjects")
                val isTrustedMethod = oldClass.getMethod("isTrusted", Project::class.java)
                isTrustedMethod.invoke(null, project) as Boolean
            } catch (_: Throwable) {
                true
            }
        }
    }

    @Synchronized
    fun ensureStarted(): CompletableFuture<Boolean> {
        if (isInitialized && processHandler?.isProcessTerminated == false) {
            return CompletableFuture.completedFuture(true)
        }

        // Trust Gate
        if (!isProjectTrusted(project)) {
            LOG.warn("Project is not trusted. Skipping Siglo static analyzer launch.")
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Siglo Notifications")
                .createNotification(
                    "Siglo Workflows",
                    "Static analyzer daemon launch blocked: workspace is untrusted.",
                    NotificationType.WARNING
                )
                .notify(project)
            val future = CompletableFuture<Boolean>()
            future.complete(false)
            return future
        }

        val nodePath = NodeDiscoveryService.findNodeExecutable()
        if (nodePath == null) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Siglo Notifications")
                .createNotification(
                    "Siglo Workflows",
                    "Node.js (>= 18.0.0) was not found. Please install Node.js to enable Siglo static analysis.",
                    NotificationType.ERROR
                )
                .notify(project)
            return CompletableFuture.completedFuture(false)
        }

        val analyzerBinPath = findAnalyzerBinary()
        if (analyzerBinPath == null || !File(analyzerBinPath).exists()) {
            LOG.warn("Could not locate Siglo ide-analysis binary.")
            return CompletableFuture.completedFuture(false)
        }

        return try {
            val commandLine = GeneralCommandLine()
                .withExePath(nodePath)
                .withParameters(analyzerBinPath)
                .withWorkDirectory(project.basePath ?: ".")
                .withCharset(StandardCharsets.UTF_8)

            val handler = OSProcessHandler(commandLine)
            this.processHandler = handler
            this.processWriter = OutputStreamWriter(handler.processInput, StandardCharsets.UTF_8)

            handler.addProcessListener(object : ProcessListener {
                override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                    if (outputType == ProcessOutputTypes.STDOUT) {
                        handleProcessStdout(event.text)
                    } else if (outputType == ProcessOutputTypes.STDERR) {
                        LOG.debug("Siglo Analyzer STDERR: ${event.text}")
                    }
                }

                override fun processTerminated(event: ProcessEvent) {
                    LOG.info("Siglo Analyzer process terminated with exit code: ${event.exitCode}")
                    isInitialized = false
                    failAllPending(IllegalStateException("Analyzer process terminated: exit code ${event.exitCode}"))
                }
            })

            handler.startNotify()

            // Send initialize request
            val initParams = mapOf(
                "clientName" to "IntelliJ IDEA",
                "clientVersion" to "2024.1",
                "rootUri" to (project.basePath?.let { "file://$it" } ?: ""),
                "capabilities" to mapOf("dynamicRefresh" to true)
            )

            sendRequest("siglo/initialize", initParams).thenApply { res ->
                isInitialized = true
                LOG.info("Siglo static analyzer initialized successfully: $res")
                true
            }.exceptionally { err ->
                LOG.error("Failed to initialize Siglo static analyzer", err)
                false
            }
        } catch (e: Exception) {
            LOG.error("Failed to launch Siglo static analyzer process", e)
            CompletableFuture.completedFuture(false)
        }
    }

    private fun findAnalyzerBinary(): String? {
        val customBin = System.getenv("SIGLO_ANALYZER_BIN") ?: System.getProperty("siglo.analyzer.bin")
        if (customBin != null && File(customBin).exists()) {
            return customBin
        }

        val basePath = project.basePath ?: return null
        val candidates = listOf(
            "$basePath/packages/ide-analysis/dist/bin.js",
            "$basePath/node_modules/@siglo/ide-analysis/dist/bin.js"
        )
        for (candidate in candidates) {
            if (File(candidate).exists()) {
                return candidate
            }
        }
        return null
    }

    private fun handleProcessStdout(chunk: String) {
        synchronized(lineBuffer) {
            lineBuffer.append(chunk)
            val content = lineBuffer.toString()
            val lines = content.split("\n")
            if (lines.size > 1) {
                for (i in 0 until lines.size - 1) {
                    processMessageLine(lines[i].trim())
                }
                lineBuffer.setLength(0)
                lineBuffer.append(lines.last())
            }
        }
    }

    private fun processMessageLine(line: String) {
        if (line.isEmpty()) return
        try {
            val json = gson.fromJson(line, JsonObject::class.java) ?: return
            if (json.has("id") && !json.get("id").isJsonNull) {
                val id = json.get("id").asLong
                val future = pendingRequests.remove(id)
                if (future != null) {
                    if (json.has("error") && !json.get("error").isJsonNull) {
                        val errorObj = json.getAsJsonObject("error")
                        val code = errorObj.get("code")?.asInt ?: -1
                        val msg = errorObj.get("message")?.asString ?: "Unknown error"
                        future.completeExceptionally(RuntimeException("JSON-RPC error ($code): $msg"))
                    } else {
                        val result = json.get("result")
                        future.complete(result)
                    }
                }
            }
        } catch (e: Exception) {
            LOG.warn("Failed to parse JSON-RPC line from analyzer: $line", e)
        }
    }

    private fun sendRequest(method: String, params: Any?): CompletableFuture<JsonElement> {
        val id = requestId.getAndIncrement()
        val future = CompletableFuture<JsonElement>()
        pendingRequests[id] = future

        val request = JsonRpcRequest(id = id, method = method, params = params)
        val json = gson.toJson(request)

        synchronized(this) {
            val writer = processWriter
            if (writer != null) {
                try {
                    writer.write(json + "\n")
                    writer.flush()
                } catch (e: Exception) {
                    pendingRequests.remove(id)
                    future.completeExceptionally(e)
                }
            } else {
                pendingRequests.remove(id)
                future.completeExceptionally(IllegalStateException("Analyzer process is not running"))
            }
        }

        return future
    }

    fun getGraph(uri: String, version: Int = 1, content: String? = null): CompletableFuture<GraphDocument> {
        return ensureStarted().thenCompose { started ->
            if (!started) {
                CompletableFuture.failedFuture(IllegalStateException("Analyzer could not be started"))
            } else {
                val params = mutableMapOf<String, Any>(
                    "uri" to uri,
                    "documentVersion" to version
                )
                if (content != null) {
                    params["content"] = content
                }
                sendRequest("siglo/getGraph", params).thenApply { elem ->
                    gson.fromJson(elem, GraphDocument::class.java)
                }
            }
        }
    }

    fun resolveLocation(uri: String, line: Int, character: Int): CompletableFuture<ResolveLocationResult> {
        return ensureStarted().thenCompose { started ->
            if (!started) {
                CompletableFuture.failedFuture(IllegalStateException("Analyzer could not be started"))
            } else {
                val params = mapOf(
                    "uri" to uri,
                    "position" to SourcePosition(line = line, character = character)
                )
                sendRequest("siglo/resolveLocation", params).thenApply { elem ->
                    gson.fromJson(elem, ResolveLocationResult::class.java)
                }
            }
        }
    }

    fun discoverWorkflows(documentUri: String? = null): CompletableFuture<List<DiscoveredWorkflow>> {
        return ensureStarted().thenCompose { started ->
            if (!started) {
                CompletableFuture.completedFuture(emptyList())
            } else {
                val params = mutableMapOf<String, Any>()
                if (documentUri != null) {
                    params["documentUri"] = documentUri
                } else if (project.basePath != null) {
                    params["workspaceUri"] = "file://${project.basePath}"
                }
                sendRequest("siglo/discoverWorkflows", params).thenApply { elem ->
                    val result = gson.fromJson(elem, DiscoverWorkflowsResult::class.java)
                    result?.workflows ?: emptyList()
                }
            }
        }
    }

    private fun failAllPending(throwable: Throwable) {
        val entries = pendingRequests.entries.toList()
        pendingRequests.clear()
        for (entry in entries) {
            entry.value.completeExceptionally(throwable)
        }
    }

    override fun dispose() {
        try {
            if (processWriter != null) {
                sendRequest("siglo/shutdown", emptyMap<String, Any>())
            }
        } catch (_: Exception) {
        } finally {
            try {
                processHandler?.destroyProcess()
            } catch (_: Exception) {}
            processHandler = null
            processWriter = null
        }
    }
}
