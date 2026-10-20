import { h } from 'xtags';
import { icon } from './icons';

/** Icon for a tree row: folders get a folder, Python files a coloured tag, the rest a generic file. */
export function fileIcon(name: string, isDirectory: boolean): HTMLElement {
  if (isDirectory) return h('span', { class: 'file-icon file-icon-folder' }, icon('folder', 18)) as HTMLElement;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const label = { py: 'py', pyw: 'py', pyi: 'pi', json: '{}', html: '<>', htm: '<>', css: '#', md: 'md', txt: 'tx' }[ext];
  if (label) return h('span', { class: `file-icon file-icon-tag ext-${ext}` }, label) as HTMLElement;
  return h('span', { class: 'file-icon' }, icon('file', 18)) as HTMLElement;
}
