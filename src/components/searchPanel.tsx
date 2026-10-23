import { For, Show, computed, signal } from "xtags";
import { fsOperation } from "@/fileSystem";
import { walkFiles } from "@/fileSystem/walk";
import { icon } from "./icons";

export interface SearchMatch {
  /** 1-based line number. */
  line: number;
  lineText: string;
  /** Column range of the match within `lineText`. */
  start: number;
  end: number;
}

export interface SearchOptions {
  matchCase: boolean;
  regex: boolean;
}

const MAX_MATCHES_PER_FILE = 100;

/** Finds every match of `query` in `text`. Throws a readable Error for an invalid regex. */
export function searchText(
  text: string,
  query: string,
  { matchCase, regex }: SearchOptions,
): SearchMatch[] {
  let re: RegExp;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, matchCase ? "g" : "gi");
  } catch (e) {
    throw new Error(
      `Invalid pattern: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const matches: SearchMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (
    let i = 0;
    i < lines.length && matches.length < MAX_MATCHES_PER_FILE;
    i++
  ) {
    const lineText = lines[i]!;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      if (m[0] === "") {
        re.lastIndex++; // zero-width match (e.g. /^/): don't loop forever
        continue;
      }
      matches.push({
        line: i + 1,
        lineText: lineText.slice(0, 400),
        start: m.index,
        end: m.index + m[0].length,
      });
      if (matches.length >= MAX_MATCHES_PER_FILE) break;
    }
  }
  return matches;
}

export interface SearchPanelOptions {
  /** The folder the explorer is showing; read fresh on every search. */
  getRootUrl(): string | null;
  onOpenMatch(url: string, name: string, line: number): void;
}

interface FileMatches {
  path: string;
  url: string;
  name: string;
  matches: SearchMatch[];
}

export type SearchPanelElement = HTMLElement & { focusInput(): void };

// Two independent caps: walkFiles bounds how much of the tree is listed, this
// bounds how big a single file we'll read, so a stray large log can't stall a search.
const MAX_FILES_TO_SEARCH = 300;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export function createSearchPanel(
  options: SearchPanelOptions,
): SearchPanelElement {
  const pattern = signal("");
  const matchCase = signal(false);
  const regex = signal(false);
  const searching = signal(false);
  const results = signal<FileMatches[]>([]);
  const errorMessage = signal<string | null>(null);
  const filesScanned = signal(0);
  const truncated = signal(false);
  const hasSearched = signal(false);
  let inputEl: HTMLInputElement | null = null;

  async function runSearch(): Promise<void> {
    const root = options.getRootUrl();
    const query = pattern.peek();
    errorMessage.set(null);
    results.set([]);
    truncated.set(false);
    filesScanned.set(0);
    hasSearched.set(true);
    if (!root || !query) return;

    searching.set(true);
    try {
      const walk = await walkFiles(root, { maxFiles: MAX_FILES_TO_SEARCH });
      const found: FileMatches[] = [];
      let scanned = 0;
      for (const file of walk.files) {
        scanned++;
        let text: string;
        try {
          const stats = await fsOperation(file.url).stat();
          if (stats.size > MAX_FILE_SIZE_BYTES) continue;
          text = await fsOperation(file.url).readFile();
        } catch {
          continue; // unreadable or binary: skip it, don't fail the whole search
        }
        if (text.includes("\u0000")) continue; // binary
        try {
          const matches = searchText(text, query, {
            matchCase: matchCase.peek(),
            regex: regex.peek(),
          });
          if (matches.length)
            found.push({
              path: file.path,
              url: file.url,
              name: file.name,
              matches,
            });
        } catch (err) {
          // A bad pattern is a property of the search, not of any one file.
          errorMessage.set(err instanceof Error ? err.message : String(err));
          break;
        }
      }
      results.set(found);
      filesScanned.set(scanned);
      truncated.set(walk.truncated);
    } finally {
      searching.set(false);
    }
  }

  const summary = computed(() => {
    if (searching()) return "Searching…";
    if (errorMessage()) return "";
    if (!hasSearched()) return "Search every file in the open folder.";
    const total = results().reduce((n, f) => n + f.matches.length, 0);
    const files = results().length;
    const note = truncated() ? ` (stopped after ${filesScanned()} files)` : "";
    return total === 0
      ? `No matches in ${filesScanned()} files${note}`
      : `${total} match${total === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}${note}`;
  });

  const toggle = (
    label: string,
    title: string,
    sig: typeof matchCase,
  ): HTMLElement =>
    (
      <button
        type="button"
        class={computed(() => ({ "chip-toggle": true, on: sig() }))}
        title={title}
        aria-pressed={computed(() => String(sig()))}
        onClick={() => sig.update((v) => !v)}
      >
        {label}
      </button>
    ) as HTMLElement;

  const panel = (
    <section id="search-panel" class="sidebar-panel">
      <div class="panel-header">
        <strong class="panel-title">Search</strong>
      </div>
      <div class="search-toolbar">
        <input
          type="search"
          class="text-input"
          placeholder="Find in files"
          enterkeyhint="search"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          model={pattern}
          ref={(el: HTMLElement) => {
            inputEl = el as HTMLInputElement;
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") void runSearch();
          }}
        />
        <button
          type="button"
          class="icon-btn accent"
          title="Search"
          aria-label="Search"
          onClick={() => void runSearch()}
        >
          {icon("search", 20)}
        </button>
      </div>
      <div class="search-options">
        {toggle("Aa", "Match case", matchCase)}
        {toggle(".*", "Regular expression", regex)}
      </div>
      <div class="search-summary">{summary}</div>
      <Show when={() => !!errorMessage()}>
        <div class="search-error">{errorMessage}</div>
      </Show>
      <div class="search-results">
        <For each={results} key={(file: FileMatches) => file.url}>
          {(file: FileMatches) => (
            <div class="search-file-group">
              <div class="search-file-path">{file.path}</div>
              {file.matches.map((m) => (
                <button
                  type="button"
                  class="search-match"
                  onClick={() =>
                    options.onOpenMatch(file.url, file.name, m.line)
                  }
                >
                  <span class="search-match-line">{`${m.line}`}</span>
                  <span class="search-match-text">
                    {m.lineText.slice(Math.max(0, m.start - 30), m.start)}
                    <mark>{m.lineText.slice(m.start, m.end)}</mark>
                    {m.lineText.slice(m.end, m.end + 80)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </For>
      </div>
    </section>
  ) as SearchPanelElement;

  panel.focusInput = () => queueMicrotask(() => inputEl?.focus());
  return panel;
}
