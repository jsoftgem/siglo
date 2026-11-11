package io.siglo.idea

import com.intellij.openapi.editor.impl.DocumentImpl
import io.siglo.idea.inspection.SigloWorkflowAnnotator
import io.siglo.idea.inspection.SigloWorkflowAnnotator.Companion.toTextRange
import io.siglo.idea.inspection.SigloWorkflowInspection
import io.siglo.idea.process.Diagnostic
import io.siglo.idea.process.SourcePosition
import io.siglo.idea.process.SourceRange
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class SigloDiagnosticsTest {

    @Test
    fun testInspectionInstantiationAndProperties() {
        val inspection = SigloWorkflowInspection()
        assertEquals("SigloWorkflowInspection", inspection.shortName)
        assertEquals("Siglo workflow static diagnostics", inspection.displayName)
        assertEquals("Siglo", inspection.groupDisplayName)
        assertTrue(inspection.isEnabledByDefault)
    }

    @Test
    fun testAnnotatorInstantiation() {
        val annotator = SigloWorkflowAnnotator()
        assertNotNull(annotator)
    }

    @Test
    fun testKeywordFiltering() {
        assertTrue(SigloWorkflowAnnotator.containsWorkflowKeywords("const f = flow('order', stepA)"))
        assertTrue(SigloWorkflowAnnotator.containsWorkflowKeywords("const p = pipe(s1, s2)"))
        assertTrue(SigloWorkflowAnnotator.containsWorkflowKeywords("const s = Step.create('a', () => {})"))
        assertTrue(SigloWorkflowAnnotator.containsWorkflowKeywords("httpStep('callApi', {})"))
        assertTrue(SigloWorkflowAnnotator.containsWorkflowKeywords("waitForEvent('event.name')"))
        assertFalse(SigloWorkflowAnnotator.containsWorkflowKeywords("const x = 1 + 2; console.log(x);"))
    }

    @Test
    fun testSourceRangeToTextRangeMapping() {
        val text = "line 0\nline 1\nline 2 is here\nline 3\nline 4 with some more characters"
        val document = DocumentImpl(text)

        // Normal range
        val range = SourceRange(
            start = SourcePosition(line = 2, character = 5),
            end = SourcePosition(line = 4, character = 6)
        )
        val textRange = range.toTextRange(document)
        assertNotNull(textRange)
        val startExpected = document.getLineStartOffset(2) + 5
        val endExpected = document.getLineStartOffset(4) + 6
        assertEquals(startExpected, textRange!!.startOffset)
        assertEquals(endExpected, textRange.endOffset)

        // Point range (start == end) ensures minimum 1 character highlight
        val pointRange = SourceRange(
            start = SourcePosition(line = 0, character = 2),
            end = SourcePosition(line = 0, character = 2)
        )
        val pointTextRange = pointRange.toTextRange(document)
        assertNotNull(pointTextRange)
        assertEquals(2, pointTextRange!!.startOffset)
        assertEquals(3, pointTextRange.endOffset)

        // Out of bounds line returns null safely
        val oobRange = SourceRange(
            start = SourcePosition(line = 50, character = 0),
            end = SourcePosition(line = 51, character = 0)
        )
        assertNull(oobRange.toTextRange(document))
    }

    @Test
    fun testMilestone2DiagnosticCodeAndSeverityMappings() {
        val cycleDiag = Diagnostic(
            code = "SIGLO_STATIC_CYCLE",
            message = "Cyclic workflow dependency detected involving step \"stepA\"",
            severity = "warning",
            range = SourceRange(SourcePosition(1, 0), SourcePosition(1, 10))
        )
        assertEquals("SIGLO_STATIC_CYCLE", cycleDiag.code)
        assertEquals("warning", cycleDiag.severity)

        val compensationDiag = Diagnostic(
            code = "SIGLO_MISSING_COMPENSATION",
            message = "Saga step \"chargeCard\" performs side effects without a registered compensation step",
            severity = "warning",
            range = SourceRange(SourcePosition(5, 0), SourcePosition(5, 20)),
            fixAvailable = true
        )
        assertEquals("SIGLO_MISSING_COMPENSATION", compensationDiag.code)
        assertEquals(true, compensationDiag.fixAvailable)

        val errorBranchDiag = Diagnostic(
            code = "SIGLO_UNHANDLED_ERROR_BRANCH",
            message = "Durable workflow branch \"branch fork\" has unhandled error/default branch",
            severity = "warning",
            range = SourceRange(SourcePosition(8, 0), SourcePosition(8, 15))
        )
        assertEquals("SIGLO_UNHANDLED_ERROR_BRANCH", errorBranchDiag.code)

        val duplicateStepDiag = Diagnostic(
            code = "SIGLO_DUPLICATE_STEP_ID",
            message = "Duplicate step ID detected: \"stepA\"",
            severity = "error",
            range = SourceRange(SourcePosition(12, 0), SourcePosition(12, 10))
        )
        assertEquals("SIGLO_DUPLICATE_STEP_ID", duplicateStepDiag.code)
        assertEquals("error", duplicateStepDiag.severity)
    }
}
