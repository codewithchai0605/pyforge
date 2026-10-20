package com.pyforge.pyruntime

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.os.RemoteException
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

/**
 * Runs the user's Python in its own OS process (`android:process=":pythonN"`).
 *
 * Why a separate process instead of a thread in the app:
 *  - "Stop" can be a hard kill. A thread running `while True: pass` or a long
 *    C call (numpy, sleep) cannot be interrupted safely from inside Python.
 *  - A segfault in a native library kills only this process; the editor, the
 *    open tabs and unsaved text survive.
 *  - Every run starts with a pristine interpreter (no leftover modules,
 *    threads, turtle windows or monkey-patches from the previous script),
 *    which is what people expect from "Run".
 *
 * Protocol (Messenger/Binder): the app sends MSG_RUN / MSG_STDIN / MSG_GUI /
 * MSG_STOP; this service replies with MSG_EVENT messages whose "json" extra is
 * one event line produced by pyforge.core (see python/pyforge/core.py).
 *
 * `onDestroy` kills the process on purpose: the interpreter is single-use, so
 * the next run must get a brand-new process. Two subclasses (:python0 and
 * :python1) exist so consecutive runs alternate between processes, which
 * avoids racing a still-dying process when "Run" is tapped right after "Stop".
 */
open class PythonRunnerService : Service() {

    companion object {
        const val MSG_RUN = 1
        const val MSG_STDIN = 2
        const val MSG_GUI = 3
        const val MSG_STOP = 4
        const val MSG_EVENT = 100

        const val KEY_JSON = "json"
        const val KEY_TEXT = "text"
        const val KEY_EOF = "eof"
        const val KEY_HOME = "home"
        const val KEY_SITE = "site"
        const val KEY_PROJECTS = "projects"
        const val KEY_CACHE = "cache"
        const val KEY_ABI = "abi"
        const val KEY_API = "api"
    }

    private var client: Messenger? = null
    private var api: PyObject? = null

    private val handler = object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            when (msg.what) {
                MSG_RUN -> startRun(msg)
                MSG_STDIN -> {
                    val data = msg.data
                    val text: Any? = if (data.getBoolean(KEY_EOF, false)) null else data.getString(KEY_TEXT, "")
                    api?.callAttr("feed_stdin", text)
                }
                MSG_GUI -> api?.callAttr("feed_gui", msg.data.getString(KEY_JSON, "{}"))
                MSG_STOP -> Process.killProcess(Process.myPid())
                else -> super.handleMessage(msg)
            }
        }
    }

    private val messenger = Messenger(handler)

    override fun onBind(intent: Intent?): IBinder? = messenger.binder

    override fun onDestroy() {
        super.onDestroy()
        Process.killProcess(Process.myPid())
    }

    private fun startRun(msg: Message) {
        client = msg.replyTo
        val data: Bundle = msg.data
        try {
            if (!Python.isStarted()) {
                Python.start(AndroidPlatform(this))
            }
            val module = Python.getInstance().getModule("pyforge.api")
            module.callAttr(
                "configure",
                data.getString(KEY_HOME, ""),
                data.getString(KEY_SITE, ""),
                data.getString(KEY_PROJECTS, ""),
                data.getString(KEY_CACHE, ""),
                data.getString(KEY_ABI, ""),
                data.getString(KEY_API, ""),
            )
            api = module
            // start_run returns immediately; the script runs on a Python thread
            // and reports through the sink for as long as it lives.
            module.callAttr("start_run", PySink { line -> send(line) }, data.getString(KEY_JSON, "{}"))
        } catch (e: Throwable) {
            // Startup failures (bad install, missing ABI) should be visible in
            // the console, not just in logcat.
            send(jsonErr("Could not start Python: ${e.message ?: e.javaClass.simpleName}"))
            send("{\"t\":\"exit\",\"code\":-1,\"ms\":0}")
        }
    }

    private fun send(line: String) {
        val target = client ?: return
        val reply = Message.obtain(null, MSG_EVENT)
        reply.data = Bundle().apply { putString(KEY_JSON, line) }
        try {
            target.send(reply)
        } catch (_: RemoteException) {
            // The app side went away (or the payload exceeded Binder's ~1 MB
            // limit). Nothing useful to do from here.
        }
    }

    private fun jsonErr(text: String): String {
        val escaped = text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
        return "{\"t\":\"err\",\"s\":\"$escaped\\n\"}"
    }
}

/** Distinct processes for alternating runs; see the class comment above. */
class PythonRunnerService0 : PythonRunnerService()

class PythonRunnerService1 : PythonRunnerService()
