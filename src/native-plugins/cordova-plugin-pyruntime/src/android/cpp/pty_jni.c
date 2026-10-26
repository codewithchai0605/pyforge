/*
 * JNI wrapper: com.pyforge.pyruntime.PtyNative <-> pty_core.c.
 * Kept deliberately thin; the logic is in pty_core.c, which is tested on its own.
 */
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "pty_core.h"

/* A NULL-terminated copy of a Java String[]; free with free_cstrings. */
static char **to_cstrings(JNIEnv *env, jobjectArray arr) {
    jsize n = arr ? (*env)->GetArrayLength(env, arr) : 0;
    char **out = (char **)calloc((size_t)n + 1, sizeof(char *));
    if (!out) return NULL;
    for (jsize i = 0; i < n; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, arr, i);
        const char *utf = (*env)->GetStringUTFChars(env, s, NULL);
        out[i] = utf ? strdup(utf) : NULL;
        if (utf) (*env)->ReleaseStringUTFChars(env, s, utf);
        (*env)->DeleteLocalRef(env, s);
        if (!out[i]) {
            for (jsize j = 0; j < i; j++) free(out[j]);
            free(out);
            return NULL;
        }
    }
    return out;
}

static void free_cstrings(char **v) {
    if (!v) return;
    for (char **p = v; *p; p++) free(*p);
    free(v);
}

/* int spawn(String file, String[] argv, String[] env, String cwd, int rows, int cols, int[] out) */
JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_spawn(
    JNIEnv *env, jclass clazz, jstring file, jobjectArray argv, jobjectArray envp,
    jstring cwd, jint rows, jint cols, jintArray out) {
    (void)clazz;
    const char *cfile = (*env)->GetStringUTFChars(env, file, NULL);
    const char *ccwd = cwd ? (*env)->GetStringUTFChars(env, cwd, NULL) : NULL;
    char **cargv = to_cstrings(env, argv);
    char **cenvp = to_cstrings(env, envp);
    jint result = -12; /* -ENOMEM */

    if (cfile && cargv && cenvp) {
        int fd = -1;
        pid_t pid = 0;
        result = pf_spawn(cfile, cargv, cenvp, ccwd, rows, cols, &fd, &pid);
        if (result == 0) {
            jint pair[2] = {fd, (jint)pid};
            (*env)->SetIntArrayRegion(env, out, 0, 2, pair);
        }
    }
    free_cstrings(cargv);
    free_cstrings(cenvp);
    if (cfile) (*env)->ReleaseStringUTFChars(env, file, cfile);
    if (ccwd) (*env)->ReleaseStringUTFChars(env, cwd, ccwd);
    return result;
}

/* int read(int fd, byte[] buf, int len): blocks. >0 bytes, 0 = closed, <0 = -errno */
JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_read(
    JNIEnv *env, jclass clazz, jint fd, jbyteArray buf, jint len) {
    (void)clazz;
    char tmp[16384];
    if (len > (jint)sizeof tmp) len = (jint)sizeof tmp;
    int n = pf_read(fd, tmp, (size_t)len);
    if (n > 0) (*env)->SetByteArrayRegion(env, buf, 0, n, (const jbyte *)tmp);
    return n;
}

/* int write(int fd, byte[] buf, int off, int len): 0 or -errno */
JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_write(
    JNIEnv *env, jclass clazz, jint fd, jbyteArray buf, jint off, jint len) {
    (void)clazz;
    if (len <= 0) return 0;
    char *tmp = (char *)malloc((size_t)len);
    if (!tmp) return -12;
    (*env)->GetByteArrayRegion(env, buf, off, len, (jbyte *)tmp);
    int r = pf_write_all(fd, tmp, (size_t)len);
    free(tmp);
    return r;
}

JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_resize(
    JNIEnv *env, jclass clazz, jint fd, jint rows, jint cols) {
    (void)env;
    (void)clazz;
    return pf_set_size(fd, rows, cols);
}

JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_waitFor(
    JNIEnv *env, jclass clazz, jint pid) {
    (void)env;
    (void)clazz;
    return pf_wait((pid_t)pid);
}

JNIEXPORT jint JNICALL Java_com_pyforge_pyruntime_PtyNative_signal(
    JNIEnv *env, jclass clazz, jint pid, jint sig) {
    (void)env;
    (void)clazz;
    return pf_signal_group((pid_t)pid, sig);
}

JNIEXPORT void JNICALL Java_com_pyforge_pyruntime_PtyNative_close(
    JNIEnv *env, jclass clazz, jint fd) {
    (void)env;
    (void)clazz;
    pf_close(fd);
}