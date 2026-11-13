package io.siglo.idea.process

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import java.io.File
import java.net.URI
import java.nio.file.Files

/** Owns one disposable execution supervisor for a visualizer panel. */
class ExecutionSession(private val project: Project, private val post: (JsonObject) -> Unit) : Disposable {
    private val gson = Gson()
    @Volatile private var process: Process? = null
    @Volatile private var busy = false
    @Volatile private var disposed = false
    @Volatile private var cancelled = false
    private var directory: File? = null

    @Synchronized fun run(request: JsonObject, document: GraphDocument?, sourceSnapshot: String?) {
        if (busy || disposed) return
        busy = true
        cancelled = false
        val runId = request.get("runId")?.asString ?: ""
        ApplicationManager.getApplication().executeOnPooledThread {
            var terminal = false
            fun event(status: String, error: String? = null) {
                val value = JsonObject()
                value.addProperty("type", "runEvent")
                value.addProperty("runId", runId)
                value.addProperty("status", status)
                if (error != null) value.addProperty("error", error)
                post(value)
            }
            try {
                check(SigloAnalyzerService.getInstance(project).isProjectTrusted(project, true)) { "Trust this project before executing code." }
                check(document != null && request.get("uri")?.asString == document.uri) { "Reload the workflow before running." }
                val unsaved = ApplicationManager.getApplication().runReadAction<Boolean> {
                    FileDocumentManager.getInstance().unsavedDocuments.isNotEmpty()
                }
                check(!unsaved) { "Save modified source files before running." }
                val file = try { File(URI(document!!.uri)) } catch (_: Exception) { File(document!!.uri.removePrefix("file://")) }
                request.add("document", gson.toJsonTree(document))
                check(sourceSnapshot != null) { "Reload the workflow before running." }
                request.addProperty("source", sourceSnapshot)
                request.addProperty("cwd", project.basePath ?: file.parent)
                val node = NodeDiscoveryService.findNodeExecutable() ?: error("Node.js is required to run steps.")
                val dir = Files.createTempDirectory("siglo-run-").toFile()
                directory = dir
                for (name in listOf("supervisor.cjs", "worker.cjs", "prepare.cjs")) {
                    val input = javaClass.getResourceAsStream("/ide-runner/$name") ?: error("Missing runner resources. Rebuild the plugin.")
                    input.use { source -> File(dir, name).outputStream().use { source.copyTo(it) } }
                }
                synchronized(this) {
                    check(!disposed && !cancelled) { "Execution cancelled." }
                    process = ProcessBuilder(node, File(dir, "supervisor.cjs").absolutePath).start()
                }
                val child = process!!
                ApplicationManager.getApplication().executeOnPooledThread {
                    child.errorStream.bufferedReader().useLines { lines -> lines.forEach { line ->
                        val log = JsonObject()
                        log.addProperty("type", "runEvent"); log.addProperty("runId", runId)
                        log.addProperty("status", "log"); log.addProperty("log", "$line\n")
                        post(log)
                    } }
                }
                synchronized(child) { child.outputStream.write((gson.toJson(request) + "\n").toByteArray()); child.outputStream.flush() }
                child.inputStream.bufferedReader().useLines { lines -> lines.forEach { line ->
                    val value = gson.fromJson(line, JsonObject::class.java)
                    if (value.get("status")?.asString in listOf("completed", "failed", "cancelled")) terminal = true
                    post(value)
                } }
                child.waitFor()
                if (!terminal && !disposed) event(if (cancelled) "cancelled" else "failed", "Execution process stopped.")
            } catch (error: Exception) {
                if (!disposed) event(if (cancelled) "cancelled" else "failed", error.message)
            } finally {
                process?.destroy(); process = null
                directory?.deleteRecursively(); directory = null
                busy = false
            }
        }
    }

    @Synchronized fun cancel() {
        cancelled = true
        process?.let { child ->
            try { synchronized(child) { child.outputStream.write("{\"type\":\"cancel\"}\n".toByteArray()); child.outputStream.flush() } }
            catch (_: Exception) { child.destroy() }
        }
    }
    @Synchronized override fun dispose() {
        disposed = true
        process?.descendants()?.forEach { it.destroyForcibly() }
        process?.destroy()
        process = null
        directory?.deleteRecursively()
        directory = null
    }
}
