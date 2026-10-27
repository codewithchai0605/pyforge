import { computed } from "xtags";
import { icon } from "@/components/icons";
import type { PackagesModel } from "@/pypi/model";

/** The progress card for installs, updates and removals (log, bar, cancel / close). */
export function OperationCard({ model }: { model: PackagesModel }): {
  el: Node;
} {
  const log = (
    <pre class="pip-log" aria-live="polite" aria-label="Details" />
  ) as HTMLElement;
  model.onLogReset = () => (log.textContent = "");
  model.onLog = (line) => {
    log.append(document.createTextNode(line + "\n"));
    log.scrollTop = log.scrollHeight;
  };
  const finished = computed(
    () => model.op() === "done" || model.op() === "failed",
  );
  const el = (
    <div
      class={computed(() => ({
        "progress-scrim": true,
        show: model.cardOpen(),
      }))}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pkg-card-title"
      aria-hidden={computed(() => String(!model.cardOpen()))}
    >
      <div class="progress-card">
        <h2 id="pkg-card-title" class="dialog-title">
          {model.cardTitle}
        </h2>
        <div
          class={computed(() => ({
            bar: true,
            indeterminate: model.cardPct() === null && !finished(),
          }))}
        >
          <div
            class="bar-fill"
            style={{
              width: computed(() =>
                finished()
                  ? "100%"
                  : model.cardPct() === null
                    ? "40%"
                    : `${model.cardPct()}%`,
              ),
              background: computed(() =>
                model.op() === "failed" ? "var(--danger)" : "",
              ),
            }}
          />
        </div>
        <p class="bar-caption">{model.cardFile}</p>
        {log}
        <p
          class={computed(() => ({
            "dialog-error": true,
            hidden: !model.cardError(),
          }))}
          role="alert"
        >
          {computed(() => model.cardError() ?? "")}
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class={computed(() => ({
              btn: true,
              hidden: finished() || !model.cancellable(),
            }))}
            disabled={computed(() => model.op() === "cancelling")}
            onClick={() => model.cancelOperation()}
          >
            {computed(() =>
              model.op() === "cancelling" ? "Stopping…" : "Cancel",
            )}
          </button>
          <button
            type="button"
            class={computed(() => ({
              btn: true,
              "btn-primary": true,
              hidden: !finished(),
            }))}
            onClick={() => model.closeCard()}
          >
            {icon("check", 18)}Done
          </button>
        </div>
      </div>
    </div>
  );
  return { el };
}
