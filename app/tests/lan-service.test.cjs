const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLanService, collectUrls, newToken, validToken, DEFAULT_PORT } = require("../electron/lan-service.cjs");

const interfaces = {
  lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  eth0: [
    { family: "IPv4", internal: false, address: "192.168.1.23" },
    { family: "IPv6", internal: false, address: "fe80::1" },
  ],
  docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
  wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.99" }],
};

const TOKEN = /^[0-9a-f]{32}$/;

async function temporary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moonlight-lan-"));
  try {
    await run(path.join(dir, "lan-service.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function stored(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

test("defaults to a disabled service on port 8765 and persists changes", () =>
  temporary(async (file) => {
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    assert.deepEqual(await service.load(), { enabled: false, port: DEFAULT_PORT });
    assert.deepEqual(service.startArgs("/srv/app/dist"), []);

    assert.deepEqual(await service.save({ enabled: true, port: 9000 }), { enabled: true, port: 9000 });
    const saved = await stored(file);
    assert.equal(saved.enabled, true);
    assert.equal(saved.port, 9000);
    assert.match(saved.token, TOKEN, "enabling the LAN service must persist a 32-hex token");

    const restored = createLanService({ file, networkInterfaces: () => interfaces });
    assert.deepEqual(await restored.load(), { enabled: true, port: 9000 });
    assert.deepEqual(restored.summary(), { enabled: true, port: 9000 });
    assert.equal(restored.startArgs()[2], "--serve-token");
    assert.equal(restored.startArgs()[3], saved.token, "the persisted token must survive a desktop restart");
  }));

test("builds --serve/--static arguments with the persisted pairing token", () =>
  temporary(async (file) => {
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    await service.load();
    assert.deepEqual(service.startArgs("/srv/app/dist"), []);

    await service.save({ enabled: true, port: 8765 });
    const token = (await stored(file)).token;
    assert.deepEqual(service.startArgs("/srv/app/dist"), [
      "--serve",
      "0.0.0.0:8765",
      "--serve-token",
      token,
      "--static",
      "/srv/app/dist",
    ]);

    await service.save({ enabled: false });
    assert.deepEqual(service.startArgs("/srv/app/dist"), [], "a disabled service must not expose --serve");
  }));

test("keeps the token stable across saves and rotates it only on demand", () =>
  temporary(async (file) => {
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    await service.load();
    await service.save({ enabled: true, port: 8765 });
    const first = (await stored(file)).token;
    assert.match(first, TOKEN);

    await service.save({ enabled: true, port: 8765 });
    assert.equal((await stored(file)).token, first, "a plain save must not invalidate paired devices");

    assert.deepEqual(await service.save({ enabled: true, port: 8765, token: "attacker-supplied" }), {
      enabled: true,
      port: 8765,
    });
    assert.equal((await stored(file)).token, first, "the renderer cannot inject a token through save()");

    assert.deepEqual(await service.save({ enabled: true, port: 8765, rotateToken: true }), {
      enabled: true,
      port: 8765,
    });
    const rotated = (await stored(file)).token;
    assert.match(rotated, TOKEN);
    assert.notEqual(rotated, first, "rotateToken must mint a fresh secret");
    assert.equal(service.startArgs()[3], rotated, "the next spawn must use the rotated token");

    // The token is a credential: the generic summary/IPC surface never exposes it.
    assert.deepEqual(service.summary(), { enabled: true, port: 8765 });
    assert.equal(JSON.stringify(service.summary()).includes(rotated), false);
  }));

test("mints and persists a token for an enabled legacy settings file", () =>
  temporary(async (file) => {
    await fs.writeFile(file, JSON.stringify({ enabled: true, port: 8765 }), "utf8");
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    assert.deepEqual(await service.load(), { enabled: true, port: 8765 });
    const token = (await stored(file)).token;
    assert.match(token, TOKEN, "load must backfill a stable token before the sidecar spawns");
    assert.deepEqual(service.startArgs(), ["--serve", "0.0.0.0:8765", "--serve-token", token]);
  }));

test("stores the settings file with owner-only permissions", () =>
  temporary(async (file) => {
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    await service.load();
    await service.save({ enabled: true, port: 8765 });
    if (process.platform !== "win32") {
      const mode = (await fs.stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, `lan-service.json must be 0600, got 0${mode.toString(8)}`);
    }
  }));

test("rejects an invalid port and keeps the previous settings", () =>
  temporary(async (file) => {
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    await service.load();
    await assert.rejects(service.save({ enabled: true, port: 70000 }), /1024–65535/);
    await assert.rejects(service.save({ enabled: true, port: "abc" }), /1024–65535/);
    assert.deepEqual(service.summary(), { enabled: false, port: DEFAULT_PORT });
  }));

test("falls back to defaults for a corrupt settings file", () =>
  temporary(async (file) => {
    await fs.writeFile(file, "{not json", "utf8");
    const service = createLanService({ file, networkInterfaces: () => interfaces });
    assert.deepEqual(await service.load(), { enabled: false, port: DEFAULT_PORT });
  }));

test("token helpers emit and accept only 32 hex characters", () => {
  const token = newToken();
  assert.match(token, TOKEN);
  assert.equal(validToken(token), token);
  assert.equal(validToken(token.toUpperCase()), token, "upper-case input is normalised to lower case");
  assert.equal(validToken("short"), null);
  assert.equal(validToken("z".repeat(32)), null);
  assert.equal(validToken(`${token}0`), null);
  assert.equal(newToken() === newToken(), false, "tokens must be random");
});

test("enumerates LAN IPv4 pairing URLs and filters loopback/virtual adapters", () => {
  assert.deepEqual(collectUrls(() => interfaces, 8765, "tok"), [
    "http://192.168.1.23:8765/?token=tok",
    "http://192.168.1.99:8765/?token=tok",
  ]);
  assert.deepEqual(
    collectUrls(() => ({ lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] }), 8765, "tok"),
    [],
  );
  assert.deepEqual(
    collectUrls(() => ({ docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }] }), 8765, "tok"),
    [],
  );
  assert.deepEqual(
    collectUrls(() => ({ eth0: [{ family: 4, internal: false, address: "10.1.2.3" }] }), 8765, ""),
    ["http://10.1.2.3:8765/"],
  );
  assert.deepEqual(
    collectUrls(
      () => ({
        tailscale0: [{ family: "IPv4", internal: false, address: "100.64.0.2" }],
        zt0: [{ family: "IPv4", internal: false, address: "10.147.20.5" }],
      }),
      8765,
      "tok",
    ),
    [
      "http://100.64.0.2:8765/?token=tok",
      "http://10.147.20.5:8765/?token=tok",
    ],
  );

  const service = createLanService({ file: path.join(os.tmpdir(), "unused-lan.json"), networkInterfaces: () => interfaces });
  assert.deepEqual(service.enumerateUrls(8765, "tok"), [
    "http://192.168.1.23:8765/?token=tok",
    "http://192.168.1.99:8765/?token=tok",
  ]);
});
