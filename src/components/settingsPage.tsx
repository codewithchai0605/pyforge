import { computed, type Signal } from "xtags";
import type { Router } from "@/navigation";
import type { RuntimeInfo } from "@/python/protocol";
import type { Settings } from "@/settings";
import { Page } from "./page";
import { icon } from "./icons";

function SwitchRow({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: Signal<boolean>;
}): Node {
  return (
    <label class="setting-row">
      <span class="setting-text">
        <span class="setting-label">{label}</span>
        <span class="setting-hint plain">{hint}</span>
      </span>
      <input type="checkbox" class="switch" role="switch" model={value} />
    </label>
  );
}

function StepperRow({
  label,
  hint,
  value,
  min,
  max,
  preview,
}: {
  label: string;
  hint?: string;
  value: Signal<number>;
  min: number;
  max: number;
  preview?: boolean;
}): Node {
  return (
    <div class="setting-row">
      <span class="setting-text">
        <span class="setting-label">{label}</span>
        {preview ? (
          <span
            class="setting-hint"
            style={{ fontSize: computed(() => `${value()}px`) }}
          >
            print("Hello")
          </span>
        ) : (
          <span class="setting-hint plain">{hint}</span>
        )}
      </span>
      <span class="stepper">
        <button
          type="button"
          class="icon-btn"
          aria-label={`Decrease ${label}`}
          onClick={() => value.update((v) => Math.max(min, v - 1))}
        >
          −
        </button>
        <output class="stepper-value">{computed(() => String(value()))}</output>
        <button
          type="button"
          class="icon-btn"
          aria-label={`Increase ${label}`}
          onClick={() => value.update((v) => Math.min(max, v + 1))}
        >
          {icon("plus", 18)}
        </button>
      </span>
    </div>
  );
}

export interface SettingsPageProps {
  router: Router;
  settings: Settings;
  info: RuntimeInfo | null;
}

/** Settings as a real page on the navigation stack: Back returns to wherever you opened it from. */
export function SettingsPage({
  router,
  settings,
  info,
}: SettingsPageProps): Node {
  return (
    <Page route="settings" router={router} title="Settings">
      <h2 class="section-title">Editor</h2>
      <div class="settings-group">
        <StepperRow
          label="Font size"
          value={settings.fontSize}
          min={11}
          max={26}
          preview
        />
        <SwitchRow
          label="Auto-save"
          hint="Save changed files a moment after you stop typing"
          value={settings.autoSave}
        />
      </div>
      <p class="muted settings-tip">
        Tip: pinch inside the editor to change the font size.
      </p>

      <h2 class="section-title">Running code</h2>
      <div class="settings-group">
        <SwitchRow
          label="Save before running"
          hint="Writes all changed files first"
          value={settings.saveOnRun}
        />
        <SwitchRow
          label="Clear console on run"
          hint="Start each run with an empty console"
          value={settings.clearConsoleOnRun}
        />
      </div>

      <h2 class="section-title">App</h2>
      <div class="settings-group">
        <SwitchRow
          label="Confirm before exit"
          hint="Ask when you press Back on the home screen. Unsaved changes are always asked about."
          value={settings.confirmOnExit}
        />
      </div>

      <h2 class="section-title">About</h2>
      <div class="about">
        <strong>PyForge</strong>
        <span>
          {info
            ? `Python ${info.python}${info.abi ? ` · ${info.abi}` : " · desktop preview"}`
            : "Python runtime unavailable"}
        </span>
      </div>
    </Page>
  );
}
