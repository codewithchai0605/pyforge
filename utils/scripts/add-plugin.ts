import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = process.cwd();
const pluginsRoot = path.join(projectRoot, "src", "native-plugins");
const cordovaCli = path.join(projectRoot, "node_modules", "cordova", "bin", "cordova");

interface LocalPlugin {
  id: string;
  path: string;
}

async function findLocalPlugins(): Promise<LocalPlugin[]> {
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const plugins: LocalPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginPath = path.join(pluginsRoot, entry.name);
    const pluginXml = await readFile(path.join(pluginPath, "plugin.xml"), "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (pluginXml === null) continue;

    const id = pluginXml.match(/<plugin\b[^>]*\bid=["']([^"']+)["']/i)?.[1];
    if (!id) {
      throw new Error(`Could not find a plugin id in ${path.join(pluginPath, "plugin.xml")}`);
    }
    plugins.push({ id, path: pluginPath });
  }

  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

function runCordova(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(process.execPath, [cordovaCli, ...args], {
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "inherit"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`cordova ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function addNativePlugins(): Promise<void> {
  const plugins = await findLocalPlugins();
  if (plugins.length === 0) {
    console.log(`No local Cordova plugins found in ${path.relative(projectRoot, pluginsRoot)}.`);
    return;
  }

  const installedOutput = await runCordova(["plugin", "list"]);
  const installedIds = new Set(
    installedOutput
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([\w@.-]+)\s+\S+/)?.[1])
      .filter((id): id is string => Boolean(id)),
  );

  for (const plugin of plugins) {
    if (installedIds.has(plugin.id)) {
      console.log(`Already installed: ${plugin.id}`);
      continue;
    }
    console.log(`Adding ${plugin.id} from ${path.relative(projectRoot, plugin.path)}...`);
    await runCordova(["plugin", "add", plugin.path]);
  }
}

addNativePlugins().catch((error: unknown) => {
  console.error("Failed to add local Cordova plugins:", error);
  process.exitCode = 1;
});
