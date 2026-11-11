package io.siglo.idea.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.wm.ToolWindowManager
import io.siglo.idea.toolwindow.SigloToolWindowPanel

class ImportTelemetryAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Siglo Workflows") ?: return
        toolWindow.activate {
            val content = toolWindow.contentManager.selectedContent
            val panel = content?.component as? SigloToolWindowPanel
            panel?.importTelemetry()
        }
    }
}
