import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { openSearchPanel, search } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageForFilename } from './languages';

/**
 * Extensions every open file's EditorState is built with — not just
 * whichever file happened to be active when some code last ran. This
 * matters because EditorManager keeps one EditorState *per open file*
 * (so each tab keeps its own undo history, cursor, and scroll position)
 * and builds each one fresh from this list via `createFileState()`.
 * Anything appended later to whatever's currently active — the way a
 * single-document editor might reach for `view.dispatch({effects:
 * StateEffect.appendConfig.of(...)})` — would silently apply to only that
 * one file's state and never show up after switching tabs. (This was
 * verified empirically, not assumed: EditorView.setState(), which is how
 * EditorManager swaps between files' states, does *not* fire
 * `updateListener` extensions the way dispatch() does — see
 * editorManager/index.ts's `switchTo` for why it calls `notify()`
 * manually right after.)
 */
function baseExtensions(onUpdate: (update: { docChanged: boolean; selectionSet: boolean }) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    oneDark,
    // Python's convention: four spaces, and Tab/Shift-Tab (indentWithTab) indent by that.
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) onUpdate(update);
    }),
  ];
}

/** Builds a fresh EditorState for one file — its own undo history starting
 *  empty, language support picked from its filename, and the shared base
 *  extensions above. `onUpdate` is baked in at creation time rather than
 *  attached later, for the reason explained above. */
export function createFileState(
  filename: string,
  content: string,
  onUpdate: (update: { docChanged: boolean; selectionSet: boolean }) => void,
): EditorState {
  const language = languageForFilename(filename);
  return EditorState.create({
    doc: content,
    extensions: [...baseExtensions(onUpdate), language ?? []],
  });
}

/** The one shared EditorView every file's state gets swapped into and out
 *  of. Starts with an empty placeholder state; EditorManager replaces it
 *  with a real per-file state as soon as the first file opens (or a fresh
 *  untitled one, if none does). */
export function createEditorView(host: HTMLElement): EditorView {
  const placeholder = EditorState.create({ doc: '', extensions: baseExtensions(() => {}) });
  return new EditorView({ state: placeholder, parent: host });
}

/** Opens CodeMirror's own single-buffer find/replace panel — distinct from
 *  this app's multi-file native search (searchPanel.ts): this searches only
 *  the active file, instantly, no native call involved. Used by the
 *  quick-tools toolbar. */
export function openInFileSearch(view: EditorView): void {
  openSearchPanel(view);
}
