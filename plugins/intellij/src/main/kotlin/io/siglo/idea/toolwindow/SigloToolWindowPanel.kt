package io.siglo.idea.toolwindow

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.Alarm
import io.siglo.idea.process.GraphDocument
import io.siglo.idea.process.GraphNode
import io.siglo.idea.process.SigloAnalyzerService
import java.awt.BorderLayout
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.JPanel
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

class SigloToolWindowPanel(
    private val project: Project,
    private val parentDisposable: Disposable
) : JPanel(BorderLayout()), Disposable {

    private val LOG = Logger.getInstance(SigloToolWindowPanel::class.java)
    private val gson = Gson()
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val graphRequestCounter = AtomicInteger(0)
    private val sourceRevisions = mutableMapOf<String, Pair<String?, Int>>()

    private var jcefBrowserView: JcefBrowserView? = null
    private var fallbackTree: Tree? = null
    private var currentDocument: GraphDocument? = null
    private var activeVirtualFile: VirtualFile? = null
    private var isUiReady = false
    private var isAutoReloadEnabled = true

    init {
        var initializedJcef = false
        try {
            if (isJcefAvailable()) {
                val jcef = JcefBrowserView(
                    htmlContent = loadUiBundleHtml(),
                    onMessage = { request -> handleWebviewMessage(request) }
                )
                this.jcefBrowserView = jcef
                add(jcef.component, BorderLayout.CENTER)
                initializedJcef = true
                LOG.info("Initialized JCEF browser successfully for Siglo Workflows")
            }
        } catch (e: Throwable) {
            LOG.warn("Failed to initialize JCEF browser, falling back to Swing tree view", e)
        }

        if (!initializedJcef) {
            val tree = Tree()
            this.fallbackTree = tree
            add(JBScrollPane(tree), BorderLayout.CENTER)
            add(JBLabel("Running in headless/fallback Swing tree mode (JCEF unavailable)"), BorderLayout.NORTH)
        }

        // Register tab change listener to automatically track open editor file
        val messageBus = project.messageBus.connect(this)
        messageBus.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) {
                val newFile = event.newFile
                if (newFile != null && isSupportedFile(newFile)) {
                    refreshForFile(newFile)
                }
            }
        })

        // Listen for live buffer edits in open documents (debounced at 250ms)
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (!isAutoReloadEnabled) return
                val fileDocManager = FileDocumentManager.getInstance()
                val virtualFile = fileDocManager.getFile(event.document) ?: return
                if (!isSupportedFile(virtualFile)) return

                val docText = event.document.text
                alarm.cancelAllRequests()
                alarm.addRequest({
                    if (FileEditorManager.getInstance(project).selectedFiles.firstOrNull() == virtualFile) {
                        refreshForFile(virtualFile, contentOverride = docText, force = true)
                    }
                }, 250)
            }
        }, this)

        // Track whatever file is already open right now upon creation
        val currentSelected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull { isSupportedFile(it) }
        val candidate = currentSelected
            ?: FileEditorManager.getInstance(project).openFiles.firstOrNull { isSupportedFile(it) }

        if (candidate != null) {
            activeVirtualFile = candidate
        }
    }

    private fun isSupportedFile(file: VirtualFile): Boolean {
        val name = file.name
        return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js") || name.endsWith(".jsx")
    }

    fun refreshForFile(
        file: VirtualFile,
        contentOverride: String? = null,
        force: Boolean = false
    ) {
        if (!force && activeVirtualFile == file && currentDocument?.uri == file.url) {
            return
        }
        activeVirtualFile = file

        val service = SigloAnalyzerService.getInstance(project)
        val uri = file.url
        val content = contentOverride ?: run {
            try {
                ApplicationManager.getApplication().runReadAction<String?> {
                    val doc = FileDocumentManager.getInstance().getDocument(file)
                    doc?.text
                } ?: String(file.contentsToByteArray(), Charsets.UTF_8)
            } catch (_: Exception) {
                try {
                    String(file.contentsToByteArray(), Charsets.UTF_8)
                } catch (_: Exception) {
                    null
                }
            }
        }

        val requestId = graphRequestCounter.incrementAndGet()
        val previous = sourceRevisions[uri]
        val version = if (previous == null) 1 else if (previous.first == content) previous.second else previous.second + 1
        sourceRevisions[uri] = content to version

        service.getGraph(uri = uri, version = version, content = content).thenAccept { doc ->
            ApplicationManager.getApplication().invokeLater {
                // Ignore stale responses if a newer version has already arrived
                if (requestId == graphRequestCounter.get() && activeVirtualFile == file) {
                    renderDocument(doc)
                }
            }
        }.exceptionally { err ->
            LOG.debug("No Siglo workflow graph in file: ${file.name} (${err.message})")
            null
        }
    }

    private fun isJcefAvailable(): Boolean {
        return try {
            Class.forName("com.intellij.ui.jcef.JBCefApp")
            com.intellij.ui.jcef.JBCefApp.isSupported()
        } catch (_: Throwable) {
            false
        }
    }

    private fun loadUiBundleHtml(): String {
        val resourceStream = SigloToolWindowPanel::class.java.getResourceAsStream("/ide-ui/index.html")
        if (resourceStream != null) {
            return resourceStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        }

        // Try reading from monorepo packages/ide-ui/dist/index.html
        val basePath = project.basePath
        if (basePath != null) {
            val distFile = File(basePath, "packages/ide-ui/dist/index.html")
            if (distFile.exists()) {
                return distFile.readText(Charsets.UTF_8)
            }
        }

        return """
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"/><title>Siglo Workflows</title></head>
            <body style="background:#1e1f22;color:#bcbec4;font-family:sans-serif;padding:24px;">
                <h3>Siglo Workflows</h3>
                <p>Waiting for UI assets to bundle or file selection...</p>
            </body>
            </html>
        """.trimIndent()
    }

    fun renderDocument(doc: GraphDocument) {
        currentDocument = doc

        val json = gson.toJson(doc)
        if (jcefBrowserView != null) {
            val script = "if (window.__SIGLO_BRIDGE__) { window.__SIGLO_BRIDGE__.dispatch(JSON.stringify({ type: 'setGraph', document: $json })); }"
            jcefBrowserView?.executeJavaScript(script)
        } else {
            renderFallbackTree(doc)
        }
    }

    private fun renderFallbackTree(doc: GraphDocument) {
        val rootTitle = "${doc.workflowName} (r${doc.documentVersion})"
        val rootNode = DefaultMutableTreeNode(rootTitle)

        if (doc.workflows.isNotEmpty()) {
            for (wf in doc.workflows) {
                val wfItem = DefaultMutableTreeNode("${wf.name} (${wf.nodes.size} steps)")
                for (node in wf.nodes) {
                    wfItem.add(DefaultMutableTreeNode(node))
                }
                for (un in wf.unresolved) {
                    wfItem.add(DefaultMutableTreeNode("[Unresolved] ${un.expressionSnippet}"))
                }
                rootNode.add(wfItem)
            }
        } else {
            for (node in doc.nodes) {
                val nodeItem = DefaultMutableTreeNode(node)
                rootNode.add(nodeItem)
            }
            for (un in doc.unresolved) {
                rootNode.add(DefaultMutableTreeNode("[Unresolved] ${un.expressionSnippet}"))
            }
        }

        fallbackTree?.model = DefaultTreeModel(rootNode)
    }

    private fun handleWebviewMessage(request: String) {
        try {
            val json = gson.fromJson(request, JsonObject::class.java) ?: return
            val type = json.get("type")?.asString

            when (type) {
                "ready" -> {
                    isUiReady = true
                    // First preference: currently open/selected file in editor
                    ApplicationManager.getApplication().invokeLater {
                        val currentSelectedFiles = FileEditorManager.getInstance(project).selectedFiles
                        val activeFile = currentSelectedFiles.firstOrNull { isSupportedFile(it) } ?: activeVirtualFile
                        if (activeFile != null) {
                            refreshForFile(activeFile, force = true)
                        } else {
                            loadInitialWorkflow()
                        }
                    }
                }
                "reload" -> {
                    // Manual reload request triggered from webview button
                    ApplicationManager.getApplication().invokeLater {
                        val targetFile = activeVirtualFile
                            ?: FileEditorManager.getInstance(project).selectedFiles.firstOrNull { isSupportedFile(it) }
                        if (targetFile != null) {
                            refreshForFile(targetFile, force = true)
                        } else {
                            loadInitialWorkflow()
                        }
                    }
                }
                "setAutoReload" -> {
                    // Toggle auto-reload state from webview checkbox
                    if (json.has("enabled")) {
                        isAutoReloadEnabled = json.get("enabled").asBoolean
                        LOG.info("Siglo workflow auto-reload set to: $isAutoReloadEnabled")
                    }
                }
                "importTelemetry" -> {
                    ApplicationManager.getApplication().invokeLater {
                        importTelemetry()
                    }
                }
                "nodeSelected" -> {
                    val nodeId = json.get("nodeId")?.asString
                    val node = currentDocument?.nodes?.find { it.id == nodeId }
                        ?: currentDocument?.workflows?.flatMap { it.nodes }?.find { it.id == nodeId }
                    if (node != null) {
                        navigateToNodeInEditor(node)
                    }
                }
                "workflowSelected" -> {
                    val workflowName = json.get("workflowName")?.asString
                    val doc = currentDocument
                    if (doc != null && workflowName != null) {
                        val wf = doc.workflows.find { it.name == workflowName }
                        val targetUri = wf?.uri ?: doc.uri
                        val targetLoc = wf?.location
                            ?: (if (doc.workflowName == workflowName) doc.location else null)
                            ?: wf?.nodes?.firstOrNull()?.location
                            ?: doc.nodes.firstOrNull()?.location
                        if (wf != null || doc.workflowName == workflowName) {
                            navigateToLocation(
                                targetLoc?.start?.line ?: 0,
                                targetLoc?.start?.character ?: 0,
                                targetUri
                            )
                        }
                    }
                }
                "openRelatedFile" -> {
                    val targetUri = json.get("uri")?.asString
                    val doc = currentDocument
                    if (doc != null && targetUri != null) {
                        val allNodes = doc.nodes + doc.workflows.flatMap { it.nodes }
                        val matchingNode = allNodes.find { it.sourceUri == targetUri }
                        val matchingWf = doc.workflows.find { it.uri == targetUri }
                        val isCurrentDoc = doc.uri == targetUri
                        if (matchingNode != null || matchingWf != null || isCurrentDoc) {
                            val targetLoc = matchingNode?.sourceLocation
                                ?: matchingWf?.location
                                ?: matchingNode?.location
                                ?: doc.location
                            navigateToLocation(
                                targetLoc?.start?.line ?: 0,
                                targetLoc?.start?.character ?: 0,
                                targetUri
                            )
                        }
                    }
                }
            }
        } catch (e: Exception) {
            LOG.error("Failed to parse message from Siglo webview: $request", e)
        }
    }

    fun importTelemetry() {
        val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
            .withTitle("Import Siglo Telemetry Recording")
            .withDescription("Select a recorded telemetry JSON file (*.json)")
            .withFileFilter { it.extension?.lowercase() == "json" }
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        try {
            val content = String(chosen.contentsToByteArray(), Charsets.UTF_8)
            val jsonElement = try {
                gson.fromJson(content, JsonElement::class.java)
            } catch (e: Exception) {
                null
            }
            if (jsonElement != null) {
                val wrapped = JsonObject()
                wrapped.addProperty("type", "setTelemetry")
                if (jsonElement.isJsonObject) {
                    val docObj = jsonElement.asJsonObject
                    if (!docObj.has("fileName")) {
                        docObj.addProperty("fileName", chosen.name)
                    }
                    wrapped.add("document", docObj)
                } else if (jsonElement.isJsonArray) {
                    val docObj = JsonObject()
                    docObj.addProperty("version", 1)
                    docObj.addProperty("fileName", chosen.name)
                    docObj.addProperty("importedAt", java.time.Instant.now().toString())
                    docObj.add("records", jsonElement.asJsonArray)
                    wrapped.add("document", docObj)
                }
                val rawPayload = gson.toJson(wrapped)
                val script = "if (window.__SIGLO_BRIDGE__) { window.__SIGLO_BRIDGE__.dispatch($rawPayload); }"
                jcefBrowserView?.executeJavaScript(script)
            }
        } catch (e: Exception) {
            LOG.warn("Failed to read telemetry file: ${chosen.name}", e)
        }
    }

    private fun loadInitialWorkflow() {
        val service = SigloAnalyzerService.getInstance(project)
        service.discoverWorkflows().thenAccept { workflows ->
            if (workflows.isNotEmpty()) {
                val first = workflows.first()
                service.getGraph(first.uri).thenAccept { doc ->
                    ApplicationManager.getApplication().invokeLater {
                        renderDocument(doc)
                    }
                }
            }
        }
    }

    fun navigateToNodeInEditor(node: GraphNode) {
        val targetUri = node.sourceUri ?: currentDocument?.uri
        val targetRange = node.sourceLocation ?: node.location
        navigateToLocation(targetRange.start.line, targetRange.start.character, targetUri)
    }

    private fun navigateToLocation(line: Int, character: Int, targetUri: String? = currentDocument?.uri) {
        ApplicationManager.getApplication().invokeLater {
            val uri = targetUri ?: return@invokeLater
            val virtualFile = findVirtualFileByUri(uri) ?: return@invokeLater

            val descriptor = OpenFileDescriptor(project, virtualFile, line, character)
            if (descriptor.canNavigate()) {
                descriptor.navigate(true)
            }
            LOG.info("Navigated editor to $uri at L${line + 1}:C${character + 1}")
        }
    }

    private fun findVirtualFileByUri(uri: String): VirtualFile? {
        val vfm = VirtualFileManager.getInstance()
        var vf = vfm.findFileByUrl(uri)
        if (vf == null) {
            val path = uri.removePrefix("file://")
            vf = LocalFileSystem.getInstance().findFileByPath(path)
        }
        if (vf == null && project.basePath != null) {
            val relPath = uri.removePrefix("file://").removePrefix(project.basePath!!)
            vf = LocalFileSystem.getInstance().findFileByPath("${project.basePath}/$relPath")
        }
        return vf
    }

    override fun dispose() {
        alarm.cancelAllRequests()
    }
}
