package io.siglo.idea.toolwindow

import com.intellij.ui.jcef.JBCefBrowser
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.browser.CefMessageRouter
import org.cef.callback.CefQueryCallback
import org.cef.handler.CefMessageRouterHandlerAdapter
import java.awt.Component

class JcefBrowserView(
    htmlContent: String,
    private val onMessage: (String) -> Unit
) {
    private val browser = JBCefBrowser()

    val component: Component
        get() = browser.component

    init {
        val router = CefMessageRouter.create()
        router.addHandler(object : CefMessageRouterHandlerAdapter() {
            override fun onQuery(
                cefBrowser: CefBrowser,
                frame: CefFrame,
                queryId: Long,
                request: String,
                persistent: Boolean,
                callback: CefQueryCallback
            ): Boolean {
                onMessage(request)
                callback.success("{\"status\":\"ok\"}")
                return true
            }
        }, true)

        browser.jbCefClient.cefClient.addMessageRouter(router)
        browser.loadHTML(htmlContent)
    }

    fun executeJavaScript(script: String) {
        val url = browser.cefBrowser.url ?: ""
        browser.cefBrowser.executeJavaScript(script, url, 0)
    }
}
