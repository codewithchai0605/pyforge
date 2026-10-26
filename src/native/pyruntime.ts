/**
 * Runtime backends. The rest of the app only sees the PyRuntime interface in
 * ../python/protocol.ts and never knows which of these is behind it.
 *
 *  - cordovaRuntime : the real thing, on a phone (Kotlin plugin + Chaquopy).
 *  - devRuntime     : desktop CPython behind `npm run dev`'s HTTP bridge, so
 *                     the whole editor -> run -> console/turtle loop can be
 *                     developed and tested in a normal browser.
 *  - noneRuntime    : opened as a plain static page; Run explains why it can't.
 */
import type {
  GuiEvent,
  Insets,
  InstalledPackage,
  LookupResult,
  PipApi,
  PipProgress,
  PyEvent,
  PyRuntime,
  RunHandle,
  RuntimeInfo,
} from "@/python/protocol";
import { PipError } from "@/python/protocol";

type ExitEvent = Extract<PyEvent, { t: "exit" }>;

function parseEvent(line: string): PyEvent | null {
  try {
    return JSON.parse(line) as PyEvent;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- cordova

function exec<T>(action: string, args: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) =>
    cordova.exec<T>(resolve, reject, "PyRuntime", action, args),
  );
}

type LineStarter = (
  call: string,
  payload: string,
  onLine: (line: string) => void,
  onError: (err: Error) => void,
) => void;

/** Streaming exec: the native side calls `onLine` many times (keep-alive
 *  callback), the last call being the final result. Errors arrive later and
 *  separately, so they're reported through `onError`, not a promise. */
function execStream(
  action: string,
  args: unknown[],
  onLine: (line: string) => void,
  onError: (err: Error) => void,
): void {
  cordova.exec<string>(
    (line) => {
      if (typeof line === "string") onLine(line);
    },
    (err) =>
      onError(new Error(typeof err === "string" ? err : JSON.stringify(err))),
    "PyRuntime",
    action,
    args,
  );
}

function pipViaLines(
  call: string,
  args: unknown,
  onProgress: (p: PipProgress) => void,
  start: LineStarter,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    start(
      call,
      JSON.stringify(args),
      (line) => {
        const ev = JSON.parse(line) as
          | {
            t: "result";
            payload?: {
              ok: boolean;
              result?: unknown;
              error?: string;
              cancelled?: boolean;
            };
          }
          | PipProgress;
        if (ev.t === "result") {
          if (ev.payload?.ok) resolve(ev.payload.result);
          else
            reject(
              new PipError(
                ev.payload?.error ?? "Package operation failed",
                ev.payload?.cancelled === true,
              ),
            );
        } else {
          onProgress(ev);
        }
      },
      (err) => reject(new PipError(err.message)),
    );
  });
}

function makePip(start: LineStarter, cancel: () => void): PipApi {
  return {
    cancel,
    list: () =>
      pipViaLines("list", {}, () => { }, start) as Promise<InstalledPackage[]>,
    lookup: (spec) =>
      pipViaLines("lookup", { spec }, () => { }, start) as Promise<LookupResult>,
    install: (specs, onProgress) =>
      pipViaLines("install", { specs }, onProgress, start) as ReturnType<
        PipApi["install"]
      >,
    uninstall: (name, onProgress) =>
      pipViaLines("uninstall", { name }, onProgress, start) as ReturnType<
        PipApi["uninstall"]
      >,
  };
}

export function cordovaRuntime(
  readBase64: (path: string) => Promise<string>,
): PyRuntime {
  return {
    kind: "android",
    init: () => exec<RuntimeInfo>("init"),

    run(req, onEvent): RunHandle {
      let finish!: (e: ExitEvent) => void;
      const done = new Promise<ExitEvent>((resolve) => (finish = resolve));
      let ended = false;
      const deliver = (ev: PyEvent): void => {
        if (ended) return;
        if (ev.t === "exit") ended = true;
        onEvent(ev);
        if (ev.t === "exit") finish(ev);
      };
      execStream(
        "run",
        [JSON.stringify(req)],
        (line) => {
          const ev = parseEvent(line);
          if (ev) deliver(ev);
        },
        (err) => {
          deliver({ t: "err", s: `${err.message}\n` });
          deliver({ t: "exit", code: -1, ms: 0 });
        },
      );
      return {
        done,
        stdin: (text) => void exec("stdin", [text]),
        gui: (event: GuiEvent) => void exec("gui", [JSON.stringify(event)]),
        stop: async () => {
          await exec("stop");
          await done;
        },
      };
    },

    async imageUrl(path) {
      const b64 = await readBase64(path);
      return `data:image/png;base64,${b64}`;
    },

    pip: makePip(
      (call, payload, onLine, onError) =>
        execStream("pip", [call, payload], onLine, onError),
      () => void exec("pipCancel").catch(() => { }),
    ),

    insets: () => exec<Insets>("insets").catch(() => null),
  };
}

// --------------------------------------------------------------------- dev

const BRIDGE = "/__py";

export async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Reads an NDJSON response body, calling `onLine` for each complete line. */
export async function readLines(
  res: Response,
  onLine: (line: string) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (; ;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
    if (done) break;
  }
  if (buffer.trim()) onLine(buffer.trim());
}

export function devRuntime(base = ""): PyRuntime {
  const url = (p: string): string => `${base}${BRIDGE}${p}`;
  return {
    kind: "dev",
    async init() {
      const res = await fetch(url("/ping"));
      return (await res.json()) as RuntimeInfo;
    },

    run(req, onEvent): RunHandle {
      let finish!: (e: ExitEvent) => void;
      const done = new Promise<ExitEvent>((resolve) => (finish = resolve));
      let runId: string | null = null;
      const queued: Array<() => void> = [];
      let ended = false;
      const deliver = (ev: PyEvent): void => {
        if (ended) return;
        if (ev.t === "exit") ended = true;
        onEvent(ev);
        if (ev.t === "exit") finish(ev);
      };

      postJson(url("/run"), req)
        .then(async (res) => {
          runId = res.headers.get("x-run-id");
          queued.splice(0).forEach((fn) => fn());
          await readLines(res, (line) => {
            const ev = parseEvent(line);
            if (ev) deliver(ev);
          });
          // Stream closed without an exit event: the process was killed.
          deliver({ t: "exit", code: 137, ms: 0 });
        })
        .catch((err: Error) => {
          deliver({ t: "err", s: `${err.message}\n` });
          deliver({ t: "exit", code: -1, ms: 0 });
        });

      const send = (path: string, body: unknown): void => {
        const go = (): void =>
          void postJson(url(`/runs/${runId}/${path}`), body).catch(() => { });
        if (runId) go();
        else queued.push(go);
      };
      return {
        done,
        stdin: (text) => send("stdin", { text }),
        gui: (event) => send("gui", { event }),
        stop: async () => {
          // `send` queues until the run id is known, so a Stop tapped the
          // instant after Run still reaches the right process.
          if (!ended) send("stop", {});
          await done;
        },
      };
    },

    async imageUrl(path) {
      return url(`/plot?path=${encodeURIComponent(path)}`);
    },

    pip: (() => {
      let pipId: string | null = null;
      let cancelWanted = false;
      const sendCancel = (): void =>
        void postJson(url(`/pip/${pipId}/cancel`), {}).catch(() => { });
      return makePip(
        (call, payload, onLine, onError) => {
          pipId = null;
          cancelWanted = false;
          postJson(url("/pip"), { call, args: JSON.parse(payload) })
            .then((res) => {
              pipId = res.headers.get("x-pip-id");
              if (cancelWanted && pipId) sendCancel();
              return readLines(res, onLine);
            })
            .catch((err: Error) => onError(err));
        },
        () => {
          if (pipId) sendCancel();
          else cancelWanted = true; // the request hasn't been answered yet: cancel as soon as it is
        },
      );
    })(),

    insets: () => Promise.resolve(null),
  };
}

// -------------------------------------------------------------------- none

export function noneRuntime(): PyRuntime {
  const reason =
    "Python is only available inside the PyForge Android app, or in a desktop browser started with `npm run dev` (which uses your computer\u2019s Python).";
  const unavailable = (): never => {
    throw new PipError(reason);
  };
  return {
    kind: "none",
    init: () => Promise.reject(new Error(reason)),
    run(_req, onEvent): RunHandle {
      queueMicrotask(() => {
        onEvent({ t: "err", s: `${reason}\n` });
        onEvent({ t: "exit", code: 1, ms: 0 });
      });
      return {
        done: Promise.resolve({ t: "exit", code: 1, ms: 0 }),
        stdin() { },
        gui() { },
        stop: () => Promise.resolve(),
      };
    },
    imageUrl: () => Promise.reject(new Error(reason)),
    insets: () => Promise.resolve(null),
    pip: {
      cancel() { },
      list: () => Promise.resolve([]),
      lookup: async () => unavailable(),
      install: async () => unavailable(),
      uninstall: async () => unavailable(),
    },
  };
}

// ------------------------------------------------------------------ select

/** Picks the right backend for wherever the app is running. */
export async function createRuntime(
  readBase64: (path: string) => Promise<string>,
): Promise<PyRuntime> {
  if (typeof window.cordova !== "undefined") return cordovaRuntime(readBase64);
  try {
    const res = await fetch(`${BRIDGE}/ping`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) return devRuntime();
  } catch {
    /* no dev bridge: plain static page */
  }
  return noneRuntime();
}