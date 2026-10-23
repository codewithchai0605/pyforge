import { icon } from "./icons";

const LABELS: Record<string, string> = {
  py: "py",
  pyw: "py",
  pyi: "pi",
  json: "{}",
  html: "<>",
  htm: "<>",
  css: "#",
  md: "md",
  txt: "tx",
  sh: "$_",
};

/** Icon for a tree row: folders get a folder, known types a coloured tag, the rest a generic file. */
export function fileIcon(name: string, isDirectory: boolean): HTMLElement {
  if (isDirectory) {
    return (
      <span class="file-icon file-icon-folder">{icon("folder", 18)}</span>
    ) as HTMLElement;
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const label = LABELS[ext];
  if (label)
    return (
      <span class={`file-icon file-icon-tag ext-${ext}`}>{label}</span>
    ) as HTMLElement;
  return (<span class="file-icon">{icon("file", 18)}</span>) as HTMLElement;
}
