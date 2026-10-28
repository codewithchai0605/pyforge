/**
 * Copies everything a console or terminal has shown, so an error or a result
 * can be pasted into a message or a file. Shared by the run panel's Copy
 * button and the Terminal's "Copy all output".
 */
export async function copyOutput(
    text: string,
    clipboard: { write(text: string): Promise<void> },
    notify: (message: string, kind: "info" | "error" | "success") => void,
): Promise<boolean> {
    if (!text.trim()) {
        notify("Nothing to copy yet.", "info");
        return false;
    }
    try {
        await clipboard.write(text);
    } catch (e) {
        notify(e instanceof Error ? e.message : "Could not copy.", "error");
        return false;
    }
    const lines = text.split("\n").length;
    notify(`Copied ${lines} ${lines === 1 ? "line" : "lines"}`, "success");
    return true;
}