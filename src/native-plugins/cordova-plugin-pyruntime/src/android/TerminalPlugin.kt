package com.pyforge.pyruntime

import android.content.Context
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.apache.cordova.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Real shells for the Terminal page (src/native/terminal.ts).
 *
 * Each session is a program (the Android shell, /sysntem/bin/sh) running on a
 * pseudo-terminal made by PtyNative. So it behaves like a terminal, not like
 * a pipe: line editing and history, Ctrl+C reaches the running command,
 * full-screen programs get the window size, `isatty()` is true.
 *
 * Actions (all take JSON-friendly args):
 *   open(optionsJson)          -> a keep-alive stream, one `exec`, many results:
 *                                   "{"t":"open","id":"t1"}"   as a string, first
 *                                   <bytes>                    output, as ArrayBuffers
 *                                   "{"t":"exit","code":0}"    as a string, last
 *                                 optionsJson: {cols, rows, cwd?, shell?}
 *   write(id, text)            keystrokes / pasted text
 *   resize(id, cols, rows)
 *   close(id)                  hang up the shell (SIGHUP, SIGKILL if it ignores that)
 *
 * Output is sent as raw bytes rather than text so xterm.js can decode UTF-8
 * itself: a character split across two reads is then not corrupted.
 *
 * Threads: one reader thread per session (blocked in read(2)), and one single-
 * threaded executor per session for everything that touches the fd (writes,
 * resizes, the final close). Funnelling the fd through one thread means a
 * late write can never land on a recycled file descriptor number.
 *
 * Not done here: sessions end with the app process (Android may stop it
 * while it is in the background; a foreground service would be needed to keep
 * a long job alive), and the shell is Android's own (toybox + mksh): there is
 * no Python on its PATH. See DEVELOPMENT.md ("Terminal").
 */
class TerminalPlugin : CordovaPlugin() {

    private class Session(val id: String) {
        @Volatile var fd = -1
        @Volatile var pid = -1
        @Volatile var closed = false
        private val io: ExecutorService =
            Executors.newSingleThreadExecutor { r -> Thread(r, "pty-io-$id").apply { isDaemon = true } }

        /** Queues work on the thread that owns the fd. Ignored once the session has ended. */
        fun post(block: () -> Unit) {
            try {
                io.execute(block)
            } catch (_: RejectedExecutionException) {
                // The shell ended between the caller's lookup and now.
            }
        }

        fun shutdown() = io.shutdown()
    }

    private val sessions = ConcurrentHashMap<String, Session>()
    private val nextId = AtomicInteger(1)
    private val reaper = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "pty-reaper").apply { isDaemon = true }
    }

    private val context: Context get() = cordova.activity.applicationContext

    override fun execute(action: String, args: JSONArray, callbackContext: CallbackContext): Boolean {
        when (action) {
            "open" -> open(args.getString(0), callbackContext)
            "write" -> withSession(args.getString(0), callbackContext) { s ->
                val bytes = args.getString(1).toByteArray(Charsets.UTF_8)
                s.post {
                    if (!s.closed && s.fd >= 0) PtyNative.write(s.fd, bytes, 0, bytes.size)
                }
            }
            "resize" -> withSession(args.getString(0), callbackContext) { s ->
                val cols = args.getInt(1)
                val rows = args.getInt(2)
                s.post {
                    if (!s.closed && s.fd >= 0) PtyNative.resize(s.fd, rows, cols)
                }
            }
            "close" -> withSession(args.getString(0), callbackContext) { s -> hangUp(s) }
            else -> return false
        }
        return true
    }

    /** Runs `block` for a live session and acknowledges; an unknown id is not an error (it may have just ended). */
    private fun withSession(id: String, cb: CallbackContext, block: (Session) -> Unit) {
        val s = sessions[id]
        if (s != null) block(s)
        cb.success()
    }

    // ------------------------------------------------------------------ open

    private fun open(optionsJson: String, cb: CallbackContext) {
        val id = "t${nextId.getAndIncrement()}"
        val session = Session(id)
        sessions[id] = session

        // Spawning forks the process and the first read blocks: not on the Cordova thread.
        Thread({ startAndPump(session, optionsJson, cb) }, "pty-read-$id").apply { isDaemon = true }.start()
    }

    private fun startAndPump(s: Session, optionsJson: String, cb: CallbackContext) {
        try {
            val options = JSONObject(optionsJson)
            val cols = options.optInt("cols", 80).coerceIn(2, 1000)
            val rows = options.optInt("rows", 24).coerceIn(1, 1000)
            val shell = options.optString("shell", "").ifEmpty { DEFAULT_SHELL }
            val dirs = Dirs.of(context)
            val requested = options.optString("cwd", "")
            val cwd = if (requested.isNotEmpty() && File(requested).isDirectory) requested else dirs.projects

            val out = IntArray(2)
            val rc = PtyNative.spawn(shell, arrayOf(File(shell).name, "-i"), environment(dirs), cwd, rows, cols, out)
            if (rc != 0) {
                sessions.remove(s.id)
                s.shutdown()
                cb.error("could not start $shell (error ${-rc})")
                return
            }
            s.fd = out[0]
            s.pid = out[1]
            send(cb, JSONObject().put("t", "open").put("id", s.id).toString(), keep = true)
            pump(s, cb)
        } catch (t: Throwable) {
            // Typically UnsatisfiedLinkError: libpyforge_pty.so is not in this build.
            sessions.remove(s.id)
            s.shutdown()
            cb.error("terminal unavailable: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /** Forwards the shell's output until it ends, then reports the exit status. */
    private fun pump(s: Session, cb: CallbackContext) {
        val buf = ByteArray(READ_CHUNK)
        while (true) {
            val n = PtyNative.read(s.fd, buf, buf.size)
            if (n <= 0) break
            val result = PluginResult(PluginResult.Status.OK, buf.copyOf(n))
            result.keepCallback = true
            cb.sendPluginResult(result)
        }
        val code = PtyNative.waitFor(s.pid)
        s.closed = true
        sessions.remove(s.id)
        // The fd is closed on the io thread, after any write already queued.
        s.post { PtyNative.close(s.fd) }
        s.shutdown()
        send(cb, JSONObject().put("t", "exit").put("code", code).toString(), keep = false)
    }

    private fun send(cb: CallbackContext, text: String, keep: Boolean) {
        val result = PluginResult(PluginResult.Status.OK, text)
        result.keepCallback = keep
        cb.sendPluginResult(result)
    }

    // ------------------------------------------------------------- closing

    /** SIGHUP, like closing a terminal window; SIGKILL a moment later if the shell ignored it. */
    private fun hangUp(s: Session) {
        if (s.closed || s.pid < 0) return
        val pid = s.pid
        PtyNative.signal(pid, SIGHUP)
        reaper.schedule({ if (!s.closed) PtyNative.signal(pid, SIGKILL) }, KILL_AFTER_MS, TimeUnit.MILLISECONDS)
    }

    private fun closeAll() {
        for (s in sessions.values) hangUp(s)
    }

    /** The WebView was reloaded: its sessions have no one to talk to. */
    override fun onReset() {
        closeAll()
    }

    override fun onDestroy() {
        closeAll()
        super.onDestroy()
    }

    // --------------------------------------------------------- environment

    private class Dirs(val home: String, val projects: String, val tmp: String) {
        companion object {
            /** The same folders PyRuntimePlugin uses, so the shell starts where the editor's files are. */
            fun of(context: Context): Dirs {
                val files = context.filesDir
                val d = Dirs(
                    home = File(files, "pyforge").absolutePath,
                    projects = File(files, "projects").absolutePath,
                    tmp = File(context.cacheDir, "pyforge").absolutePath,
                )
                for (p in listOf(d.home, d.projects, d.tmp)) File(p).mkdirs()
                return d
            }
        }
    }

    /**
     * What the shell is told about its surroundings. Deliberately small and
     * explicit rather than the app's whole environment: nothing of the app's
     * own settings leaks into a user's shell, and the Android system
     * variables that tools like `ls` and `date` need are passed through.
     */
    private fun environment(dirs: Dirs): Array<String> {
        val env = linkedMapOf(
            "HOME" to dirs.home,
            "TMPDIR" to dirs.tmp,
            "PYFORGE_PROJECTS" to dirs.projects,
            "TERM" to "xterm-256color",
            "COLORTERM" to "truecolor",
            "LANG" to "en_US.UTF-8",
            "SHELL" to DEFAULT_SHELL,
            "PATH" to "/system/bin:/system/xbin:/vendor/bin",
        )
        for (name in PASS_THROUGH) System.getenv(name)?.let { env[name] = it }
        return env.map { (k, v) -> "$k=$v" }.toTypedArray()
    }

    companion object {
        private const val DEFAULT_SHELL = "/system/bin/sh"
        private const val READ_CHUNK = 16 * 1024
        private const val KILL_AFTER_MS = 1500L
        private const val SIGHUP = 1
        private const val SIGKILL = 9

        private val PASS_THROUGH = listOf(
            "ANDROID_ROOT", "ANDROID_DATA", "ANDROID_STORAGE", "ANDROID_ART_ROOT",
            "ANDROID_I18N_ROOT", "ANDROID_TZDATA_ROOT", "EXTERNAL_STORAGE",
        )
    }
}