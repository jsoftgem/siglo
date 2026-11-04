package io.siglo.idea.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.wm.ToolWindowManager
import io.siglo.idea.process.SigloAnalyzerService
import io.siglo.idea.toolwindow.SigloToolWindowPanel

class OpenWorkflowGraphAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }

    override fun update(e: AnActionEvent) {
        val virtualFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val isTsFile = virtualFile?.name?.endsWith(".ts") == true ||
                virtualFile?.name?.endsWith(".tsx") == true
        e.presentation.isEnabledAndVisible = isTsFile
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val virtualFile = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val uri = virtualFile.url

        val analyzerService = SigloAnalyzerService.getInstance(project)
        analyzerService.getGraph(uri).thenAccept { doc ->
            ApplicationManager.getApplication().invokeLater {
                val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Siglo Workflows")
                toolWindow?.activate {
                    val content = toolWindow.contentManager.selectedContent
                    val panel = content?.component as? SigloToolWindowPanel
                    panel?.renderDocument(doc)
                }
            }
        }
    }
}
