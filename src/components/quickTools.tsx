import { computed, signal, type Signal } from 'xtags';
import {
  undo, redo, indentMore, indentLess, cursorLineUp, cursorLineDown, selectLineUp, selectLineDown, moveLineUp, moveLineDown,
  cursorCharLeft, cursorCharRight, selectCharLeft, selectCharRight, cursorGroupLeft, cursorGroupRight, selectGroupLeft,
  selectGroupRight, cursorLineBoundaryBackward, cursorLineBoundaryForward, selectLineBoundaryBackward,
  selectLineBoundaryForward, toggleComment,
} from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { EditorManager } from '@/editorManager';
import { openInFileSearch } from '@/editor/createEditor';
import { icon, type IconName } from './icons';

/**
 * The strip above the on-screen keyboard. A phone keyboard buries the
 * characters Python needs (`: ( ) [ ] { } _ # = "`), and has no Tab, Ctrl or
 * arrow keys, so this provides:
 *   row 1: a scrollable row of Python symbols that insert text at the cursor
 *   row 2: navigation/editing, with SHFT/CTRL/ALT as real modifiers for the
 *          next arrow tap (CTRL+→ jumps a word, ALT+↑ moves the line, ...)
 */
export function createQuickTools(editorManager: EditorManager): HTMLElement {
  const shift = signal(false);
  const ctrl = signal(false);
  const alt = signal(false);
  const view = (): EditorView => editorManager.editor;

  const run = (command: (v: EditorView) => boolean): void => {
    command(view());
    view().focus();
  };

  /** Inserts text at the cursor (replacing any selection), optionally placing the caret `back` chars from the end. */
  const insert = (text: string, back = 0): void => {
    const v = view();
    const sel = v.state.selection.main;
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length - back },
      scrollIntoView: true,
      userEvent: 'input.type',
    });
    v.focus();
  };

  const horizontal = (dir: 'left' | 'right'): void => {
    const s = shift.peek();
    if (alt.peek()) run(dir === 'left' ? (s ? selectLineBoundaryBackward : cursorLineBoundaryBackward) : s ? selectLineBoundaryForward : cursorLineBoundaryForward);
    else if (ctrl.peek()) run(dir === 'left' ? (s ? selectGroupLeft : cursorGroupLeft) : s ? selectGroupRight : cursorGroupRight);
    else run(dir === 'left' ? (s ? selectCharLeft : cursorCharLeft) : s ? selectCharRight : cursorCharRight);
  };

  const vertical = (dir: 'up' | 'down'): void => {
    if (alt.peek()) return run(dir === 'up' ? moveLineUp : moveLineDown);
    const s = shift.peek();
    run(dir === 'up' ? (s ? selectLineUp : cursorLineUp) : s ? selectLineDown : cursorLineDown);
  };

  // `pointerdown` + preventDefault keeps focus (and the keyboard) in the editor
  // instead of blurring it on every tap, which is what makes this usable.
  const keepFocus = (e: Event): void => e.preventDefault();

  const textBtn = (label: string, title: string, onClick: () => void, cls = ''): HTMLElement =>
    (
      <button type="button" class={`qt-btn ${cls}`} title={title} aria-label={title} onPointerDown={keepFocus} onClick={onClick}>
        {label}
      </button>
    ) as HTMLElement;
  const iconBtn = (name: IconName, title: string, onClick: () => void): HTMLElement =>
    (
      <button type="button" class="qt-btn" title={title} aria-label={title} onPointerDown={keepFocus} onClick={onClick}>
        {icon(name, 18)}
      </button>
    ) as HTMLElement;
  const toggleBtn = (label: string, sig: Signal<boolean>, title: string): HTMLElement =>
    (
      <button
        type="button"
        class={computed(() => ({ 'qt-btn': true, 'qt-toggle': true, active: sig() }))}
        title={title}
        aria-pressed={computed(() => String(sig()))}
        onPointerDown={keepFocus}
        onClick={() => sig.update((v) => !v)}
      >
        {label}
      </button>
    ) as HTMLElement;

  const symbols: Array<[string, string, number?]> = [
    ['Tab', '    '], [':', ':'], ['(', '()', 1], [')', ')'], ['[', '[]', 1], [']', ']'], ['{', '{}', 1], ['}', '}'],
    ['"', '""', 1], ["'", "''", 1], ['=', ' = '], ['_', '_'], ['#', '# '], [',', ', '], ['.', '.'], ['+', ' + '],
    ['-', ' - '], ['*', '*'], ['/', ' / '], ['%', ' % '], ['<', ' < '], ['>', ' > '], ['!', '!'], ['&', ' & '], ['|', ' | '],
    ['\\', '\\'], ['~', '~'], ['@', '@'], ['$', '$'],
  ];

  const row1 = (
    <div class="qt-row qt-symbols" role="toolbar" aria-label="Symbols">
      {symbols.map(([label, text, back]) =>
        label === 'Tab' ? textBtn('Tab', 'Insert 4 spaces', () => run(indentMore), 'qt-wide') : textBtn(label, `Insert ${label}`, () => insert(text, back ?? 0)),
      )}
    </div>
  ) as HTMLElement;

  const row2 = (
    <div class="qt-row" role="toolbar" aria-label="Editing">
      {textBtn('‹', 'Cursor left', () => horizontal('left'))}
      {textBtn('›', 'Cursor right', () => horizontal('right'))}
      {iconBtn('chevronUp', 'Cursor up', () => vertical('up'))}
      {iconBtn('chevronDown', 'Cursor down', () => vertical('down'))}
      {toggleBtn('SHFT', shift, 'Shift: extend the selection on the next arrow tap')}
      {toggleBtn('CTRL', ctrl, 'Ctrl: move by word on the next left/right tap')}
      {toggleBtn('ALT', alt, 'Alt: move the line on up/down; go to line start/end on left/right')}
      {iconBtn('undo', 'Undo', () => run(undo))}
      {iconBtn('redo', 'Redo', () => run(redo))}
      {iconBtn('hash', 'Comment / uncomment line', () => run(toggleComment))}
      {iconBtn('search', 'Find in this file', () => openInFileSearch(view()))}
      {textBtn('⇤', 'Dedent', () => run(indentLess))}
      {iconBtn('keyboardDown', 'Hide keyboard', () => view().contentDOM.blur())}
    </div>
  ) as HTMLElement;

  return (
    <div id="quick-tools">
      {row1}
      {row2}
    </div>
  ) as HTMLElement;
}
