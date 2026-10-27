import { For, Show, computed } from "xtags";
import { icon } from "@/components/icons";
import { plural, timeAgo } from "@/pypi/format";
import type { PackagesModel } from "@/pypi/model";
import type { InstalledPackage } from "@/python/protocol";
import { openDetailSheet } from "../detailSheet";
import { EmptyState } from "../rows";

/**
 * Installed tab: filter, check for updates (and apply them), see what needs
 * what, remove, and export what you have as a requirements.txt.
 */
export function InstalledTab({ model }: { model: PackagesModel }): Node {
  const Row = (p: InstalledPackage): Node => {
    const update = computed(() => {
      const u = model.updates().get(p.name);
      return u?.update && u.latest ? u : null;
    });
    return (
      <li
        class="pkg-row tap"
        role="button"
        tabindex={0}
        aria-label={`${p.name} ${p.version}. Show details`}
        onClick={() => openDetailSheet(model, p.name, p.summary)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetailSheet(model, p.name, p.summary);
          }
        }}
      >
        <div class="pkg-row-text">
          <strong>{p.name}</strong>
          <span class="pkg-version">{p.version}</span>
          {p.removable ? null : (
            <span class="tag" title="Comes with PyForge; it can't be removed">
              built in
            </span>
          )}
          <span
            class={computed(() => ({
              tag: true,
              "tag-update": true,
              hidden: update() === null,
            }))}
          >
            {computed(() => (update() ? `→ ${update()!.latest}` : ""))}
          </span>
          <span class="pkg-blurb pkg-blurb-wrap">{p.summary}</span>
        </div>
        {p.removable ? (
          <>
            <button
              type="button"
              class={computed(() => ({
                btn: true,
                "btn-small": true,
                "btn-primary": true,
                hidden: update() === null,
              }))}
              disabled={computed(() => model.busy())}
              aria-label={`Update ${p.name}`}
              onClick={(e: Event) => {
                e.stopPropagation();
                void model.updateOne(p.name);
              }}
            >
              Update
            </button>
            <button
              type="button"
              class="icon-btn danger"
              title={`Uninstall ${p.name}`}
              aria-label={`Uninstall ${p.name}`}
              disabled={computed(() => model.busy())}
              onClick={(e: Event) => {
                e.stopPropagation();
                void model.uninstall(p.name);
              }}
            >
              {icon("trash", 20)}
            </button>
          </>
        ) : null}
      </li>
    );
  };

  const checkLabel = computed(() => {
    const c = model.checking();
    return c ? `Checking ${c.done}/${c.total}…` : "Check for updates";
  });

  return (
    <section
      id="pkg-panel-installed"
      role="tabpanel"
      aria-labelledby="pkg-tab-installed"
    >
      <div class="pkg-search">
        {icon("search", 18)}
        <input
          type="search"
          class="text-input pkg-search-input"
          placeholder="Filter installed packages"
          aria-label="Filter installed packages"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          model={model.installedFilter}
        />
        <button
          type="button"
          class={computed(() => ({
            "icon-btn": true,
            hidden: model.installedFilter() === "",
          }))}
          title="Clear"
          aria-label="Clear filter"
          onClick={() => model.installedFilter.set("")}
        >
          {icon("x", 18)}
        </button>
      </div>

      <div class="pkg-actions">
        {Show({
          when: () => model.checking() === null,
          children: (
            <button
              type="button"
              class="btn btn-small"
              disabled={computed(
                () => model.busy() || model.removableCount() === 0,
              )}
              onClick={() => void model.checkUpdates()}
            >
              {icon("refresh", 16)}
              {checkLabel}
            </button>
          ),
          fallback: (
            <button
              type="button"
              class="btn btn-small"
              onClick={() => model.cancelOperation()}
            >
              {icon("x", 16)}
              {checkLabel}
              <span class="pkg-cancel-hint">Stop</span>
            </button>
          ),
        })}
        <button
          type="button"
          class="btn btn-small"
          disabled={computed(() => model.removableCount() === 0)}
          onClick={() => void model.copyRequirements()}
        >
          {icon("copy", 16)}Copy requirements
        </button>
        <button
          type="button"
          class="btn btn-small"
          disabled={computed(() => model.removableCount() === 0)}
          onClick={() => void model.saveRequirements()}
        >
          {icon("save", 16)}Save requirements.txt
        </button>
      </div>

      {Show({
        when: () => model.updatable().length > 0,
        children: (
          <div class="pkg-banner update" role="status">
            {icon("download", 18)}
            <div>
              <strong>
                {computed(
                  () =>
                    plural(model.updatable().length, "update") + " available",
                )}
              </strong>
              <p>
                {computed(
                  () =>
                    model
                      .updatable()
                      .map((u) => u.name)
                      .slice(0, 4)
                      .join(", ") + (model.updatable().length > 4 ? "…" : ""),
                )}
              </p>
            </div>
            <button
              type="button"
              class="btn btn-primary btn-small"
              disabled={computed(() => model.busy())}
              onClick={() => void model.updateAll()}
            >
              Update all
            </button>
          </div>
        ),
      })}

      <p class="pkg-status" role="status">
        <span>
          {computed(() => {
            const t = model.lastChecked();
            return t
              ? `Updates last checked ${timeAgo(t / 1000)}`
              : "Updates not checked yet";
          })}
        </span>
      </p>

      {Show({
        when: () => model.builtinCount() > 0,
        children: (
          <label class="pkg-toggle">
            <input
              type="checkbox"
              checked={model.showBuiltin}
              onChange={(e: Event) =>
                model.showBuiltin.set((e.target as HTMLInputElement).checked)
              }
            />
            <span>
              Show built-in packages (
              {computed(() => String(model.builtinCount()))})
            </span>
          </label>
        ),
      })}

      <ul class="pkg-list">
        <For each={model.installedView} key={(p: InstalledPackage) => p.name}>
          {(p: InstalledPackage) => Row(p)}
        </For>
      </ul>

      {Show({
        when: () =>
          !model.loadingInstalled() && model.installedView().length === 0,
        children: (
          <EmptyState
            iconName="package"
            title={computed(() =>
              model.installedFilter().trim()
                ? "No installed package matches"
                : "Nothing installed yet",
            )}
          >
            {computed(() =>
              model.installedFilter().trim()
                ? "Clear the filter to see everything."
                : "Packages you install appear here, so you can update or remove them.",
            )}
          </EmptyState>
        ),
      })}

      {Show({
        when: () =>
          model.removableCount() === 0 &&
          !model.loadingInstalled() &&
          model.installedFilter().trim() === "",
        children: (
          <button
            type="button"
            class="btn btn-primary pkg-more"
            onClick={() => model.setTab("search")}
          >
            Find packages to install
          </button>
        ),
      })}
    </section>
  );
}
