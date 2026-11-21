// Build an installable Windows MSI from the directory produced by package.mjs.
// Runs on Windows only (requires the WiX 3 toolset: candle.exe / light.exe).
import { MSICreator } from "electron-wix-msi";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { signWindowsFile } from "./sign-windows.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const release = path.join(root, "release");
const pkg = JSON.parse(await fs.readFile(path.join(root, "app/package.json"), "utf8"));

/** Packager output is Moonlight-win32-x64; never pick app.asar.unpacked. */
async function packagedAppDirectory() {
  const entries = await fs.readdir(release, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("Moonlight-")) continue;
    const dir = path.join(release, entry.name);
    if (dir.endsWith(".unpacked")) continue;
    try {
      await fs.access(path.join(dir, "moonlight.exe"));
      return dir;
    } catch { /* not the app dir */ }
  }
  throw new Error("找不到 package.mjs 生成的 Moonlight-win32-x64 目录（需先运行 package:windows）");
}

const appDirectory = await packagedAppDirectory();
const creator = new MSICreator({
  appDirectory,
  outputDirectory: release,
  exe: "moonlight.exe",
  name: "Moonlight",
  description: "Local-first paper library with layout-preserving translation",
  manufacturer: "Moonlight",
  version: pkg.version,
  appUserModelId: "io.moonlight.desktop",
  // Stable across releases so MSI upgrades replace a previous install.
  upgradeCode: "7C4A1F7E-3B62-4E2E-9F5A-2D9A7E6B1C33",
  arch: "x64",
  defaultInstallMode: "perMachine",
  ui: { chooseDirectory: true },
  shortcutName: "Moonlight",
});

await creator.create();
const { msiFile } = await creator.compile();
// The installer itself must be signed after WiX links it; the packaged exes
// were already signed by package.mjs before the ZIP/MSI inputs were built.
await signWindowsFile(msiFile);
const target = path.join(release, `Moonlight-${pkg.version}-windows-x64.msi`);
if (path.resolve(msiFile) !== path.resolve(target)) await fs.copyFile(msiFile, target);
const digest = createHash("sha256").update(await fs.readFile(target)).digest("hex");
await fs.writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
console.log(target);
