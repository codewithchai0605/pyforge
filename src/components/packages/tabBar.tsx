import { computed } from "xtags";
import type { PackagesModel, TabId } from "@/pypi/model";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "install", label: "Install" },
  { id: "search", label: "Search" },
  { id: "installed", label: "Installed" },
];

/** Install | Search | Installed. Installed shows how many, and a dot when updates are waiting. */
export function TabBar({ model }: { model: PackagesModel }): Node {
  return (
    <div class="pkg-tabs" role="tablist" aria-label="Packages">
      {TABS.map((t) => (
        <button
          type="button"
          role="tab"
          id={`pkg-tab-${t.id}`}
          class={computed(() => ({
            "pkg-tab": true,
            active: model.tab() === t.id,
          }))}
          aria-selected={computed(() => String(model.tab() === t.id))}
          aria-controls={`pkg-panel-${t.id}`}
          onClick={() => model.setTab(t.id)}
        >
          {t.label}
          {t.id === "installed" ? (
            <>
              <span class="count">
                {computed(() => String(model.removableCount()))}
              </span>
              <span
                class={computed(() => ({
                  "pkg-tab-dot": true,
                  hidden: model.updatable().length === 0,
                }))}
                title="Updates available"
                aria-label="Updates available"
              />
            </>
          ) : null}
        </button>
      ))}
    </div>
  );
}
