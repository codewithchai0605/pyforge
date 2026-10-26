/**
 * Desktop stand-in for the Android Python plugin, used by `npm run dev` and by
 * the automated end-to-end test.
 *
 * It exposes the same capabilities the Kotlin plugin does (run a script and
 * stream its events, stdin, GUI events, stop, package manager) over a tiny
 * HTTP API, by spawning the *same* pyforge package under your desktop Python
 * (`python -m pyforge.host`). Anything that works through here exercises the
 * real runner, protocol and turtle/matplotlib shims; only Chaquopy, Binder
 * and the Android filesystem are not involved.
 *
 *   GET  /__py/ping                 -> RuntimeInfo
 *   POST /__py/run                  -> NDJSON event stream (header x-run-id)
 *   POST /__py/runs/:id/stdin|gui|stop
 *   POST /__py/pip                  -> NDJSON progress, last line {"t":"result"} (header x-pip-id)
 *   POST /__py/pip/:id/cancel
 *   GET  /__py/plot?path=...        -> a PNG the program saved (cache dir only)
 *   POST /__py/term/open            -> NDJSON stream of a shell on a PTY: {"t":"open","id"},
 *                                      {"t":"out","b":base64}, {"t":"exit","code"}
 *   POST /__py/term/:id/in|resize|close
 */
import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface BridgeOptions {
  /** Python executable (default: $PYFORGE_PYTHON or python3). */
  python?: string;
  /** Directory holding the `pyforge` package. */
  pythonSrc?: string;
  /** Scratch dir for projects, site-packages, caches. */
  workDir?: string;
}

const DEFAULT_SRC = path.resolve(
  "src/native-plugins/cordova-plugin-pyruntime/src/android/python",
);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function insideDir(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createBridge(
  options: BridgeOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const python = options.python ?? process.env.PYFORGE_PYTHON ?? "python3";
  const pythonSrc = options.pythonSrc ?? DEFAULT_SRC;
  const work = path.resolve(options.workDir ?? ".pyforge-dev");
  const dirs = {
    home: path.join(work, "home"),
    site: path.join(work, "site-packages"),
    projects: path.join(work, "projects"),
    cache: path.join(work, "cache"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  const env = { ...process.env, PYTHONPATH: pythonSrc, PYTHONUNBUFFERED: "1" };
  const hostArgs = [
    "-u",
    "-m",
    "pyforge.host",
    "--home",
    dirs.home,
    "--site",
    dirs.site,
    "--projects",
    dirs.projects,
    "--cache",
    dirs.cache,
  ];
  const runs = new Map<string, ChildProcessWithoutNullStreams>();
  const pips = new Map<string, ChildProcessWithoutNullStreams>();
  const terms = new Map<string, ChildProcessWithoutNullStreams>();
  const ptyHost = path.resolve("utils/dev-bridge/pty_host.py");
  let versionCache: string | null = null;

  const pythonVersion = (): string => {
    if (!versionCache) {
      versionCache = execFileSync(
        python,
        ["-c", "import sys;print(sys.version.split()[0])"],
        { encoding: "utf8" },
      ).trim();
    }
    return versionCache;
  };

  /** Resolve a client-supplied relative path inside the projects dir. */
  const inProjects = (rel: string): string => {
    const abs = path.resolve(dirs.projects, rel.replace(/^\/+/, ""));
    if (!insideDir(dirs.projects, abs))
      throw new Error(`path escapes the workspace: ${rel}`);
    return abs;
  };

  /** A shell's start folder: the app sends the workspace's absolute path; anything outside it falls back to the workspace. */
  const termCwd = (dir: string): string => {
    const abs = path.resolve(dir);
    return path.isAbsolute(dir) && insideDir(dirs.projects, abs) ? abs : inProjects(dir);
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__py/")) return false;
    const route = url.pathname.slice("/__py".length);

    try {
      if (req.method === "GET" && route === "/ping") {
        json(res, 200, {
          python: pythonVersion(),
          android: false,
          abi: null,
          api: 0,
          cp: `cp${pythonVersion().split(".").slice(0, 2).join("")}`,
          site: dirs.site,
          projects: dirs.projects,
        });
        return true;
      }

      if (req.method === "GET" && route === "/plot") {
        const file = path.resolve(url.searchParams.get("path") ?? "");
        if (!insideDir(dirs.cache, file) || !existsSync(file))
          return (json(res, 404, { error: "not found" }), true);
        res.writeHead(200, { "content-type": "image/png" });
        res.end(readFileSync(file));
        return true;
      }

      if (req.method === "POST" && route === "/run") {
        const body = JSON.parse(await readBody(req)) as Record<
          string,
          unknown
        > & { files?: Record<string, string> };
        for (const [rel, content] of Object.entries(body.files ?? {})) {
          const abs = inProjects(rel);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
        const request = { ...body };
        delete request.files;
        if (typeof request.path === "string")
          request.path = inProjects(request.path);
        if (typeof request.cwd === "string")
          request.cwd = inProjects(request.cwd);
        else if (request.mode !== "repl")
          request.cwd =
            typeof request.path === "string"
              ? path.dirname(request.path)
              : dirs.projects;

        const id = randomUUID();
        const child = spawn(python, hostArgs, { env, cwd: work });
        runs.set(id, child);
        child.on("close", () => runs.delete(id));
        child.stderr.on("data", (d: Buffer) =>
          process.stderr.write(`[py host] ${d}`),
        );
        child.stdin.on("error", () => { });
        // nosniff: without it WebKit buffers an open streaming response while it
        // sniffs the type, so live output wouldn't appear until the program ended.
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-content-type-options": "nosniff",
          "x-run-id": id,
          "cache-control": "no-store",
        });
        child.stdout.pipe(res);
        res.on("close", () => child.kill("SIGKILL"));
        child.stdin.write(JSON.stringify({ op: "run", req: request }) + "\n");
        return true;
      }

      if (req.method === "POST" && route === "/term/open") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          cols?: number;
          rows?: number;
          cwd?: string;
          shell?: string;
        };
        const id = randomUUID();
        const args = [
          "-u",
          ptyHost,
          "--cols",
          String(Math.max(2, Math.floor(body.cols ?? 80))),
          "--rows",
          String(Math.max(1, Math.floor(body.rows ?? 24))),
          "--cwd",
          typeof body.cwd === "string" && body.cwd ? termCwd(body.cwd) : dirs.projects,
        ];
        if (typeof body.shell === "string" && body.shell)
          args.push("--shell", body.shell);
        const child = spawn(python, args, { env, cwd: work });
        terms.set(id, child);
        child.on("close", () => terms.delete(id));
        child.stdin.on("error", () => { });
        child.stderr.on("data", (d: Buffer) =>
          process.stderr.write(`[pty host] ${d}`),
        );
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        res.write(JSON.stringify({ t: "open", id }) + "\n");
        child.stdout.pipe(res);
        res.on("close", () => child.kill("SIGKILL"));
        return true;
      }

      const tm = /^\/term\/([^/]+)\/(in|resize|close)$/.exec(route);
      if (req.method === "POST" && tm) {
        const child = terms.get(tm[1]!);
        if (!child) return (json(res, 404, { error: "no such terminal" }), true);
        const payload = JSON.parse((await readBody(req)) || "{}") as Record<
          string,
          unknown
        >;
        child.stdin.write(JSON.stringify({ op: tm[2], ...payload }) + "\n");
        json(res, 200, { ok: true });
        return true;
      }

      const m = /^\/runs\/([^/]+)\/(stdin|gui|stop)$/.exec(route);
      if (req.method === "POST" && m) {
        const child = runs.get(m[1]!);
        if (!child) return (json(res, 404, { error: "no such run" }), true);
        const payload =
          m[2] === "stop"
            ? {}
            : (JSON.parse(await readBody(req)) as Record<string, unknown>);
        if (m[2] === "stop") child.kill("SIGKILL");
        else child.stdin.write(JSON.stringify({ op: m[2], ...payload }) + "\n");
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === "POST" && route === "/pip") {
        const { call, args } = JSON.parse(await readBody(req)) as {
          call: string;
          args: unknown;
        };
        const id = randomUUID();
        const child = spawn(
          python,
          [...hostArgs, "--pip", call, JSON.stringify(args ?? {})],
          { env, cwd: work },
        );
        pips.set(id, child);
        child.on("close", () => pips.delete(id));
        child.stdin.on("error", () => { });
        child.stderr.on("data", (d: Buffer) =>
          process.stderr.write(`[py pip] ${d}`),
        );
        res.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-content-type-options": "nosniff",
          "x-pip-id": id,
          "cache-control": "no-store",
        });
        child.stdout.pipe(res);
        res.on("close", () => child.kill());
        return true;
      }

      const cancelMatch = /^\/pip\/([^/]+)\/cancel$/.exec(route);
      if (req.method === "POST" && cancelMatch) {
        pips.get(cancelMatch[1]!)?.stdin.write("cancel\n");
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: `unknown bridge route ${route}` });
      return true;
    } catch (err) {
      json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  };
}