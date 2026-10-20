import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';

/**
 * Completions on top of what @codemirror/lang-python already offers (keywords,
 * builtins, names defined in the same file): module names after `import` /
 * `from`, and the code snippets people type most.
 */

const STDLIB = [
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'bisect', 'calendar', 'collections', 'colorsys', 'contextlib',
  'copy', 'csv', 'dataclasses', 'datetime', 'decimal', 'difflib', 'enum', 'fractions', 'functools', 'glob', 'gzip',
  'hashlib', 'heapq', 'html', 'http', 'importlib', 'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'multiprocessing',
  'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'shlex', 'shutil',
  'signal', 'socket', 'sqlite3', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading',
  'time', 'timeit', 'traceback', 'turtle', 'types', 'typing', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref', 'xml', 'zipfile',
];

const COMMON_THIRD_PARTY = ['numpy', 'matplotlib', 'pandas', 'requests', 'PIL', 'scipy', 'bs4', 'flask', 'yaml', 'rich'];

const moduleCompletions: Completion[] = [
  ...STDLIB.map((label): Completion => ({ label, type: 'namespace', detail: 'stdlib' })),
  ...COMMON_THIRD_PARTY.map((label): Completion => ({ label, type: 'namespace', detail: 'package', boost: -1 })),
];

export function importCompletions(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^\s*(?:import|from)\s+([\w.]*)$/.exec(before);
  if (!m) return null;
  return { from: context.pos - m[1]!.length, options: moduleCompletions, validFor: /^[\w.]*$/ };
}

const snippets: Completion[] = [
  snippetCompletion('def ${name}(${args}):\n\t${pass}', { label: 'def', detail: 'function', type: 'keyword', boost: 2 }),
  snippetCompletion('class ${Name}:\n\tdef __init__(self${, args}):\n\t\t${pass}', { label: 'class', detail: 'class', type: 'keyword', boost: 2 }),
  snippetCompletion('for ${item} in ${items}:\n\t${pass}', { label: 'for', detail: 'for loop', type: 'keyword', boost: 2 }),
  snippetCompletion('while ${condition}:\n\t${pass}', { label: 'while', detail: 'while loop', type: 'keyword', boost: 2 }),
  snippetCompletion('if ${condition}:\n\t${pass}', { label: 'if', detail: 'if', type: 'keyword', boost: 2 }),
  snippetCompletion('try:\n\t${pass}\nexcept ${Exception} as ${e}:\n\t${raise}', { label: 'try', detail: 'try / except', type: 'keyword', boost: 2 }),
  snippetCompletion('with open(${path}) as ${f}:\n\t${pass}', { label: 'with', detail: 'open a file', type: 'keyword', boost: 2 }),
  snippetCompletion('if __name__ == "__main__":\n\t${main()}', { label: 'main', detail: 'script entry point', type: 'text', boost: 2 }),
  snippetCompletion('print(f"${}")', { label: 'printf', detail: 'print an f-string', type: 'function' }),
];

export function snippetSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  // Not mid-expression: only offer at the start of a statement.
  const line = context.state.doc.lineAt(word.from);
  if (line.text.slice(0, word.from - line.from).trim() !== '') return null;
  return { from: word.from, options: snippets, validFor: /^\w*$/ };
}
