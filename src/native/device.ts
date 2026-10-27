/**
 * Small pieces of the phone the editor UI needs that a web page cannot do
 * reliably on its own. Each has a browser fallback so `npm run dev` (desktop)
 * and the jsdom tests keep working; on a phone they go through the same
 * Cordova plugin as the Python runtime (see PyRuntimePlugin.kt).
 *
 *  - Clipboard: `navigator.clipboard.readText()` is refused inside an Android
 *    WebView (there is no permission prompt to answer), so Paste would never
 *    work. The native side reads/writes the real ClipboardManager instead.
 *  - System selection bar: the floating Cut / Copy / Paste bar Android draws
 *    over selected text cannot be removed from JavaScript at all. The native
 *    WebView can be told not to show it (PyForgeWebView.kt); the selection
 *    and its drag handles are not affected.
 */

export interface ClipboardBackend {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

const hasCordova = (): boolean =>
  typeof window !== "undefined" && typeof window.cordova !== "undefined";

function exec<T>(action: string, args: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) =>
    cordova.exec<T>(resolve, reject, "PyRuntime", action, args),
  );
}

const nativeClipboard: ClipboardBackend = {
  read: () => exec<string>("clipboardRead").then((text) => text ?? ""),
  write: (text) => exec<void>("clipboardWrite", [text]).then(() => undefined),
};

const webClipboard: ClipboardBackend = {
  async read() {
    if (!navigator.clipboard?.readText)
      throw new Error("Paste is not available in this browser.");
    return navigator.clipboard.readText();
  },
  async write(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* permission or focus problem: fall through to the legacy path */
      }
    }
    // Legacy path: select a throwaway textarea and use execCommand. Needs a user gesture, which a tap is.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok =
      typeof document.execCommand === "function" &&
      document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Copy is not available in this browser.");
  },
};

/** The clipboard for wherever the app is running. */
export function defaultClipboardBackend(): ClipboardBackend {
  return hasCordova() ? nativeClipboard : webClipboard;
}

/**
 * Asks the native WebView to stop (`true`) or resume (`false`) showing the
 * system's floating selection bar. Fire-and-forget: if the native side is
 * missing (an older build, a browser) the system bar simply stays as it was.
 */
export function suppressSystemSelectionBar(on: boolean): void {
  if (!hasCordova()) return;
  void exec("selectionBar", [on]).catch(() => {});
}

/**
 * Opens a web link in the system browser. Inside the WebView a plain
 * `window.open` is swallowed; Cordova's `navigator.app.loadUrl` with
 * `openExternal` hands the URL to Android (https links are allowed by
 * `<allow-intent>` in config.xml). In a desktop browser a new tab is used.
 */
export function openExternal(url: string): void {
  const app = (
    navigator as Navigator & {
      app?: { loadUrl?: (u: string, props: { openExternal: boolean }) => void };
    }
  ).app;
  if (hasCordova() && app?.loadUrl) app.loadUrl(url, { openExternal: true });
  else window.open(url, "_blank", "noopener");
}
