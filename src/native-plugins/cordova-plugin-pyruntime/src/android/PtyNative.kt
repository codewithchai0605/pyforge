package com.pyforge.pyruntime

/**
 * The pseudo-terminal helper (src/android/cpp/pty_core.c + pty_jni.c, built
 * into libpyforge_pty.so by CMake; see pyruntime.gradle). Thin: every call is
 * one libc operation, and the shell-session logic lives in TerminalPlugin.
 *
 * `fd` is the master side of the pty: reading it gives the shell's output,
 * writing it is typing. `pid` is the shell, which leads its own session and
 * process group (so `signal` reaches whatever job is running in it).
 *
 * Methods return 0 / a count on success and -errno on failure, never throw.
 */
object PtyNative {
    init {
        System.loadLibrary("pyforge_pty")
    }

    /** Starts `file` on a new pty. On success returns 0 and fills out[0] = fd, out[1] = pid. */
    @JvmStatic
    external fun spawn(
        file: String,
        argv: Array<String>,
        env: Array<String>,
        cwd: String?,
        rows: Int,
        cols: Int,
        out: IntArray,
    ): Int

    /** Blocks until output is available. Returns the byte count (> 0), 0 once the shell has gone, or -errno. */
    @JvmStatic
    external fun read(fd: Int, buf: ByteArray, len: Int): Int

    /** Writes buf[off, off + len). 0 or -errno. */
    @JvmStatic
    external fun write(fd: Int, buf: ByteArray, off: Int, len: Int): Int

    /** Tells the terminal its new size; the foreground program gets SIGWINCH. */
    @JvmStatic
    external fun resize(fd: Int, rows: Int, cols: Int): Int

    /** Blocks until the shell ends: its exit status, or 128 + the signal that killed it. */
    @JvmStatic
    external fun waitFor(pid: Int): Int

    /** Sends `sig` to the shell's whole process group. */
    @JvmStatic
    external fun signal(pid: Int, sig: Int): Int

    @JvmStatic
    external fun close(fd: Int)
}