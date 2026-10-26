import type { BufferLike } from "./types";

/** The whole buffer as plain text: wrapped rows are joined back into one line, trailing blank lines dropped. */
export function bufferText(buf: BufferLike): string {
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(!line.isWrapped);
        if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
        else lines.push(text);
    }
    return lines
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n+$/, "");
}