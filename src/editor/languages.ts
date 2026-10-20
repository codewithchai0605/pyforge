import { LanguageSupport } from '@codemirror/language';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { importCompletions, snippetSource } from './pythonCompletions';

/**
 * Extension -> language. Python is the product; JSON/HTML/CSS are here only
 * because Python projects commonly carry such files (configs, templates).
 * Each CodeMirror language is its own npm package and is bundled only if
 * listed here.
 */
function pythonSupport(): LanguageSupport {
  // python() bundles the grammar plus keyword/builtin/local-name completion;
  // we add module-name and snippet completion on top of that.
  return new LanguageSupport(pythonLanguage, [
    python().support,
    pythonLanguage.data.of({ autocomplete: importCompletions }),
    pythonLanguage.data.of({ autocomplete: snippetSource }),
  ]);
}

const byExtension: Record<string, () => LanguageSupport> = {
  py: pythonSupport,
  pyw: pythonSupport,
  pyi: pythonSupport,
  json: () => json(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
};

export function languageForFilename(filename: string): LanguageSupport | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const factory = byExtension[ext];
  return factory ? factory() : null;
}

export function supportedExtensions(): string[] {
  return Object.keys(byExtension);
}
