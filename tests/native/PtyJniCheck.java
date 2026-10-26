package com.pyforge.pyruntime;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Loads the compiled pyforge_pty library into a real JVM and drives it
 * through the same static native methods PtyNative.kt declares, so the JNI
 * names, signatures and array/string marshalling are checked without an
 * Android device. Run by tests/python/test_pty_jni.py:
 *
 * java PtyJniCheck.java /path/to/libpyforge_pty.so
 */
public class PtyJniCheck {
    static int failures = 0;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok)
            failures++;
    }

    static String drain(int fd) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (;;) {
            int n = PtyNative.read(fd, buf, buf.length);
            if (n <= 0)
                break;
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    static int[] spawn(String cmd, String cwd, int rows, int cols) {
        int[] out = new int[2];
        int r = PtyNative.spawn("/bin/sh", new String[] { "sh", "-c", cmd },
                new String[] { "PATH=/usr/bin:/bin", "TERM=xterm-256color", "GREETING=h\u00e9llo" },
                cwd, rows, cols, out);
        if (r != 0)
            throw new RuntimeException("spawn failed: " + r);
        return out;
    }

    public static void main(String[] args) throws Exception {
        System.load(args[0]);

        // output, exit status, working directory, environment (incl. non-ASCII),
        // terminal size
        int[] p = spawn("echo out:$GREETING; pwd; stty size; exit 5", "/tmp", 30, 100);
        String text = drain(p[0]);
        int code = PtyNative.waitFor(p[1]);
        PtyNative.close(p[0]);
        check(text.contains("out:h\u00e9llo"), "environment reaches the shell (UTF-8 intact)");
        check(text.contains("/tmp"), "start directory is honoured");
        check(text.contains("30 100"), "initial window size is applied");
        check(code == 5, "exit status is reported (" + code + ")");

        // typing goes in, echo and output come back, resize reaches the program
        int[] q = spawn("read line; echo got:$line; sleep 0.4; stty size", null, 24, 80);
        byte[] typed = "typed-text\n".getBytes(StandardCharsets.UTF_8);
        check(PtyNative.write(q[0], typed, 0, typed.length) == 0, "write succeeds");
        PtyNative.resize(q[0], 17, 61);
        String qt = drain(q[0]);
        PtyNative.waitFor(q[1]);
        PtyNative.close(q[0]);
        check(qt.contains("got:typed-text"), "typed text reaches the program");
        check(qt.contains("17 61"), "resize reaches the program");

        // a partial write offset is respected
        int[] w = spawn("read a; echo [$a]", null, 24, 80);
        byte[] raw = "XXhiYY\n".getBytes(StandardCharsets.UTF_8);
        PtyNative.write(w[0], raw, 2, 3); // "hiY"
        byte[] nl = "\n".getBytes(StandardCharsets.UTF_8);
        PtyNative.write(w[0], nl, 0, 1);
        String wt = drain(w[0]);
        PtyNative.waitFor(w[1]);
        PtyNative.close(w[0]);
        check(wt.contains("[hiY]"), "write honours offset and length");

        // signals go to the whole process group, so a foreground job dies
        int[] s = spawn("sleep 30", null, 24, 80);
        PtyNative.signal(s[1], 15);
        int sc = PtyNative.waitFor(s[1]);
        PtyNative.close(s[0]);
        check(sc == 128 + 15, "SIGTERM ends the shell and its job (" + sc + ")");

        // a program that cannot start ends with 127 instead of hanging
        int[] bad = new int[2];
        int r = PtyNative.spawn("/no/such/shell", new String[] { "x" }, new String[0], null, 24, 80, bad);
        check(r == 0, "spawn itself succeeds (the failure is in the child)");
        String bt = drain(bad[0]);
        int bc = PtyNative.waitFor(bad[1]);
        PtyNative.close(bad[0]);
        check(bc == 127, "a missing program exits 127 (" + bc + ")");
        check(bt.contains("cannot start"), "and says so on the terminal");

        System.out.println(failures == 0 ? "ALL OK" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}

class PtyNative {
    static native int spawn(String file, String[] argv, String[] env, String cwd, int rows, int cols, int[] out);

    static native int read(int fd, byte[] buf, int len);

    static native int write(int fd, byte[] buf, int off, int len);

    static native int resize(int fd, int rows, int cols);

    static native int waitFor(int pid);

    static native int signal(int pid, int sig);

    static native void close(int fd);
}