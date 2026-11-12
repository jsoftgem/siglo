package io.siglo.idea.inspection

import com.intellij.codeInspection.InspectionManager
import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.LocalQuickFix
import com.intellij.codeInspection.ProblemDescriptor
import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.openapi.diagnostic.Logger
import com.intellij.psi.PsiFile
import io.siglo.idea.inspection.SigloWorkflowAnnotator.Companion.SUPPORTED_EXTENSIONS
import io.siglo.idea.inspection.SigloWorkflowAnnotator.Companion.containsWorkflowKeywords
import io.siglo.idea.inspection.SigloWorkflowAnnotator.Companion.toTextRange
import io.siglo.idea.process.SigloAnalyzerService
import java.util.concurrent.TimeUnit

class SigloWorkflowInspection : LocalInspectionTool() {
    private val LOG = Logger.getInstance(SigloWorkflowInspection::class.java)

    override fun getDisplayName(): String = "Siglo workflow static diagnostics"
    override fun getGroupDisplayName(): String = "Siglo"
    override fun getShortName(): String = "SigloWorkflowInspection"
    override fun isEnabledByDefault(): Boolean = true

    override fun checkFile(file: PsiFile, manager: InspectionManager, isOnTheFly: Boolean): Array<ProblemDescriptor>? {
        val virtualFile = file.virtualFile ?: return null
        val ext = virtualFile.extension?.lowercase() ?: return null
        if (ext !in SUPPORTED_EXTENSIONS) return null

        val text = file.text
        if (!containsWorkflowKeywords(text)) return null

        val document = file.viewProvider.document ?: return null
        val uri = if (virtualFile.url.startsWith("file://")) virtualFile.url else "file://${virtualFile.path}"

        val service = SigloAnalyzerService.getInstance(file.project)
        val future = service.getGraph(uri, file.modificationStamp.toInt(), text)
        val graph = try {
            future.get(1500, TimeUnit.MILLISECONDS) ?: return null
        } catch (e: Exception) {
            LOG.debug("Siglo inspection analysis timed out or failed: ${e.message}")
            return null
        }

        val allDiagnostics = (graph.diagnostics + graph.workflows.flatMap { it.diagnostics }).distinctBy {
            "${it.code}:${it.range.start.line}:${it.range.start.character}:${it.range.end.line}:${it.range.end.character}:${it.message}"
        }

        val descriptors = mutableListOf<ProblemDescriptor>()
        for (diag in allDiagnostics) {
            val textRange = diag.range.toTextRange(document) ?: continue
            val highlightType = if (diag.severity == "error") {
                ProblemHighlightType.GENERIC_ERROR_OR_WARNING
            } else {
                ProblemHighlightType.WARNING
            }
            val descriptor = manager.createProblemDescriptor(
                file,
                textRange,
                "Siglo: ${diag.message}",
                highlightType,
                isOnTheFly,
                *LocalQuickFix.EMPTY_ARRAY
            )
            descriptors.add(descriptor)
        }

        return descriptors.toTypedArray()
    }
}
