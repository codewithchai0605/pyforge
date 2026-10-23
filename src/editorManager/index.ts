import { signal, type Signal } from "xtags";
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { createEditorView, createFileState } from "@/editor/createEditor";
import { fsOperation } from "@/fileSystem";

let nextFileId = 1;

export interface EditorFile {
  readonly id: string;
  /** null for a file that's never been saved anywhere yet ("untitled"). */
  readonly url: string | null;
  readonly name: string;
  /** Slash-separated path relative to whatever folder is open in the
   *  explorer (e.g. "src/assets/tail-spin.svg"), for display in the
   *  titlebar's breadcrumb — null if this file wasn't opened from the
   *  tree (a brand new file, or one opened some other way), since a SAF
   *  content:// URI can't be turned back into a real path without this
   *  being threaded through at open time. */
  readonly path: string | null;
  readonly dirty: Signal<boolean>;
}

/**
 * The single source of truth for "what's open in the editor" — every open
 * tab, which one is active, and the one CodeMirror view they all share.
 * Everything that used to live as loose variables in main.ts (openFileUrl,
 * a single dirty signal, a single filename signal) lives here now; every
 * other piece of UI (tabsBar, appShell, searchPanel, quickTools)
 * drives the editor through this instead of touching
 * CodeMirror or the filesystem directly.
 *
 * `activeFile`/`activeFiles`/`editor` are named to match Acode's and VS
 * Code's own editorManager concept, not an arbitrary design of this app's
 * own — see this module's tests and the README for the one non-obvious
 * design decision this is built on: **one shared EditorView, one
 * EditorState per open file**, swapped in and out with `view.setState()`
 * rather than tearing down and recreating a view per tab. That's what
 * gives every tab its own independent undo history, cursor position, and
 * scroll offset, restored exactly when you switch back to it — the same
 * thing a real multi-tab editor does, and something recreating a view
 * from scratch on every tab switch could not.
 */
export class EditorManager {
  /** The one CodeMirror view every open file's state gets swapped into and
   *  out of. Exposed directly (not wrapped) so a plugin or a future
   *  feature can dispatch its own transactions when the higher-level
   *  methods below aren't enough. */
  readonly editor: EditorView;

  readonly activeFiles: Signal<EditorFile[]> = signal([]);
  readonly activeFile: Signal<EditorFile | null> = signal(null);

  private states = new Map<string, EditorState>();
  /** Content as of the last successful save (or, for a file that's never
   *  been saved, as of when it was opened/created) — the diff view's
   *  "compare with saved" baseline, and what dirty-checking compares the
   *  live buffer against. */
  private savedContents = new Map<string, string>();
  private updateListeners = new Set<() => void>();

  constructor(host: HTMLElement) {
    this.editor = createEditorView(host);
  }

  /** Subscribes to "something about the active file changed" — a real
   *  edit, the cursor/selection moving, or switching to a different tab.
   *  Returns an unsubscribe function. */
  onUpdate(listener: () => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /** Opens `url` in a new tab, or switches to it if it's already open —
   *  matching how every real editor treats "open" on an already-open file.
   *  `path` (a display-only, slash-separated path relative to the open
   *  folder) is threaded through from the explorer tree at call time,
   *  since it can't be recovered later from `url` alone — see EditorFile's
   *  `path` field. */
  async openFile(
    url: string,
    name: string,
    path: string | null = null,
  ): Promise<EditorFile> {
    const existing = this.activeFiles.peek().find((f) => f.url === url);
    if (existing) {
      this.switchTo(existing.id);
      return existing;
    }

    const content = await fsOperation(url).readFile();
    const file = this.addFile(url, name, content, path);
    this.switchTo(file.id);
    return file;
  }

  /** Opens a new tab that isn't backed by any file on disk yet — either a
   *  genuinely new, empty file, or (used once, at boot) a synthetic
   *  "sample content" file. Never collides with an already-open tab, since
   *  unlike `openFile` there's no url to match against — every call opens
   *  a distinct tab, same as a real editor's "New File" always does. */
  newFile(name = "untitled", content = ""): EditorFile {
    const file = this.addFile(null, name, content, null);
    this.switchTo(file.id);
    return file;
  }

  private addFile(
    url: string | null,
    name: string,
    content: string,
    path: string | null,
  ): EditorFile {
    const file: EditorFile = {
      id: `file-${nextFileId++}`,
      url,
      name,
      path,
      dirty: signal(false),
    };
    this.states.set(
      file.id,
      createFileState(name, content, () => this.handleViewUpdate(file.id)),
    );
    this.savedContents.set(file.id, content);
    this.activeFiles.update((files) => [...files, file]);
    return file;
  }

  switchTo(id: string): void {
    if (this.activeFile.peek()?.id === id) return;

    const current = this.activeFile.peek();
    // setState() (below) doesn't snapshot the outgoing state anywhere on
    // its own — it just discards whatever the view was showing — so the
    // file we're leaving has to be saved into `states` here, *before*
    // calling it, or its live edits/cursor/undo history would be lost the
    // next time we switch back to it.
    if (current) this.states.set(current.id, this.editor.state);

    const nextState = this.states.get(id);
    const file = this.activeFiles.peek().find((f) => f.id === id);
    if (!nextState || !file) return;

    this.editor.setState(nextState);
    this.activeFile.set(file);
    // Verified empirically (not assumed) that EditorView.setState() does
    // NOT fire updateListener extensions the way dispatch() does, so nothing
    // above already triggered plugins like word-count/cursor-position to
    // refresh for the newly-active file — this call is what does that.
    this.notify();
  }

  /** Closes a tab. If it was the active one, focus moves to the tab that
   *  was to its right, falling back to the one on its left, matching most
   *  editors' (and browsers') tab-close behavior. Closing the last tab
   *  leaves the editor genuinely empty — activeFile becomes null. */
  closeFile(id: string): void {
    const files = this.activeFiles.peek();
    const index = files.findIndex((f) => f.id === id);
    if (index === -1) return;

    const wasActive = this.activeFile.peek()?.id === id;
    const remaining = files.filter((f) => f.id !== id);
    this.activeFiles.set(remaining);
    this.states.delete(id);
    this.savedContents.delete(id);

    if (!wasActive) return;

    const next = remaining[index] ?? remaining[index - 1];
    if (next) {
      // The tab we were just on is already gone from `states`/`activeFiles`,
      // so switchTo's "save the outgoing state" step above is a safe no-op
      // for it — there's nothing left to save it into.
      this.activeFile.set(null);
      this.switchTo(next.id);
    } else {
      this.activeFile.set(null);
      this.editor.setState(createFileState("", "", () => {}));
      this.notify();
    }
  }

  /** Writes the active file's current buffer to disk. Returns false
   *  without writing anything if there's no active file, or it's an
   *  untitled one with nowhere to write to yet — callers (appShell's Save
   *  button) are expected to handle that case (prompt for a location, or
   *  just leave it for now); this manager doesn't own file pickers. */
  async save(): Promise<boolean> {
    const file = this.activeFile.peek();
    if (!file?.url) return false;
    const content = this.getValue();
    await fsOperation(file.url).writeFile(content);
    this.savedContents.set(file.id, content);
    file.dirty.set(false);
    return true;
  }

  /** Saves every open file that has unsaved changes and somewhere to be saved.
   *  The active file's live buffer lives in the view, the others in `states`.
   *  Returns how many files were written. Failures for one file don't stop the rest. */
  async saveAll(): Promise<{ saved: number; failed: string[] }> {
    const active = this.activeFile.peek();
    let saved = 0;
    const failed: string[] = [];
    for (const file of this.activeFiles.peek()) {
      if (!file.url || !file.dirty.peek()) continue;
      const state =
        file.id === active?.id ? this.editor.state : this.states.get(file.id);
      if (!state) continue;
      const content = state.doc.toString();
      try {
        await fsOperation(file.url).writeFile(content);
        this.savedContents.set(file.id, content);
        file.dirty.set(false);
        saved++;
      } catch {
        failed.push(file.name);
      }
    }
    return { saved, failed };
  }

  /** Closes every tab whose file is `url` or lives inside the folder `url`
   *  (used after a delete or rename, so no tab points at something gone). */
  closeByUrl(url: string): void {
    const prefix = url.endsWith("/") ? url : url + "/";
    for (const file of [...this.activeFiles.peek()]) {
      if (file.url && (file.url === url || file.url.startsWith(prefix)))
        this.closeFile(file.id);
    }
  }

  /** The active file's current buffer content. */
  getValue(): string {
    return this.editor.state.doc.toString();
  }

  /** The active file's content as of its last save (or as of open/create,
   *  if it's never been saved) — used by diffView.ts as the "old" side of
   *  a "compare with saved version" diff. Not exposed for closed/unknown
   *  file ids. */
  getSavedContent(id: string): string | undefined {
    return this.savedContents.get(id);
  }

  goToLine(lineNumber: number): void {
    const totalLines = this.editor.state.doc.lines;
    const clamped = Math.min(Math.max(1, lineNumber), totalLines);
    const line = this.editor.state.doc.line(clamped);
    this.editor.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    this.editor.focus();
  }

  private notify(): void {
    this.updateListeners.forEach((cb) => cb());
  }

  private handleViewUpdate(fileId: string): void {
    const saved = this.savedContents.get(fileId);
    const file = this.activeFiles.peek().find((f) => f.id === fileId);
    // A file's own onUpdate callback only ever fires while its EditorState
    // is the one actually mounted in the view (that's what "update
    // listener" means — it's watching *transactions on that state*), so
    // `file` here is always the active file. The lookup above is just how
    // this reaches the right Signal to set, not a staleness guard.
    if (file && saved !== undefined) {
      file.dirty.set(saved !== this.getValue());
    }
    this.notify();
  }
}
