import { signal, type Signal } from 'xtags';

/** User preferences, persisted in localStorage (works the same in the WebView and a desktop browser). */
export interface Settings {
  fontSize: Signal<number>;
  clearConsoleOnRun: Signal<boolean>;
  saveOnRun: Signal<boolean>;
  /** Write changed files shortly after typing stops. */
  autoSave: Signal<boolean>;
  /** Ask before leaving the app even when nothing is unsaved. */
  confirmOnExit: Signal<boolean>;
}

const KEY = 'pyforge.settings.v1';

function load(): Partial<Record<string, unknown>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createSettings(): Settings {
  const saved = load();
  const num = (v: unknown, d: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

  const settings: Settings = {
    fontSize: signal(num(saved.fontSize, 15, 11, 26)),
    clearConsoleOnRun: signal(bool(saved.clearConsoleOnRun, true)),
    saveOnRun: signal(bool(saved.saveOnRun, true)),
    autoSave: signal(bool(saved.autoSave, true)),
    confirmOnExit: signal(bool(saved.confirmOnExit, true)),
  };

  const persist = (): void => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          fontSize: settings.fontSize.peek(),
          clearConsoleOnRun: settings.clearConsoleOnRun.peek(),
          saveOnRun: settings.saveOnRun.peek(),
          autoSave: settings.autoSave.peek(),
          confirmOnExit: settings.confirmOnExit.peek(),
        }),
      );
    } catch {
      /* storage unavailable (private mode): settings just won't persist */
    }
  };
  // Wrap each setter so any change persists. Signals notify only on real changes.
  for (const s of Object.values(settings) as Signal<unknown>[]) {
    const original = s.set.bind(s);
    s.set = (next: unknown) => {
      original(next);
      persist();
    };
  }
  return settings;
}

/** Remembers which files were open so a restart (or Android killing the app) doesn't lose your place. */
export interface SessionState {
  files: { url: string; name: string; path: string | null }[];
  active: string | null;
}

const SESSION_KEY = 'pyforge.session.v1';

export function loadSession(): SessionState {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as SessionState | null;
    if (raw && Array.isArray(raw.files)) return raw;
  } catch {
    /* fall through */
  }
  return { files: [], active: null };
}

export function saveSession(state: SessionState): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
