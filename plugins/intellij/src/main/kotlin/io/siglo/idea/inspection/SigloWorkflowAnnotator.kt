package io.siglo.idea.inspection

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile
import io.siglo.idea.process.Diagnostic
import io.siglo.idea.process.SigloAnalyzerService
import io.siglo.idea.process.SourceRange
import java.util.concurrent.TimeUnit

class SigloWorkflowAnnotator : ExternalAnnotator<SigloWorkflowAnnotator.InitialInfo, SigloWorkflowAnnotator.AnnotationResult>() {
    private val LOG = Logger.getInstance(SigloWorkflowAnnotator::class.java)

    data class InitialInfo(
        val project: Project,
        val uri: String,
        val version: Int,
        val content: String,
        val document: Document
    )

    data class AnnotationResult(
        val document: Document,
        val diagnostics: List<Diagnostic>
    )

    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): InitialInfo? {
        val virtualFile = file.virtualFile ?: return null
        val ext = virtualFile.extension?.lowercase() ?: return null
        if (ext !in SUPPORTED_EXTENSIONS) return null

        val text = file.text
        if (!containsWorkflowKeywords(text)) return null

        val uri = if (virtualFile.url.startsWith("file://")) virtualFile.url else "file://${virtualFile.path}"
        val doc = editor.document
        return InitialInfo(file.project, uri, doc.modificationStamp.toInt(), text, doc)
    }

    override fun doAnnotate(info: InitialInfo): AnnotationResult? {
        return try {
            val service = SigloAnalyzerService.getInstance(info.project)
            val future = service.getGraph(info.uri, info.version, info.content)
            val graph = future.get(1500, TimeUnit.MILLISECONDS) ?: return null
            val allDiags = (graph.diagnostics + graph.workflows.flatMap { it.diagnostics }).distinctBy {
                "${it.code}:${it.range.start.line}:${it.range.start.character}:${it.range.end.line}:${it.range.end.character}:${it.message}"
            }
            AnnotationResult(info.document, allDiags)
        } catch (e: Exception) {
            LOG.debug("Siglo annotator background analysis timed out or failed: ${e.message}")
            null
        }
    }

    override fun apply(file: PsiFile, annotationResult: AnnotationResult, holder: AnnotationHolder) {
        val document = annotationResult.document
        for (diag in annotationResult.diagnostics) {
            val textRange = diag.range.toTextRange(document) ?: continue
            val severity = if (diag.severity == "error") HighlightSeverity.ERROR else HighlightSeverity.WARNING
            holder.newAnnotation(severity, "Siglo: ${diag.message}")
                .range(textRange)
                .create()
        }
    }

    companion object {
        val SUPPORTED_EXTENSIONS = setOf("ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs")

        fun containsWorkflowKeywords(text: String): Boolean {
            return text.contains("flow") || text.contains("pipe") ||
                   text.contains("workflow") || text.contains("Step") ||
                   text.contains("httpStep") || text.contains("aiStep") ||
                   text.contains("waitForEvent") || text.contains("wait")
        }

        fun SourceRange.toTextRange(document: Document): TextRange? {
            if (start.line < 0 || start.line >= document.lineCount) return null
            if (end.line < 0 || end.line >= document.lineCount) return null
            val startLineOffset = document.getLineStartOffset(start.line)
            val startOffset = (startLineOffset + start.character).coerceIn(0, document.textLength)
            val endLineOffset = document.getLineStartOffset(end.line)
            val endOffset = (endLineOffset + end.character).coerceIn(startOffset, document.textLength)
            if (startOffset >= endOffset) {
                val safeEnd = minOf(startOffset + 1, document.textLength)
                return TextRange(startOffset, safeEnd)
            }
            return TextRange(startOffset, endOffset)
        }
    }
}
