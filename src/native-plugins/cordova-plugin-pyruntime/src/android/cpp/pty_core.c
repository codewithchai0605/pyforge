#define _GNU_SOURCE
#include "pty_core.h"

#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#ifndef IUTF8
#define IUTF8 0040000
#endif

/* Sensible defaults for a terminal that speaks UTF-8 (the same set a login tty starts with). */
static void default_termios(struct termios *t) {
    memset(t, 0, sizeof *t);
    t->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT | IUTF8;
    t->c_oflag = OPOST | ONLCR;
    t->c_cflag = CS8 | CREAD;
    t->c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL | IEXTEN;
    t->c_cc[VINTR] = 3;    /* ^C */
    t->c_cc[VQUIT] = 28;   /* ^\ */
    t->c_cc[VERASE] = 127; /* DEL */
    t->c_cc[VKILL] = 21;   /* ^U */
    t->c_cc[VEOF] = 4;     /* ^D */
    t->c_cc[VSTART] = 17;  /* ^Q */
    t->c_cc[VSTOP] = 19;   /* ^S */
    t->c_cc[VSUSP] = 26;   /* ^Z */
    t->c_cc[VLNEXT] = 22;  /* ^V */
    t->c_cc[VWERASE] = 23; /* ^W */
    t->c_cc[VMIN] = 1;
    t->c_cc[VTIME] = 0;
}

int pf_spawn(const char *file, char *const argv[], char *const envp[],
             const char *cwd, int rows, int cols, int *out_fd, pid_t *out_pid) {
    struct termios tio;
    struct winsize ws;
    int master = -1;

    default_termios(&tio);
    memset(&ws, 0, sizeof ws);
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);

    /*
     * Block every signal across the fork. The child starts with the app's
     * (the JVM's) signal handlers; a signal that arrived before they are reset
     * would be swallowed by one. Blocked, it stays pending in the child and is
     * delivered with the default action once the handlers are reset below.
     */
    sigset_t everything, previous;
    sigfillset(&everything);
    pthread_sigmask(SIG_SETMASK, &everything, &previous);

    pid_t pid = forkpty(&master, NULL, &tio, &ws);
    if (pid != 0) {
        int saved = errno;
        pthread_sigmask(SIG_SETMASK, &previous, NULL);
        errno = saved;
    }
    if (pid < 0) return -errno;

    if (pid == 0) {
        /*
         * Child. The parent is a multi-threaded JVM, so from here until exec
         * only async-signal-safe calls: no malloc, no stdio.
         */
        static const int reset[] = {SIGHUP, SIGINT, SIGQUIT, SIGPIPE, SIGTERM,
                                    SIGCHLD, SIGTSTP, SIGTTIN, SIGTTOU, SIGWINCH,
                                    SIGUSR1, SIGUSR2};
        for (size_t i = 0; i < sizeof reset / sizeof reset[0]; i++)
            signal(reset[i], SIG_DFL);
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL); /* pending signals are delivered now, with default actions */

        /* Everything the app had open must not leak into the shell. */
        long max = sysconf(_SC_OPEN_MAX);
        if (max < 0 || max > 4096) max = 4096;
        for (int fd = 3; fd < max; fd++) close(fd);

        if (cwd && chdir(cwd) != 0) {
            /* Not fatal: a shell in the wrong folder beats no shell. */
            static const char note[] = "pyforge: cannot enter the start folder\r\n";
            (void)!write(2, note, sizeof note - 1);
        }
        execve(file, argv, envp);
        static const char fail[] = "pyforge: cannot start the shell\r\n";
        (void)!write(2, fail, sizeof fail - 1);
        _exit(127);
    }

    *out_fd = master;
    *out_pid = pid;
    return 0;
}

int pf_set_size(int fd, int rows, int cols) {
    struct winsize ws;
    memset(&ws, 0, sizeof ws);
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
    return ioctl(fd, TIOCSWINSZ, &ws) == 0 ? 0 : -errno;
}

int pf_read(int fd, void *buf, size_t len) {
    for (;;) {
        ssize_t n = read(fd, buf, len);
        if (n >= 0) return (int)n;
        if (errno == EINTR) continue;
        if (errno == EIO) return 0; /* the shell side hung up */
        return -errno;
    }
}

int pf_write_all(int fd, const void *buf, size_t len) {
    const char *p = (const char *)buf;
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -errno;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

int pf_wait(pid_t pid) {
    int status = 0;
    for (;;) {
        pid_t r = waitpid(pid, &status, 0);
        if (r < 0) {
            if (errno == EINTR) continue;
            return 0; /* already reaped */
        }
        break;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 0;
}

int pf_signal_group(pid_t pid, int sig) {
    if (kill(-pid, sig) == 0) return 0;
    if (errno == ESRCH && kill(pid, sig) == 0) return 0;
    return -errno;
}

void pf_close(int fd) {
    if (fd >= 0) close(fd);
}