import { computed } from "xtags";
import type { Child } from "xtags";
import { icon } from "@/components/icons";
import { formatCount } from "@/pypi/format";
import { canonicalName } from "@/pypi/format";
import type { PackagesModel } from "@/pypi/model";

/** Pieces shared by the three tabs. */

export const COMPILED_HINT =
  "Needs compiled code. It installs only if an Android build exists; otherwise bundle it at build time (python/requirements.txt).";

/** The small badge / button on the right of a package line: Install, Update, or Installed. */
export function ActionButton({
  model,
  name,
  onInstall,
}: {
  model: PackagesModel;
  name: string;
  onInstall?: () => void;
}): Node {
  const key = canonicalName(name);
  const have = computed(() => model.installedMap().get(key) ?? null);
  const update = computed(() => {
    const u = model.updates().get(key);
    return u?.update && u.latest ? u : null;
  });
  const label = computed(() =>
    update() ? "Update" : have() ? "Installed" : "Install",
  );
  return (
    <button
      type="button"
      class={computed(() => ({
        btn: true,
        "btn-small": true,
        "btn-primary": !have() || update() !== null,
      }))}
      disabled={computed(
        () => model.busy() || (have() !== null && update() === null),
      )}
      aria-label={computed(() =>
        update()
          ? `Update ${name} to ${update()!.latest}`
          : have()
            ? `${name} is installed`
            : `Install ${name}`,
      )}
      onClick={(e: Event) => {
        e.stopPropagation();
        if (update()) void model.updateOne(key);
        else if (onInstall) onInstall();
        else void model.install(name);
      }}
    >
      {label}
    </button>
  );
}

/** "Installed 13.0.0" / "13.0.0 → 13.7.1" tag, empty when not installed. */
export function InstalledBadge({
  model,
  name,
}: {
  model: PackagesModel;
  name: string;
}): Node {
  const key = canonicalName(name);
  const text = computed(() => {
    const v = model.installedMap().get(key);
    if (!v) return "";
    const u = model.updates().get(key);
    return u?.update && u.latest ? `${v} → ${u.latest}` : `installed ${v}`;
  });
  return (
    <span
      class={computed(() => ({
        tag: true,
        "tag-installed": true,
        "tag-update": !!model.updates().get(key)?.update,
        hidden: text() === "",
      }))}
    >
      {text}
    </span>
  );
}

export const downloadsLabel = (n: number): string =>
  n > 0 ? `${formatCount(n)}/month` : "";

export function EmptyState({
  iconName,
  title,
  children,
}: {
  iconName: "search" | "package" | "alert";
  title: Child;
  children?: Child;
}): Node {
  return (
    <div class="pkg-empty">
      {icon(iconName, 34)}
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
