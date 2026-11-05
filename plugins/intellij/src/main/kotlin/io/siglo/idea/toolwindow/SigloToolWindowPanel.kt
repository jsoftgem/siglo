package io.siglo.idea.toolwindow

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
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
                LOG.info("Siglo JCEF browser initialized successfully.")
            }
        } catch (t: Throwable) {
            LOG.warn("Failed to initialize JCEF view, falling back to Swing tree: ${t.message}")
        }

        if (!initializedJcef) {
            LOG.info("Using native Swing fallback JBTree view.")
            setupSwingFallbackView()
        }

        setupEditorTracking()
    }

    private fun setupEditorTracking() {
        val busConnection = project.messageBus.connect(this)

        // 1. Listen for active file switching / tab changes
        busConnection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) {
                alarm.cancelAllRequests()
                graphRequestCounter.incrementAndGet()
                val newFile = event.newFile
                if (newFile != null && isSupportedFile(newFile)) {
                    refreshForFile(newFile)
                }
            }

            override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
                if (activeVirtualFile == null && isSupportedFile(file)) {
                    refreshForFile(file)
                }
            }
        })

        // 2. Listen for document buffer edits (live typing & modifications)
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (!isAutoReloadEnabled) return

                val virtualFile = FileDocumentManager.getInstance().getFile(event.document) ?: return
                if (!isSupportedFile(virtualFile)) return
                if (FileEditorManager.getInstance(project).selectedFiles.firstOrNull() != virtualFile) return

                val docText = event.document.text

                // Debounce rapid typing edits by 250ms
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
            val appClass = Class.forName("com.intellij.ui.jcef.JBCefApp")
            val isSupportedMethod = appClass.getMethod("isSupported")
            (isSupportedMethod.invoke(null) as? Boolean) == true
        } catch (_: Throwable) {
            false
        }
    }

    private fun setupSwingFallbackView() {
        val rootNode = DefaultMutableTreeNode("Siglo Workflows")
        val tree = Tree(DefaultTreeModel(rootNode))
        this.fallbackTree = tree

        tree.addTreeSelectionListener { event ->
            val selected = tree.lastSelectedPathComponent as? DefaultMutableTreeNode
            val userObj = selected?.userObject
            if (userObj is GraphNode) {
                navigateToNodeInEditor(userObj)
            }
        }

        val scrollPane = JBScrollPane(tree)
        val banner = JPanel(BorderLayout())
        banner.add(
            JBLabel("Note: Full graphical workflow visualization requires JCEF runtime. Showing AST tree fallback."),
            BorderLayout.NORTH
        )
        banner.add(scrollPane, BorderLayout.CENTER)
        add(banner, BorderLayout.CENTER)
    }

    private fun loadUiBundleHtml(): String {
        // Read from plugin JAR resources first
        val resourceStream = SigloToolWindowPanel::class.java.getResourceAsStream("/ide-ui/index.html")
        if (resourceStream != null) {
            return resourceStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        }

        // Try reading from monorepo packages/ide-ui/dist/index.html
        val basePath = project.basePath
        if (basePath != null) {
            val distFile = File(basePath, "packages/ide-ui/dist/index.html")
            if (distFile.exists()) {
                return distFile.readText()
            }
        }

        return """
            <!DOCTYPE html>
            <html>
            <body style="background:#1e1f22;color:#dfe1e5;font-family:sans-serif;padding:20px;">
                <h3>Siglo Workflows</h3>
                <p>Connecting to static analyzer...</p>
            </body>
            </html>
        """.trimIndent()
    }

    fun renderDocument(doc: GraphDocument) {
        this.currentDocument = doc
        if (jcefBrowserView != null) {
            val json = gson.toJson(mapOf("type" to "setGraph", "document" to doc))
            val script = "if (window.__SIGLO_BRIDGE__) { window.__SIGLO_BRIDGE__.dispatch($json); }"
            jcefBrowserView?.executeJavaScript(script)
        } else if (fallbackTree != null) {
            updateFallbackTree(doc)
        }
    }

    private fun updateFallbackTree(doc: GraphDocument) {
        val rootNode = DefaultMutableTreeNode(
            if (doc.nodes.isEmpty() && doc.unresolved.isEmpty() && doc.workflows.isEmpty())
                "No Siglo Workflows in current file"
            else if (doc.workflows.size > 1)
                "Siglo Workflows (${doc.workflows.size} flows)"
            else
                "${doc.workflowName} (${doc.nodes.size} steps)"
        )

        if (doc.workflows.size > 1) {
            for (w in doc.workflows) {
                val flowNode = DefaultMutableTreeNode("${w.name} (${w.nodes.size} steps)")
                for (node in w.nodes) {
                    flowNode.add(DefaultMutableTreeNode(node))
                }
                for (un in w.unresolved) {
                    flowNode.add(DefaultMutableTreeNode("[Unresolved] ${un.expressionSnippet}"))
                }
                rootNode.add(flowNode)
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
                "nodeSelected" -> {
                    val nodeId = json.get("nodeId")?.asString
                    val node = currentDocument?.nodes?.find { it.id == nodeId }
                        ?: currentDocument?.workflows?.flatMap { it.nodes }?.find { it.id == nodeId }
                    if (node != null) {
                        navigateToNodeInEditor(node)
                    } else if (json.has("location")) {
                        val locObj = json.getAsJsonObject("location")
                        val start = locObj.getAsJsonObject("start")
                        val line = start.get("line")?.asInt ?: 0
                        val char = start.get("character")?.asInt ?: 0
                        navigateToLocation(line, char)
                    }
                }
            }
        } catch (e: Exception) {
            LOG.warn("Error processing webview query: $request", e)
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
        navigateToLocation(node.location.start.line, node.location.start.character)
    }

    private fun navigateToLocation(line: Int, character: Int) {
        ApplicationManager.getApplication().invokeLater {
            val uri = currentDocument?.uri ?: return@invokeLater
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
