import { For, computed } from "xtags";
import { customDialog } from "@/components/dialogs";
import { icon } from "@/components/icons";
import { CATEGORIES, type CatalogItem } from "@/pypi/catalog";
import type { PackagesModel } from "@/pypi/model";
import { ActionButton, COMPILED_HINT } from "../rows";
import { openDetailSheet } from "../detailSheet";

/**
 * Install tab: type a name (with an optional version), paste a requirements
 * list, or pick from the hand-picked catalogue by category. Tapping a card
 * opens its details first, so it can be read about before it is installed.
 */
export function InstallTab({
  model,
  pythonLine,
}: {
  model: PackagesModel;
  pythonLine: string;
}): Node {
  const Card = (item: CatalogItem): Node => (
    <div
      class="pkg-card tap"
      role="button"
      tabindex={0}
      aria-label={`${item.name}: ${item.blurb}. Show details`}
      onClick={() => openDetailSheet(model, item.name, item.blurb)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetailSheet(model, item.name, item.blurb);
        }
      }}
    >
      <div class="pkg-card-text">
        <strong>{item.name}</strong>
        {item.compiled ? (
          <span class="tag" title={COMPILED_HINT}>
            compiled
          </span>
        ) : null}
        <span class="pkg-blurb">{item.blurb}</span>
      </div>
      <ActionButton model={model} name={item.name} />
    </div>
  );

  return (
    <section
      id="pkg-panel-install"
      role="tabpanel"
      aria-labelledby="pkg-tab-install"
    >
      <p class="runtime-line">{pythonLine}</p>

      <form
        class="install-bar"
        onSubmit={(e: Event) => {
          e.preventDefault();
          void model.submitInstallText();
        }}
      >
        <input
          type="text"
          class="text-input"
          placeholder="Package name, e.g. requests or rich>=13"
          aria-label="Package to install"
          aria-describedby="pkg-install-hint"
          enterkeyhint="go"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          model={model.installText}
        />
        <button
          type="submit"
          class="btn btn-primary"
          disabled={computed(
            () =>
              model.busy() ||
              model.installText().trim() === "" ||
              model.installProblem() !== null,
          )}
        >
          {icon("download", 18)}Install
        </button>
      </form>
      <p
        id="pkg-install-hint"
        class={computed(() => ({
          "pkg-hint": true,
          "pkg-hint-problem": model.installProblem() !== null,
        }))}
      >
        {computed(
          () =>
            model.installProblem() ??
            "Pin a version with ==, like rich==13.7.1. Not sure of the exact name? Use Search.",
        )}
      </p>

      <div class="pkg-actions">
        <button
          type="button"
          class="btn btn-small"
          onClick={() => void openRequirementsDialog(model)}
        >
          {icon("list", 16)}From requirements.txt
        </button>
        <button
          type="button"
          class="btn btn-small"
          onClick={() => model.setTab("search")}
        >
          {icon("search", 16)}Browse and search
        </button>
      </div>

      <h2 class="section-title">Recommended</h2>
      <div class="chip-row" role="group" aria-label="Category">
        <button
          type="button"
          class={computed(() => ({
            chip: true,
            active: model.category() === "all",
          }))}
          aria-pressed={computed(() => String(model.category() === "all"))}
          onClick={() => model.category.set("all")}
        >
          All
        </button>
        {CATEGORIES.map((c) => (
          <button
            type="button"
            class={computed(() => ({
              chip: true,
              active: model.category() === c.id,
            }))}
            aria-pressed={computed(() => String(model.category() === c.id))}
            onClick={() => model.category.set(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div class="pkg-grid">
        <For each={model.catalogView} key={(i: CatalogItem) => i.name}>
          {(item: CatalogItem) => Card(item)}
        </For>
      </div>
    </section>
  );
}

/** Paste a requirements list (or use the workspace's requirements.txt), see what will be installed, install it. */
export async function openRequirementsDialog(
  model: PackagesModel,
): Promise<void> {
  const specs = (await customDialog((close) => {
    const area = (
      <textarea
        class="dialog-input pkg-req-input"
        rows={8}
        placeholder={"requests>=2.31\nrich==13.7.1\n# one package per line"}
        aria-label="Requirements"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck={false}
      />
    ) as HTMLTextAreaElement;
    const summary = (
      <p class="pkg-req-summary" role="status" />
    ) as HTMLElement;
    const skipped = (<ul class="pkg-req-skipped" />) as HTMLElement;
    const useFile = (
      <button type="button" class="btn btn-small" hidden>
        Use the workspace's requirements.txt
      </button>
    ) as HTMLButtonElement;
    const go = (
      <button type="button" class="btn btn-primary" disabled>
        Install
      </button>
    ) as HTMLButtonElement;

    let parsed = model.previewRequirements("");
    const refresh = (): void => {
      parsed = model.previewRequirements(area.value);
      go.disabled = parsed.specs.length === 0 || model.busy.peek();
      go.textContent = parsed.specs.length
        ? `Install ${parsed.specs.length}`
        : "Install";
      summary.textContent = !area.value.trim()
        ? "Paste a requirements list, one package per line."
        : parsed.specs.length === 0
          ? "No installable packages found."
          : `${parsed.specs.length} ${parsed.specs.length === 1 ? "package" : "packages"} will be installed.`;
      skipped.replaceChildren(
        ...parsed.skipped.slice(0, 6).map((s) => {
          const li = document.createElement("li");
          li.textContent = `Line ${s.line}: ${s.text} — ${s.reason}`;
          return li;
        }),
      );
      if (parsed.skipped.length > 6) {
        const more = document.createElement("li");
        more.textContent = `…and ${parsed.skipped.length - 6} more skipped`;
        skipped.append(more);
      }
    };
    area.addEventListener("input", refresh);
    refresh();

    void model.workspaceRequirements().then((text) => {
      if (!text?.trim()) return;
      useFile.hidden = false;
      useFile.addEventListener("click", () => {
        area.value = text;
        refresh();
      });
    });

    go.addEventListener("click", () => close(parsed.specs));
    return (
      <div
        class="dialog dialog-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Install from requirements"
      >
        <h2 class="dialog-title">Install from requirements</h2>
        {area}
        {useFile}
        {summary}
        {skipped}
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={() => close(undefined)}>
            Cancel
          </button>
          {go}
        </div>
      </div>
    ) as HTMLElement;
  })) as string[] | undefined;
  if (specs?.length) await model.installRequirements(specs);
}
