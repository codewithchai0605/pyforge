import { computed, h } from 'xtags';
import type { Settings } from '@/settings';
import type { RuntimeInfo } from '@/python/protocol';
import { customDialog } from './dialogs';
import { icon } from './icons';

function toggleRow(label: string, hint: string, sig: Settings['saveOnRun']): HTMLElement {
  return h(
    'label',
    { class: 'setting-row' },
    h('span', { class: 'setting-text' }, h('span', { class: 'setting-label' }, label), h('span', { class: 'setting-hint' }, hint)),
    h('input', { type: 'checkbox', class: 'switch', role: 'switch', model: sig }),
  ) as HTMLElement;
}

export function showSettings(settings: Settings, info: RuntimeInfo | null): Promise<unknown> {
  return customDialog((close) =>
    h(
      'div',
      { class: 'dialog dialog-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('h2', { class: 'dialog-title' }, 'Settings'),
      h(
        'div',
        { class: 'setting-row' },
        h('span', { class: 'setting-text' }, h('span', { class: 'setting-label' }, 'Editor font size'), h('span', { class: 'setting-hint', style: { fontSize: computed(() => `${settings.fontSize()}px`) } }, 'print("Hello")')),
        h(
          'span',
          { class: 'stepper' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Smaller', onClick: () => settings.fontSize.update((v) => Math.max(11, v - 1)) }, '−'),
          h('output', { class: 'stepper-value' }, computed(() => String(settings.fontSize()))),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Larger', onClick: () => settings.fontSize.update((v) => Math.min(26, v + 1)) }, icon('plus', 18)),
        ),
      ),
      toggleRow('Save before running', 'Writes all changed files first', settings.saveOnRun),
      toggleRow('Clear console on run', 'Start each run with an empty console', settings.clearConsoleOnRun),
      h(
        'div',
        { class: 'about' },
        h('strong', null, 'PyForge'),
        h('span', null, info ? `Python ${info.python}${info.abi ? ` · ${info.abi}` : ' · desktop preview'}` : 'Python runtime unavailable'),
      ),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close() }, 'Done')),
    ) as HTMLElement,
  );
}
