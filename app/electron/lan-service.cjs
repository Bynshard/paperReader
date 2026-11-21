/**
 * LAN / PWA pairing settings for the desktop sidecar.
 *
 * The tablet (vivo Pad 5 Pro) talks to the same Rust sidecar Electron uses, so
 * "pairing" is just: enable the HTTP listener, publish it on 0.0.0.0, and show
 * the LAN IPv4 URLs carrying the sidecar token.
 *
 * The pairing token is generated once, persisted in `<userData>/lan-service.json`
 * with mode 0600 and passed to the sidecar as `--serve-token <token>`.  It is
 * therefore stable across desktop restarts, so a PWA installed on the tablet
 * keeps working instead of hitting 401 after every restart.  Only an explicit
 * `save({ rotateToken: true })` replaces it; the token is never logged.
 *
 * Everything here is pure Node (no Electron imports) so it can be unit tested
 * with `node --test`.
 */
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 8765;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
/** 16 random bytes rendered as 32 lower-case hex characters. */
const TOKEN_BYTES = 16;

/**
 * Virtual adapters that are never reachable from the tablet and only confuse
 * the pairing list (Docker bridges, VM host-only networks, local tunnels).
 * `lo`/`loopback` are additionally filtered by the `internal` flag.
 * Tailscale (`tailscale*`) and ZeroTier (`zt*`) are intentionally allowed so
 * remote tablet access over a mesh VPN appears right in pairing URLs.
 */
const VIRTUAL_INTERFACE = /^(?:lo|docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|utun|wg|ham|pan)/i;

function validPort(value) {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/** A valid stored token is exactly 32 hex characters; anything else is replaced. */
function validToken(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) ? value.toLowerCase() : null;
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

/** Pairing URLs for every usable LAN IPv4 address, loopback excluded. */
function collectUrls(networkInterfaces, port, token) {
  const urls = [];
  const seen = new Set();
  let interfaces = {};
  try {
    interfaces = networkInterfaces() || {};
  } catch {
    interfaces = {};
  }
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const address of addresses || []) {
      if (!address || address.internal) continue;
      // Node < 18 reports `family: 4`, newer versions `family: "IPv4"`.
      const family = typeof address.family === "string" ? address.family : address.family === 4 ? "IPv4" : "";
      if (family !== "IPv4" || !address.address) continue;
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address.address)) continue;
      if (address.address.startsWith("127.") || address.address.startsWith("169.254.")) continue;
      const url = `http://${address.address}:${port}/${query}`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function createLanService({ file, networkInterfaces = os.networkInterfaces } = {}) {
  if (typeof file !== "string" || !file) throw new Error("lan-service 需要配置文件路径");
  // `token` is internal: only `startArgs` and the pairing URLs (built in
  // main.cjs from the sidecar's `serve_ready` event) ever see it.
  let settings = { enabled: false, port: DEFAULT_PORT, token: "" };

  /** Write `{enabled, port, token}` atomically with owner-only permissions. */
  async function persist(next) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
    // `rename` keeps the temp file's mode, but enforce it anyway in case an
    // older release left a world-readable file behind.
    await fs.chmod(file, 0o600);
    settings = next;
  }

  function publicSettings() {
    // Never hand the token to a generic summary caller: it is a credential.
    return { enabled: settings.enabled, port: settings.port };
  }

  return {
    summary() {
      return publicSettings();
    },

    /** Read `<userData>/lan-service.json`; corrupt or missing files keep defaults. */
    async load() {
      let saved = null;
      try {
        saved = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        saved = null;
      }
      if (!saved || typeof saved !== "object") {
        settings = { enabled: false, port: DEFAULT_PORT, token: "" };
        return publicSettings();
      }
      settings = {
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : false,
        port: validPort(saved.port) ?? DEFAULT_PORT,
        token: validToken(saved.token) ?? "",
      };
      if (settings.enabled && !settings.token) {
        // First run after the upgrade (or a hand-edited file): mint and persist
        // the stable token so `--serve-token` has something to pass.
        await persist({ ...settings, token: newToken() });
      }
      return publicSettings();
    },

    /**
     * Persist `{enabled, port}` (plus the token and optional rotation).
     * `rotateToken: true` mints a fresh 32-hex token, which invalidates every
     * previously installed PWA until it re-pairs with the new link.
     */
    async save(input = {}) {
      const enabled = typeof input.enabled === "boolean" ? input.enabled : settings.enabled;
      const port = input.port === undefined ? settings.port : validPort(input.port);
      if (port === null) throw new RangeError(`端口需为 ${MIN_PORT}–${MAX_PORT} 之间的整数`);
      const rotate = input && input.rotateToken === true;
      let token = rotate ? newToken() : settings.token;
      if (enabled && !token) token = newToken();
      if (!validToken(token)) token = newToken();
      await persist({ enabled, port, token });
      return { enabled, port };
    },

    /**
     * Extra argv appended to the Rust sidecar spawn.  Empty unless enabled, so
     * a disabled setting keeps the sidecar private to Electron IPC.  The token
     * is passed on argv (not an env dump/log) and never echoed to the console.
     */
    startArgs(distDir) {
      if (!settings.enabled) return [];
      const token = validToken(settings.token) ?? newToken();
      const args = ["--serve", `0.0.0.0:${settings.port}`, "--serve-token", token];
      if (typeof distDir === "string" && distDir) args.push("--static", distDir);
      return args;
    },

    enumerateUrls(port, token) {
      return collectUrls(networkInterfaces, port, token);
    },
  };
}

module.exports = { createLanService, collectUrls, newToken, validToken, DEFAULT_PORT, MIN_PORT, MAX_PORT };
