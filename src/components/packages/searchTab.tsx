import { For, Show, computed } from "xtags";
import { icon } from "@/components/icons";
import { timeAgo } from "@/pypi/format";
import type { Row, PackagesModel } from "@/pypi/model";
import { openDetailSheet } from "../detailSheet";
import {
  ActionButton,
  COMPILED_HINT,
  EmptyState,
  InstalledBadge,
  downloadsLabel,
} from "../rows";

/**
 * Search tab. Searching runs against a local copy of PyPI's most-downloaded
 * list (so it is instant and works offline once downloaded), topped up with the
 * catalogue (so "http" or "excel" find packages by what they do) and an exact
 * lookup for any name typed in full. Tapping a result shows its details and
 * whether it can run on this device, before anything is installed.
 */
export function SearchTab({ model }: { model: PackagesModel }): Node {
  const input = (
    <input
      type="search"
      class="text-input pkg-search-input"
      placeholder="Search packages, e.g. http, excel, requests"
      aria-label="Search packages"
      enterkeyhint="search"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck={false}
      value={model.query}
      onInput={(e: Event) =>
        model.setQuery((e.target as HTMLInputElement).value)
      }
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void model.submitSearch();
          (e.target as HTMLInputElement).blur(); // hide the keyboard so the results can be seen
        }
      }}
    />
  ) as HTMLInputElement;

  const status = computed(() => {
    const p = model.indexProgress();
    if (p)
      return p.total
        ? `Downloading package list… ${Math.round((p.done / p.total) * 100)}%`
        : "Downloading package list…";
    const i = model.index();
    if (!i) return "";
    if (!i.available)
      return "Package list not downloaded yet. It downloads on your first search (about 0.2 MB).";
    return `${i.count.toLocaleString()} popular packages · updated ${timeAgo(i.fetched)}`;
  });

  const heading = computed(() => {
    const q = model.query().trim();
    if (model.searching() && model.rows().length === 0) return "Searching…";
    if (!q) return "Popular this month";
    const n = model.total();
    return n === 0
      ? "No matches"
      : `${n.toLocaleString()} ${n === 1 ? "match" : "matches"}`;
  });

  const ResultRow = (r: Row): Node => (
    <li
      class="pkg-row tap"
      role="button"
      tabindex={0}
      aria-label={`${r.name}. Show details`}
      onClick={() => openDetailSheet(model, r.name, r.summary ?? "")}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetailSheet(model, r.name, r.summary ?? "");
        }
      }}
    >
      <div class="pkg-row-text">
        <strong>{r.name}</strong>
        {r.version ? <span class="pkg-version">{r.version}</span> : null}
        {r.compiled ? (
          <span class="tag" title={COMPILED_HINT}>
            compiled
          </span>
        ) : null}
        <InstalledBadge model={model} name={r.name} />
        <span class="pkg-blurb pkg-blurb-wrap">
          {r.summary ?? (r.catalog ? "" : "Tap for details")}
        </span>
        {r.downloads > 0 ? (
          <span class="pkg-meta">{downloadsLabel(r.downloads)}</span>
        ) : null}
        {r.match === "fuzzy" ? (
          <span class="pkg-meta">similar name</span>
        ) : null}
      </div>
      <ActionButton model={model} name={r.name} />
    </li>
  );

  return (
    <section
      id="pkg-panel-search"
      role="tabpanel"
      aria-labelledby="pkg-tab-search"
    >
      <div class="pkg-search">
        {icon("search", 18)}
        {input}
        <button
          type="button"
          class={computed(() => ({
            "icon-btn": true,
            hidden: model.query() === "",
          }))}
          title="Clear"
          aria-label="Clear search"
          onClick={() => {
            input.value = "";
            model.setQuery("");
            input.focus();
          }}
        >
          {icon("x", 18)}
        </button>
      </div>

      <p class="pkg-status" role="status">
        <span>{status}</span>
        <button
          type="button"
          class={computed(() => ({
            "pkg-link": true,
            hidden: !model.index()?.available || model.indexProgress() !== null,
          }))}
          disabled={computed(() => model.busy())}
          onClick={() => void model.refreshIndex()}
        >
          Refresh
        </button>
      </p>

      {Show({
        when: () => model.query().trim() === "" && model.recent().length > 0,
        children: (
          <div class="pkg-recent">
            <div class="pkg-recent-head">
              <span>Recent searches</span>
              <button
                type="button"
                class="pkg-link"
                onClick={() => model.clearRecent()}
              >
                Clear
              </button>
            </div>
            <div class="chip-row">
              <For each={model.recent} key={(r: string) => r}>
                {(r: string) => (
                  <button
                    type="button"
                    class="chip"
                    onClick={() => {
                      input.value = r;
                      void model.submitSearch(r);
                    }}
                  >
                    {r}
                  </button>
                )}
              </For>
            </div>
          </div>
        ),
      })}

      {Show({
        when: () => model.searchError() !== null,
        children: (
          <div class="pkg-banner warn" role="alert">
            {icon("alert", 18)}
            <div>
              <strong>Couldn't search the package list.</strong>
              <p>{computed(() => model.searchError() ?? "")}</p>
              <p>Matches from the recommended list are still shown.</p>
            </div>
            <button
              type="button"
              class="btn btn-small"
              onClick={() => void model.runSearch(model.query.peek())}
            >
              Retry
            </button>
          </div>
        ),
      })}

      {Show({
        when: () => model.exactCandidate() !== null,
        children: (
          <button
            type="button"
            class="pkg-lookup"
            onClick={() => {
              const q = model.exactCandidate.peek();
              if (q) openDetailSheet(model, q);
            }}
          >
            {icon("search", 18)}
            <span>
              Look up “
              <strong>{computed(() => model.exactCandidate() ?? "")}</strong>”
              on PyPI
            </span>
          </button>
        ),
      })}

      <h2 class="section-title">
        <span>{heading}</span>
      </h2>

      <ul
        class="pkg-list"
        aria-busy={computed(() => String(model.searching()))}
      >
        <For each={model.rows} key={(r: Row) => r.key}>
          {(r: Row) => ResultRow(r)}
        </For>
      </ul>

      {Show({
        when: () =>
          !model.searching() &&
          model.rows().length === 0 &&
          model.searchError() === null,
        children: (
          <EmptyState iconName="search" title="Nothing found">
            Try a shorter word, or what the package does ("excel", "http"). If
            you know the exact name, you can look it up above.
          </EmptyState>
        ),
      })}

      {Show({
        when: () => model.hasMore() && !model.searching(),
        children: (
          <button
            type="button"
            class="btn pkg-more"
            onClick={() => void model.loadMore()}
          >
            Show more
          </button>
        ),
      })}
    </section>
  );
}
