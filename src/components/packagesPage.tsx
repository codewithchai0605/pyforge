import { computed, watch } from "xtags";
import type { Router } from "@/navigation";
import { fsOperation } from "@/fileSystem";
import { defaultClipboardBackend } from "@/native/device";
import { PackagesModel } from "@/pypi/model";
import type { PyRuntime, RuntimeInfo } from "@/python/protocol";
import { pushBack } from "./backStack";
import { confirmDialog } from "./dialogs";
import { icon } from "./icons";
import { InstallTab } from "./packages/installTab";
import { InstalledTab } from "./packages/installedTab";
import { OperationCard } from "./packages/operationCard";
import { SearchTab } from "./packages/searchTab";
import { TabBar } from "./packages/tabBar";
import { Page } from "./page";
import { toast } from "./toast";

export interface PackagesPageProps {
  router: Router;
  runtime: PyRuntime;
  info: RuntimeInfo | null;
  /** The workspace folder (with a trailing "/"): where requirements.txt is read from and saved to. */
  workspaceUrl?: string;
}

const REQUIREMENTS = "requirements.txt";

/**
 * Packages: Install / Search / Installed tabs over one PackagesModel
 * (src/pypi/model.ts, which holds all the logic and is unit-tested), a
 * details sheet for reading about a package before installing it, and a
 * progress card for installs, updates and removals.
 */
export function PackagesPage({
  router,
  runtime,
  info,
  workspaceUrl,
}: PackagesPageProps): Node {
  const clipboard = defaultClipboardBackend();
  const model = new PackagesModel({
    pip: runtime.pip,
    toast: (message, kind) => toast(message, kind),
    confirm: (o) => confirmDialog(o),
    storage: safeStorage(),
    copy: (text) => clipboard.write(text),
    workspace: workspaceUrl
      ? {
          readRequirements: async () => {
            const file = fsOperation(workspaceUrl + REQUIREMENTS);
            return (await file.exists()) ? file.readFile("utf8") : null;
          },
          writeRequirements: async (text) => {
            const existing = fsOperation(workspaceUrl + REQUIREMENTS);
            if (await existing.exists()) await existing.writeFile(text);
            else {
              const created =
                await fsOperation(workspaceUrl).createFile(REQUIREMENTS);
              await fsOperation(created.url).writeFile(text);
            }
            return REQUIREMENTS;
          },
        }
      : undefined,
  });

  // The Back button while an operation card is up: cancel if it can be, dismiss when it is over, never leave the page mid-install.
  let releaseBack = (): void => {};
  model.onCardChange = (open) => {
    releaseBack();
    releaseBack = open
      ? pushBack(() =>
          model.op.peek() === "running"
            ? model.cancelOperation()
            : model.op.peek() === "cancelling"
              ? undefined
              : model.closeCard(),
        )
      : (): void => {};
  };
  const card = OperationCard({ model });

  // Re-read the installed list each time the page is shown (packages may have changed elsewhere).
  watch(
    () => router.stack().includes("packages"),
    (open) => void (open && model.onShown()),
    { defer: true },
  );

  const pythonLine = info
    ? `Python ${info.python}${info.abi ? ` · ${info.abi}` : " · desktop preview"}`
    : "Python is not available here";

  const actions = (
    <>
      <button
        type="button"
        class="icon-btn"
        title="Refresh"
        aria-label="Refresh"
        onClick={() => void model.refreshInstalled()}
      >
        {icon("refresh", 20)}
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => router.push("settings")}
      >
        {icon("settings", 20)}
      </button>
    </>
  );

  const show = (id: "install" | "search" | "installed") =>
    computed(() => ({ "pkg-panel": true, hidden: model.tab() !== id }));

  return (
    <Page
      route="packages"
      router={router}
      title="Packages"
      actions={actions}
      flush
    >
      <TabBar model={model} />
      <div class="pkg-scroll">
        <div class={show("install")}>
          <InstallTab model={model} pythonLine={pythonLine} />
        </div>
        <div class={show("search")}>
          <SearchTab model={model} />
        </div>
        <div class={show("installed")}>
          <InstalledTab model={model} />
        </div>
      </div>
      {card.el}
    </Page>
  );
}

function safeStorage():
  | { getItem(k: string): string | null; setItem(k: string, v: string): void }
  | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
