/**
 * A small hand-drawn icon set (24x24 grid, 2px strokes). Inline SVG instead of
 * emoji or an icon font: it renders identically on every Android WebView,
 * inherits `currentColor`, and costs no network or font loading.
 */
const PATHS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  play: "M8 5.5v13l11-6.5z",
  stop: "M7 7h10v10H7z",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  more: "M12 5.5h.01M12 12h.01M12 18.5h.01",
  folder:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  filePlus: "M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6",
  folderPlus:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v5M9.5 12.5h5",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  package: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  terminal: "M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M13 15h4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  refresh: "M20 11a8 8 0 1 0-2.3 6M20 4.5V11h-6.5",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  download: "M12 4v11M7 10.5l5 5 5-5M5 20h14",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  undo: "M9 7L4 12l5 5M4 12h9a6 6 0 0 1 0 12",
  redo: "M15 7l5 5-5 5M20 12h-9a6 6 0 0 0 0 12",
  keyboardDown:
    "M3 5h18v10H3zM9 19l3 2.5 3-2.5M7 9h.01M11 9h.01M15 9h.01M17 9h.01M8 12h8",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 4l9.5 16h-19zM12 10v4.5M12 17.5h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.5M12 7.5h.01",
  image: "M4 5h16v14H4zM8.5 10a1 1 0 1 0 0-.01M4 17l5-5 4 4 3-3 4 4",
  expand: "M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4",
  collapse: "M9 5v4H5M15 5v4h4M9 19v-4H5M15 19v-4h4",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  clear: "M4 7h16M8 7V5h8v2M7 7l1 12h8l1-12M10 11v5M14 11v5",
  dpad: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",
  hash: "M5 9h14M5 15h14M10 4L8 20M16 4l-2 16",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  logo: "M4 4h10v10H4zM10 10h10v10H10z",
  copy: "M9 9h10v11H9zM9 15H5V4h10v5",
  cut: "M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 15.5L19 3M16 15.5L5 3",
  paste:
    "M9 4h6v3H9zM8 5.5H6.5A1.5 1.5 0 0 0 5 7v12a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V7a1.5 1.5 0 0 0-1.5-1.5H16M9 12h6M9 16h4",
  selectAll:
    "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M8.5 9h7M8.5 12h7M8.5 15h4",
} as const;

export type IconName = keyof typeof PATHS;

/** Icons whose shape is meant to be a solid fill rather than an outline. */
const FILLED = new Set<IconName>(["play", "stop"]);

export function icon(name: IconName, size = 20): SVGElement {
  return (
    <svg
      class={`icon icon-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={name === "more" ? 3 : 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  ) as unknown as SVGElement;
}
