package com.pyforge.pyruntime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Handler
import android.os.Messenger
import android.os.Process
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.apache.cordova.CallbackContext
import org.apache.cordova.CordovaPlugin
import org.apache.cordova.PluginResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The bridge between the WebView (src/native/pyruntime.ts) and Python.
 *
 * Two completely separate jobs live here:
 *
 *  1. **Running user code** - delegated to PythonRunnerService, a service in
 *     its own process (see that class for why). This class binds to it, relays
 *     stdin / GUI events in, and relays the JSON event lines it sends back out
 *     to the WebView through a *keep-alive* Cordova callback (one `exec`, many
 *     results).
 *
 *  2. **The package manager** - runs inside this (UI) process on a worker
 *     thread. It only downloads and unzips files, never imports what it
 *     installs, so there is nothing to isolate or kill.
 *
 * Actions (all take JSON-friendly args; see src/native/pyruntime.ts):
 *   init()                      -> runtime info JSON
 *   run(requestJson)            -> stream of event lines; the last is {"t":"exit"}
 *   stdin(text | null)          -> null means EOF (Ctrl-D)
 *   gui(eventJson)
 *   stop()
 *   pip(call, argsJson)         -> stream of progress lines, then {"t":"result",...}
 */
class PyRuntimePlugin : CordovaPlugin() {

    private val pythonReady = CountDownLatch(1)
    @Volatile private var pythonError: Throwable? = null
    private val pipLock = Any()

    /** State of the single run that may be active at a time. */
    private inner class Run(val callback: CallbackContext, val serviceClass: Class<out PythonRunnerService>) {
        @Volatile var finished = false
        @Volatile var service: Messenger? = null
        var connection: ServiceConnection? = null
        val queued = ArrayList<Message>()
    }

    @Volatile private var active: Run? = null
    private var nextService = 0

    private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what == PythonRunnerService.MSG_EVENT) {
                val line = msg.data.getString(PythonRunnerService.KEY_JSON) ?: return
                onEvent(line)
            }
        }
    })

    private val context: Context get() = cordova.activity.applicationContext

    // ------------------------------------------------------------------ setup

    override fun pluginInitialize() {
        disableWebViewZoom()
        // Start (and, on first launch, unpack) Python off the UI thread so app
        // start-up isn't delayed. Everything that needs Python waits on the latch.
        cordova.threadPool.execute {
            try {
                if (!Python.isStarted()) {
                    Python.start(AndroidPlatform(context))
                }
                val api = Python.getInstance().getModule("pyforge.api")
                val d = dirs()
                api.callAttr("configure", d.home, d.site, d.projects, d.cache, abi(), Build.VERSION.SDK_INT.toString())
            } catch (t: Throwable) {
                pythonError = t
            } finally {
                pythonReady.countDown()
            }
        }
    }

    override fun onDestroy() {
        killRun()
        super.onDestroy()
    }

    /**
     * Pinch/double-tap page zoom would scale the whole UI and break the layout.
     * The viewport meta tag already says "no zoom", but WebView only honours it
     * in some configurations, so turn it off at the source too. (Pinch inside
     * the editor changes the *font size* instead; see src/editor/pinchZoom.ts.)
     */
    private fun disableWebViewZoom() {
        cordova.activity.runOnUiThread {
            (webView.view as? WebView)?.settings?.apply {
                setSupportZoom(false)
                setBuiltInZoomControls(false)
                setDisplayZoomControls(false)
            }
        }
    }

    /**
     * How much padding (CSS px) the page must add for the system bars.
     *
     * cordova-android 15 draws edge-to-edge but already insets the WebView by
     * the bars' size, so the page usually needs none. Reporting `env(safe-area-
     * inset-*)` on top of that doubled the gap at the top and bottom. This
     * measures the *remaining* overlap: the bar size minus how far the WebView
     * is already pushed in from that edge.
     */
    private fun measureInsets(cb: CallbackContext) {
        cordova.activity.runOnUiThread {
            try {
                val view = webView.view
                val loc = IntArray(2)
                view.getLocationOnScreen(loc)
                val bars = ViewCompat.getRootWindowInsets(view)
                    ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                val density = context.resources.displayMetrics.density
                val rootW = view.rootView.width
                val rootH = view.rootView.height
                fun css(px: Int): Double = Math.max(0, px) / density.toDouble()
                val out = JSONObject()
                out.put("top", css((bars?.top ?: 0) - loc[1]))
                out.put("bottom", css((bars?.bottom ?: 0) - (rootH - (loc[1] + view.height))))
                out.put("left", css((bars?.left ?: 0) - loc[0]))
                out.put("right", css((bars?.right ?: 0) - (rootW - (loc[0] + view.width))))
                cb.success(out)
            } catch (t: Throwable) {
                cb.error(t.message ?: t.javaClass.simpleName)
            }
        }
    }

    private class Dirs(val home: String, val site: String, val projects: String, val cache: String)

    private fun dirs(): Dirs {
        val files = context.filesDir
        val home = File(files, "pyforge")
        val d = Dirs(
            home = home.absolutePath,
            site = File(home, "site-packages").absolutePath,
            // Must match the folder src/main.ts opens as the workspace
            // (cordova.file.dataDirectory + "projects/").
            projects = File(files, "projects").absolutePath,
            cache = File(context.cacheDir, "pyforge").absolutePath,
        )
        for (p in listOf(d.home, d.site, d.projects, d.cache)) File(p).mkdirs()
        return d
    }

    /** The wheel-tag spelling of this process's ABI, e.g. "arm64_v8a". */
    private fun abi(): String {
        val abis = if (Process.is64Bit()) Build.SUPPORTED_64_BIT_ABIS else Build.SUPPORTED_32_BIT_ABIS
        return (abis.firstOrNull() ?: "arm64-v8a").replace('-', '_')
    }

    private fun awaitPython(): Boolean {
        if (!pythonReady.await(120, TimeUnit.SECONDS)) return false
        return pythonError == null
    }

    private fun startupError(cb: CallbackContext) {
        val t = pythonError
        cb.error("Python failed to start: ${t?.message ?: t?.javaClass?.simpleName ?: "timed out"}")
    }

    // --------------------------------------------------------------- dispatch

    override fun execute(action: String, args: JSONArray, callbackContext: CallbackContext): Boolean {
        when (action) {
            "init" -> cordova.threadPool.execute { init(callbackContext) }
            "run" -> startRun(args.getString(0), callbackContext)
            "stdin" -> {
                val text: String? = if (args.isNull(0)) null else args.getString(0)
                send(Message.obtain(null, PythonRunnerService.MSG_STDIN).apply {
                    data = Bundle().apply {
                        if (text == null) putBoolean(PythonRunnerService.KEY_EOF, true)
                        else putString(PythonRunnerService.KEY_TEXT, text)
                    }
                })
                callbackContext.success()
            }
            "gui" -> {
                send(Message.obtain(null, PythonRunnerService.MSG_GUI).apply {
                    data = Bundle().apply { putString(PythonRunnerService.KEY_JSON, args.getString(0)) }
                })
                callbackContext.success()
            }
            "stop" -> {
                killRun()
                callbackContext.success()
            }
            "insets" -> measureInsets(callbackContext)
            "pipCancel" -> {
                // Cooperative: Python checks the flag between network reads and
                // before it touches site-packages, so cancelling is always clean.
                if (Python.isStarted()) Python.getInstance().getModule("pyforge.api").callAttr("cancel_pip")
                callbackContext.success()
            }
            "pip" -> {
                val call = args.getString(0)
                val payload = args.optString(1, "{}")
                cordova.threadPool.execute { pip(call, payload, callbackContext) }
            }
            else -> return false
        }
        return true
    }

    private fun init(cb: CallbackContext) {
        if (!awaitPython()) return startupError(cb)
        try {
            val info = JSONObject(Python.getInstance().getModule("pyforge.api").callAttr("runtime_info").toString())
            val d = dirs()
            info.put("projects", d.projects)
            info.put("home", d.home)
            info.put("site", d.site)
            cb.success(info)
        } catch (t: Throwable) {
            cb.error(t.message ?: t.javaClass.simpleName)
        }
    }

    // ------------------------------------------------------------- run / stop

    private fun startRun(requestJson: String, cb: CallbackContext) {
        killRun() // one run at a time: starting a new one replaces the old

        // Register the run *now*, on the calling thread. Everything below that
        // can take a while (waiting for Python to finish starting, binding the
        // service) happens on a worker, and a Stop tapped in the meantime must
        // find this run and cancel it rather than be silently ignored.
        val serviceClass: Class<out PythonRunnerService> =
            if (nextService++ % 2 == 0) PythonRunnerService0::class.java else PythonRunnerService1::class.java
        val r = Run(cb, serviceClass)
        active = r

        // Result lines arrive later via onEvent(); keep this callback open.
        val pending = PluginResult(PluginResult.Status.NO_RESULT)
        pending.keepCallback = true
        cb.sendPluginResult(pending)

        cordova.threadPool.execute {
            if (!awaitPython()) {
                val t = pythonError
                finish(r, -1, "Python failed to start: ${t?.message ?: t?.javaClass?.simpleName ?: "timed out"}")
                return@execute
            }
            if (r.finished) return@execute // stopped while Python was starting

            val d = dirs()
            val runMessage = Message.obtain(null, PythonRunnerService.MSG_RUN).apply {
                replyTo = replies
                data = Bundle().apply {
                    putString(PythonRunnerService.KEY_JSON, requestJson)
                    putString(PythonRunnerService.KEY_HOME, d.home)
                    putString(PythonRunnerService.KEY_SITE, d.site)
                    putString(PythonRunnerService.KEY_PROJECTS, d.projects)
                    putString(PythonRunnerService.KEY_CACHE, d.cache)
                    putString(PythonRunnerService.KEY_ABI, abi())
                    putString(PythonRunnerService.KEY_API, Build.VERSION.SDK_INT.toString())
                }
            }

            val connection = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                    val messenger = Messenger(binder)
                    synchronized(r) {
                        if (r.finished) {
                            // Stopped between bindService() and now: undo it.
                            teardown(r)
                            return
                        }
                        r.service = messenger
                        try {
                            messenger.send(runMessage)
                            // Anything the user typed before the process was up.
                            r.queued.forEach { messenger.send(it) }
                        } catch (t: Throwable) {
                            finish(r, -1, "Could not talk to the Python process: ${t.message}")
                        }
                        r.queued.clear()
                    }
                }

                override fun onServiceDisconnected(name: ComponentName) {
                    // The process died while a run was active: a crash in a
                    // native library, or the system reclaimed it. (A normal Stop
                    // marks the run finished first, so this stays silent.)
                    finish(r, -9, "The Python process stopped unexpectedly.")
                }
            }
            r.connection = connection

            val intent = Intent(context, serviceClass)
            if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
                finish(r, -1, "Could not start the Python process.")
            } else if (r.finished) {
                teardown(r) // Stop arrived while bindService() was in flight
            }
        }
    }

    /** One event line from the Python process. */
    private fun onEvent(line: String) {
        val r = active ?: return
        if (r.finished) return
        val isExit = line.startsWith("{\"t\":\"exit\"")
        emit(r, line, keep = !isExit)
        if (isExit) {
            r.finished = true
            teardown(r)
        }
    }

    private fun emit(r: Run, line: String, keep: Boolean) {
        val result = PluginResult(PluginResult.Status.OK, line)
        result.keepCallback = keep
        r.callback.sendPluginResult(result)
    }

    /** Ends a run from the Kotlin side, with a synthetic exit event. */
    private fun finish(r: Run, code: Int, message: String?) {
        if (r.finished) return
        r.finished = true
        if (message != null) {
            val s = JSONObject.quote(message + "\n")
            emit(r, "{\"t\":\"err\",\"s\":$s}", keep = true)
        }
        emit(r, "{\"t\":\"exit\",\"code\":$code,\"ms\":0}", keep = false)
        teardown(r)
    }

    private fun teardown(r: Run) {
        // Unbinding destroys the service, whose onDestroy kills its process.
        r.connection?.let {
            try {
                context.unbindService(it)
            } catch (_: IllegalArgumentException) {
                // already unbound
            }
        }
        r.connection = null
        r.service = null
        if (active === r) active = null
    }

    /** "Stop": hard-kill the Python process. Always safe, even mid-C-call. */
    private fun killRun() {
        val r = active ?: return
        if (r.finished) return
        try {
            r.service?.send(Message.obtain(null, PythonRunnerService.MSG_STOP))
        } catch (_: Throwable) {
            // service already gone; unbinding below finishes the job
        }
        finish(r, 137, null)
    }

    private fun send(message: Message) {
        val r = active ?: return
        if (r.finished) return
        synchronized(r) {
            val target = r.service
            if (target == null) r.queued.add(message) else {
                try {
                    target.send(message)
                } catch (_: Throwable) {
                    // process is going away; onServiceDisconnected reports it
                }
            }
        }
    }

    // ------------------------------------------------------- package manager

    private fun pip(call: String, argsJson: String, cb: CallbackContext) {
        if (!awaitPython()) return startupError(cb)
        synchronized(pipLock) { // one install/uninstall at a time
            try {
                val sink = PySink { line ->
                    val result = PluginResult(PluginResult.Status.OK, line)
                    result.keepCallback = true
                    cb.sendPluginResult(result)
                }
                val api = Python.getInstance().getModule("pyforge.api")
                val outcome = api.callAttr("pip_call", sink, call, argsJson).toString()
                // Final message, not kept: {"t":"result","payload":{"ok":..,"result"|"error":..}}
                cb.success("{\"t\":\"result\",\"payload\":$outcome}")
            } catch (t: Throwable) {
                cb.error(t.message ?: t.javaClass.simpleName)
            }
        }
    }
}
