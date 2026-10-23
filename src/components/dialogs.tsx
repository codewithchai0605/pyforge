import { icon, type IconName } from './icons';
import { pushBack } from './backStack';

/**
 * Promise-based modal dialogs. They replace window.prompt/confirm, which are
 * blocking, unstyled and unreliable inside an Android WebView. Android's Back
 * button dismisses them (see backStack.ts).
 */

/** Opens `build(close)`'s element as a modal; resolves with whatever is passed to `close` (undefined if dismissed). */
export function customDialog(build: (close: (result?: unknown) => void) => HTMLElement): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    let unregister = (): void => {};
    const scrim = (<div class="modal-scrim" />) as HTMLElement;
    const close = (result?: unknown): void => {
      if (done) return;
      done = true;
      unregister();
      scrim.classList.remove('show');
      setTimeout(() => scrim.remove(), 160);
      resolve(result);
    };
    scrim.appendChild(build(close));
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close(undefined);
    });
    document.body.appendChild(scrim);
    unregister = pushBack(() => close(undefined));
    requestAnimationFrame(() => scrim.classList.add('show'));
  });
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error message to block submission, or null if the value is fine. */
  validate?: (value: string) => string | null;
  /** Select just the part before the extension when opening (rename). */
  selectStem?: boolean;
}

/** Asks for one line of text. Resolves with the trimmed value, or null if cancelled. */
export async function promptDialog(options: PromptOptions): Promise<string | null> {
  const result = await customDialog((close) => {
    const error = (<div class="dialog-error" role="alert" />) as HTMLElement;
    const input = (
      <input
        class="dialog-input"
        type="text"
        value={options.value ?? ''}
        placeholder={options.placeholder ?? ''}
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="done"
      />
    ) as HTMLInputElement;
    const submit = (): void => {
      const value = input.value.trim();
      const problem = value ? (options.validate?.(value) ?? null) : 'Enter a name.';
      if (problem) {
        error.textContent = problem;
        input.focus();
        return;
      }
      close(value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    input.addEventListener('input', () => (error.textContent = ''));
    setTimeout(() => {
      input.focus();
      const stem = options.selectStem ? input.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, stem > 0 ? stem : input.value.length);
    }, 60);
    return (
      <div class="dialog" role="dialog" aria-modal="true" aria-label={options.title}>
        <h2 class="dialog-title">{options.title}</h2>
        {options.label ? <label class="dialog-label">{options.label}</label> : null}
        {input}
        {error}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => close(undefined)}>
            Cancel
          </button>
          <button type="button" class="btn btn-primary" onClick={submit}>
            {options.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    ) as HTMLElement;
  });
  return typeof result === 'string' ? result : null;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const result = await customDialog((close) => (
    <div class="dialog" role="alertdialog" aria-modal="true" aria-label={options.title}>
      <h2 class="dialog-title">{options.title}</h2>
      <p class="dialog-message">{options.message}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" onClick={() => close(false)}>
          Cancel
        </button>
        <button type="button" class={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
          {options.confirmLabel ?? 'OK'}
        </button>
      </div>
    </div>
  ) as HTMLElement);
  return result === true;
}

export interface ChoiceOption<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger' | 'default';
}

export interface ChoiceOptions<T> {
  title: string;
  message: string;
  choices: ChoiceOption<T>[];
}

/**
 * A dialog with several outcomes (e.g. "Save and exit" / "Discard and exit" /
 * Cancel). Resolves with the chosen value, or `undefined` if dismissed (Back,
 * tapping outside), which callers should treat as "stay where I am".
 */
export async function choiceDialog<T>(options: ChoiceOptions<T>): Promise<T | undefined> {
  const result = (await customDialog((close) => (
    <div class="dialog" role="alertdialog" aria-modal="true" aria-label={options.title}>
      <h2 class="dialog-title">{options.title}</h2>
      <p class="dialog-message">{options.message}</p>
      <div class="dialog-stack">
        {options.choices.map((c) => (
          <button type="button" class={`btn ${c.kind === 'primary' ? 'btn-primary' : c.kind === 'danger' ? 'btn-danger' : ''}`} onClick={() => close({ value: c.value })}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  ) as HTMLElement)) as { value: T } | undefined;
  return result?.value;
}

export interface SheetItem<T> {
  label: string;
  description?: string;
  icon?: IconName;
  danger?: boolean;
  value: T;
}

/** A bottom sheet of choices. Resolves with the picked item's value, or undefined if dismissed. */
export async function sheetDialog<T>(title: string, items: SheetItem<T>[]): Promise<T | undefined> {
  const result = (await customDialog((close) => (
    <div class="dialog dialog-sheet" role="menu" aria-label={title}>
      <h2 class="dialog-title">{title}</h2>
      <div class="sheet-list">
        {items.map((item) => (
          <button type="button" role="menuitem" class={`sheet-item${item.danger ? ' danger' : ''}`} onClick={() => close({ value: item.value })}>
            {item.icon ? icon(item.icon, 20) : null}
            <span class="sheet-text">
              <span class="sheet-label">{item.label}</span>
              {item.description ? <span class="sheet-desc">{item.description}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  ) as HTMLElement)) as { value: T } | undefined;
  return result?.value;
}
