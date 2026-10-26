#ifndef PYFORGE_PTY_CORE_H
#define PYFORGE_PTY_CORE_H

#include <stddef.h>
#include <sys/types.h>

/*
 * Runs `file` on a new pseudo-terminal, as the leader of a new session with
 * the terminal as its controlling terminal.
 *
 *   argv, envp   NULL-terminated, already built (nothing is allocated after fork)
 *   cwd          start directory, or NULL to keep the current one
 *   rows, cols   initial window size
 *
 * Returns 0 and sets *out_fd (the master side) and *out_pid, or -errno.
 * If `file` cannot be started the child prints a note on the terminal and
 * exits with status 127, so the caller sees an exit rather than a hang.
 */
int pf_spawn(const char *file, char *const argv[], char *const envp[],
             const char *cwd, int rows, int cols, int *out_fd, pid_t *out_pid);

/* TIOCSWINSZ on the master; the foreground program gets SIGWINCH. Returns 0 or -errno. */
int pf_set_size(int fd, int rows, int cols);

/* Blocking read. Returns bytes read (> 0), 0 when the shell side is closed, or -errno. */
int pf_read(int fd, void *buf, size_t len);

/* Writes everything (retrying short writes). Returns 0 or -errno. */
int pf_write_all(int fd, const void *buf, size_t len);

/* Blocks until `pid` ends. Returns its exit status, or 128 + signal number. */
int pf_wait(pid_t pid);

/* Closes the master side. */
void pf_close(int fd);

/* Sends `sig` to the shell's whole process group (so a running foreground job gets it too). Returns 0 or -errno. */
int pf_signal_group(pid_t pid, int sig);

#endif