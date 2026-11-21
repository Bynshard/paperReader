// Optional Authenticode signing for the packaged Windows app and MSI.
//
// Enabled only when MOONLIGHT_SIGN_PFX (+ password) is present. CI decodes the
// base64 PFX secret into a runner-temp file and exports these variables; a local
// unsigned build simply skips this module. HSM/EV certificates that cannot be
// exported as PFX should use SignPath/Azure Trusted Signing instead.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

function signingConfig() {
  const pfx = process.env.MOONLIGHT_SIGN_PFX;
  const password = process.env.MOONLIGHT_SIGN_PFX_PASSWORD || "";
  if (!pfx) return null;
  return {
    pfx,
    password,
    signtool: process.env.MOONLIGHT_SIGNTOOL || "signtool.exe",
    timestamp: process.env.MOONLIGHT_SIGN_TIMESTAMP_URL || "http://timestamp.digicert.com",
  };
}

async function signOne(config, file) {
  try {
    await run(config.signtool, [
      "sign", "/fd", "sha256", "/td", "sha256",
      "/tr", config.timestamp,
      "/f", config.pfx, "/p", config.password,
      file,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    console.warn(`[sign] timestamped signing failed for ${path.basename(file)}, retrying without TSA: ${error.message}`);
    await run(config.signtool, [
      "sign", "/fd", "sha256",
      "/f", config.pfx, "/p", config.password,
      file,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  }
  console.log(`[sign] ${path.basename(file)}`);
}

async function collect(targets, dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "Code Cache") continue;
      await collect(targets, full);
    } else if (/\.(exe|dll)$/i.test(entry.name)) {
      targets.push(full);
    }
  }
  return targets;
}

/** Sign moonlight.exe + core (or every exe/dll when MOONLIGHT_SIGN_ALL=1). */
export async function signWindowsApp(appDirectory) {
  const config = signingConfig();
  if (!config) {
    console.log("[sign] MOONLIGHT_SIGN_PFX not set; leaving the Windows build unsigned");
    return { signed: 0, skipped: true };
  }
  await fs.access(config.pfx);
  const targets = [];
  if (process.env.MOONLIGHT_SIGN_ALL === "1") {
    await collect(targets, appDirectory);
  } else {
    const main = path.join(appDirectory, "moonlight.exe");
    const core = path.join(appDirectory, "resources", "bin", "moonlight-core.exe");
    for (const file of [main, core]) {
      try { await fs.access(file); targets.push(file); } catch { /* optional */ }
    }
  }
  if (!targets.length) throw new Error("没有找到可签名的 Windows 可执行文件");
  for (const file of targets) await signOne(config, file);
  return { signed: targets.length, skipped: false };
}

/** Sign the MSI after WiX produced it (must run before hashing). */
export async function signWindowsFile(file) {
  const config = signingConfig();
  if (!config) return false;
  await fs.access(config.pfx);
  await signOne(config, file);
  return true;
}
