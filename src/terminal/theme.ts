import type { ITheme } from "@xterm/xterm";

/**
 * The terminal palette. Colours come from the app's CSS variables
 * (src/styles/variables.css, `--ansi-0..15`) so the terminal matches the old
 * console and the rest of the UI; the fallbacks are the same values, for
 * environments with no stylesheet (tests).
 */
const ANSI_FALLBACK = [
    "#5c6573",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
    "#7c8798",
    "#ff9aa2",
    "#b9f27c",
    "#ffd98a",
    "#9dbbff",
    "#d2b4ff",
    "#a8e6ff",
    "#ffffff",
];

const NAMES = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
] as const;

export function terminalTheme(root?: Element): ITheme {
    const read = (name: string, fallback: string): string => {
        try {
            const el = root ?? document.documentElement;
            return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
        } catch {
            return fallback;
        }
    };
    const theme: Record<string, string> = {
        background: read("--bg-sunken", "#0a0d12"),
        foreground: read("--text", "#e6edf3"),
        cursor: read("--accent", "#5aa2ff"),
        cursorAccent: read("--bg-sunken", "#0a0d12"),
        selectionBackground: "rgba(90, 162, 255, 0.38)",
        selectionInactiveBackground: "rgba(90, 162, 255, 0.22)",
    };
    NAMES.forEach((name, i) => {
        theme[name] = read(`--ansi-${i}`, ANSI_FALLBACK[i]!);
    });
    return theme as ITheme;
}