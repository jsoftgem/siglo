package io.siglo.idea.process

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.util.concurrent.TimeUnit

object NodeDiscoveryService {
    private val LOG = Logger.getInstance(NodeDiscoveryService::class.java)

    fun findNodeExecutable(): String? {
        // 1. Probe PATH environment
        val pathDirs = System.getenv("PATH")?.split(File.pathSeparator) ?: emptyList()
        val nodeBinaryName = if (SystemInfo.isWindows) "node.exe" else "node"

        for (dir in pathDirs) {
            val candidate = File(dir, nodeBinaryName)
            if (candidate.canExecute()) {
                val path = candidate.absolutePath
                if (validateNodeVersion(path)) {
                    LOG.info("Found valid Node.js via PATH at: $path")
                    return path
                }
            }
        }

        // 2. Platform well-known locations
        val wellKnownPaths = if (SystemInfo.isWindows) {
            listOf(
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Program Files (x86)\\nodejs\\node.exe"
            )
        } else {
            listOf(
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node"
            )
        }

        for (path in wellKnownPaths) {
            val file = File(path)
            if (file.canExecute() && validateNodeVersion(path)) {
                LOG.info("Found valid Node.js in well-known path at: $path")
                return path
            }
        }

        // 3. User home version managers: ~/.nvm, ~/.volta, ~/.asdf, ~/.fnm
        val userHome = System.getProperty("user.home")
        if (userHome != null) {
            val versionManagerPaths = listOf(
                "$userHome/.nvm/current/bin/node",
                "$userHome/.volta/bin/node",
                "$userHome/.asdf/shims/node",
                "$userHome/.fnm/current/bin/node"
            )
            for (path in versionManagerPaths) {
                val file = File(path)
                if (file.canExecute() && validateNodeVersion(path)) {
                    LOG.info("Found valid Node.js via version manager at: $path")
                    return path
                }
            }
        }

        LOG.warn("No compatible Node.js executable (>= 18.0.0) could be discovered.")
        return null
    }

    private fun validateNodeVersion(nodePath: String): Boolean {
        return try {
            val process = ProcessBuilder(nodePath, "--version")
                .redirectErrorStream(true)
                .start()
            val finished = process.waitFor(2, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                return false
            }
            if (process.exitValue() != 0) return false

            val output = process.inputStream.bufferedReader().readText().trim()
            // Format is typically v20.11.0 or v18.19.0
            val versionStr = output.removePrefix("v")
            val major = versionStr.split(".").firstOrNull()?.toIntOrNull() ?: 0
            major >= 18
        } catch (e: Exception) {
            LOG.debug("Failed to query Node.js version from $nodePath: ${e.message}")
            false
        }
    }
}
