import { For, computed, h } from 'xtags';
import type { EditorManager, EditorFile } from '@/editorManager';
import { fileIcon } from './fileIcons';
import { icon } from './icons';

/** The visible face of EditorManager.activeFiles/activeFile. Owns no state of its own. */
export function createTabsBar(editorManager: EditorManager): HTMLElement {
  return h(
    'div',
    { id: 'tabs-bar', role: 'tablist' },
    h(For<EditorFile>, {
      each: editorManager.activeFiles,
      key: (file) => file.id,
      children: (file) => renderTab(editorManager, file),
    }),
  ) as HTMLElement;
}

function renderTab(editorManager: EditorManager, file: EditorFile): Node {
  const isActive = computed(() => editorManager.activeFile()?.id === file.id);
  const tab = h(
    'div',
    {
      role: 'tab',
      tabindex: 0,
      'aria-selected': computed(() => String(isActive())),
      class: computed(() => ({ tab: true, active: isActive() })),
      title: file.url ?? `${file.name} (not saved yet)`,
      onClick: () => editorManager.switchTo(file.id),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') editorManager.switchTo(file.id);
      },
    },
    fileIcon(file.name, false),
    h('span', { class: 'tab-name' }, file.name),
    h('span', { class: computed(() => ({ 'tab-dirty-dot': true, visible: file.dirty() })), title: 'Unsaved changes' }),
    h(
      'button',
      {
        type: 'button',
        class: 'tab-close',
        title: 'Close',
        'aria-label': `Close ${file.name}`,
        onClick: (e: Event) => {
          e.stopPropagation();
          editorManager.closeFile(file.id);
        },
      },
      icon('x', 14),
    ),
  ) as HTMLElement;
  // Keep the active tab in view when the bar scrolls horizontally.
  const scrollIntoView = (): void => tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  queueMicrotask(() => {
    if (editorManager.activeFile.peek()?.id === file.id) scrollIntoView();
  });
  return tab;
}
