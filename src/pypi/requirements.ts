import type { InstalledPackage } from "@/python/protocol";

/**
 * Reading and writing `requirements.txt`.
 *
 * Only what the on-device installer can act on is accepted: a project name,
 * optional extras, optional version specifiers, optional environment marker.
 * Everything else (other files, URLs, VCS, local paths, pip options) is
 * reported as skipped with the reason, never silently dropped and never
 * passed on to be misread.
 */

export interface SkippedLine {
  /** 1-based line number in the text that was parsed. */
  line: number;
  text: string;
  reason: string;
}

export interface ParsedRequirements {
  specs: string[];
  skipped: SkippedLine[];
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/;
const EXTRAS = /^\s*\[[A-Za-z0-9._,\s-]*\]/;
const VERSION_PART =
  /^\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*/;

/** Why `line` can't be installed, or null if it is a plain requirement. */
function problem(line: string): string | null {
  if (/^-[a-zA-Z]|^--/.test(line)) {
    if (/^(-r|--requirement|-c|--constraint)\b/.test(line))
      return "Other requirement files aren't followed. Paste their contents too.";
    if (/^(-e|--editable)\b/.test(line))
      return "Editable installs aren't supported.";
    return "pip options aren't supported here.";
  }
  if (
    /^(git|hg|svn|bzr)\+|^[a-z][a-z0-9+.-]*:\/\//i.test(line) ||
    /^\.{0,2}\//.test(line)
  )
    return "Installing from a link or a path isn't supported. Use the package name.";
  const name = NAME.exec(line);
  if (!name) return "Doesn't look like a package name.";
  let rest = line.slice(name[0].length);
  const extras = EXTRAS.exec(rest);
  if (extras) rest = rest.slice(extras[0].length);
  rest = rest.replace(/^\s+/, "");
  if (rest.startsWith("@"))
    return "Installing from a link isn't supported. Use the package name.";
  const marker = rest.indexOf(";");
  const versions = marker >= 0 ? rest.slice(0, marker) : rest;
  if (versions.trim() === "") return null;
  const matched = VERSION_PART.exec(versions);
  if (!matched || matched[0].length !== versions.trimEnd().length)
    return "Couldn't read the version part.";
  return null;
}

export function parseRequirements(text: string): ParsedRequirements {
  const specs: string[] = [];
  const skipped: SkippedLine[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let pending = "";
  let startLine = 0;

  const handle = (raw: string, lineNo: number): void => {
    // `# comment` (a "#" at the start or after a space), pip-compile's `--hash=` tails.
    let line = raw
      .replace(/(^|\s)#.*$/, "")
      .replace(/\s+--hash=\S+/g, "")
      .trim();
    if (!line) return;
    const why = problem(line);
    if (why) {
      skipped.push({ line: lineNo, text: line, reason: why });
      return;
    }
    line = line.replace(/\s+/g, " ").replace(/\s*;\s*/, "; ");
    if (!seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase());
      specs.push(line);
    }
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const joined = pending ? `${pending} ${raw.trim()}` : raw;
    if (!pending) startLine = lineNo;
    if (/\\\s*$/.test(joined)) {
      pending = joined.replace(/\\\s*$/, "").trim();
      return;
    }
    pending = "";
    handle(joined, startLine);
  });
  if (pending) handle(pending, startLine);
  return { specs, skipped };
}

/** `name==version` lines for what was installed through the app (built-in packages come with the app, not from this file). */
export function formatRequirements(installed: InstalledPackage[]): string {
  const lines = installed
    .filter((p) => p.removable)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name}==${p.version}`);
  return lines.length
    ? `# Installed with PyForge\n${lines.join("\n")}\n`
    : "# Nothing installed with PyForge yet\n";
}

/** A friendly problem with text typed in the install box, or null when it can be tried. */
export function validateSpec(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (
    /\s/.test(t) &&
    !/^[A-Za-z0-9._-]+(\[[^\]]*\])?\s*(?:===|==|~=|!=|<=|>=|<|>)/.test(t)
  )
    return "That has spaces. Type one package name, or use the Search tab to find it.";
  const why = problem(t);
  return why;
}
