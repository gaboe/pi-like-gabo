import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCapabilityRecords,
  detectPiLens,
  discoverManifestRecords,
  discoverRuntimeRecords,
  formatDoctorReport,
  PI_LENS_INSTALL,
  PI_LENS_URL,
} from "./doctor.ts";

const absentLens = { state: "optional", detection: "optional-absent", installed: false, extensionActive: false, configPresent: false, remediation: `${PI_LENS_INSTALL} (${PI_LENS_URL}), then /reload.` };

function adapters(overrides = {}) {
  return {
    manifest: () => ({ pi: { extensions: ["./extensions/z/index.ts", "./extensions/a/index.ts"] } }),
    runtime: () => ({ tools: [], commands: [] }),
    provider: () => ({ configured: true, name: "openai/test" }),
    dependency: () => true,
    piLens: () => absentLens,
    ...overrides,
  };
}

test("records and formatted output have stable deterministic ordering", () => {
  const records = collectCapabilityRecords(adapters());
  assert.deepEqual(records.map(({ id }) => id), [...records.map(({ id }) => id)].sort());
  assert.equal(formatDoctorReport(records), formatDoctorReport(records));
  assert.match(formatDoctorReport(records), /registered=manifest only; loaded=runtime provenance seen; active=callable/);
});

test("isolated discovery and optional probe failures degrade only their records", () => {
  const records = collectCapabilityRecords(adapters({
    manifest: () => { throw new Error("bad manifest"); },
    runtime: () => ({
      tools: [],
      commands: [{ name: "pi-doctor", sourceInfo: { source: "./extensions/pi-doctor/index.ts", path: "/repo/extensions/pi-doctor/index.ts" } }],
    }),
    piLens: () => { throw new Error("lens failed"); },
  }));

  assert.equal(records.find(({ id }) => id === "discovery:manifest")?.state, "degraded");
  assert.equal(records.find(({ id }) => id.startsWith("command:pi-doctor:"))?.state, "active");
  assert.equal(records.find(({ id }) => id === "optional:pi-lens")?.state, "degraded");
});

test("manifest loaded and runtime active remain distinct states", () => {
  const records = collectCapabilityRecords(adapters({
    manifest: () => ({ pi: { extensions: ["./extensions/pi-doctor/index.ts"] } }),
    runtime: () => ({ tools: [], commands: [{ name: "pi-doctor", sourceInfo: { source: "./extensions/pi-doctor/index.ts", path: "/repo/extensions/pi-doctor/index.ts" } }] }),
  }));
  assert.equal(records.find(({ kind }) => kind === "extension")?.state, "loaded");
  assert.equal(records.find(({ kind }) => kind === "command")?.state, "active");
  assert.equal(discoverRuntimeRecords({ tools: [{ name: "off", active: false, sourceInfo: { source: "off", path: "off" } }], commands: [] })[0].state, "loaded");
});

test("all source-derived fields strip relative and URL secrets before serialization", () => {
  const records = [
    ...discoverManifestRecords({ pi: { extensions: ["./x?token=SECRET"] } }),
    ...discoverRuntimeRecords({
      tools: [{
        name: "safe",
        sourceInfo: {
          source: "https://user:SECRET@example.test/x?q=SECRET#x",
          path: "/tmp/plugin.ts",
          scope: "project",
          origin: "package",
          token: "must-not-appear",
        },
      }],
      commands: [],
    }),
  ];
  const serialized = `${JSON.stringify(records)}\n${formatDoctorReport(records)}`;
  assert.match(serialized, /https:\/\/example\.test\/x/);
  for (const secret of ["SECRET", "user:", "?token", "?q=", "#x", "must-not-appear"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test("provider and dependency failures have isolated diagnostics", () => {
  const records = collectCapabilityRecords(adapters({
    provider: () => ({ configured: false }),
    dependency: (name) => {
      if (name === "rg") throw new Error("probe broke");
      return name !== "fd";
    },
  }));
  assert.equal(records.find(({ id }) => id === "provider:selected")?.state, "degraded");
  assert.equal(records.find(({ id }) => id === "dependency:fd")?.diagnostics[0].code, "probe-missing");
  assert.equal(records.find(({ id }) => id === "dependency:rg")?.diagnostics[0].code, "probe-failed");
  assert.equal(records.find(({ id }) => id === "dependency:git")?.state, "active");
});

test("post-dedupe Pi 0.82 runtime reports collision detection unavailable", () => {
  const base = (source) => ({ name: "same", sourceInfo: { source, path: source } });
  const records = discoverRuntimeRecords({ tools: [base("one"), base("two")], commands: [] });
  assert.ok(records.every(({ collisions }) => collisions.length === 0));
  assert.equal(
    records.find(({ id }) => id === "discovery:runtime-collisions")?.diagnostics[0].code,
    "collision-detection-unavailable",
  );
  assert.match(formatDoctorReport(records), /collisions: runtime-detection=unavailable; manifest-raw-declarations=unavailable/);
  assert.doesNotMatch(formatDoctorReport(records), /unintended-conflicts=none/);
});

test("pi-lens fixtures distinguish absent, configured, present, malformed, and unverifiable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "lens-"));
  const fixtures = path.join(import.meta.dirname, "fixtures", "pi-lens");
  const packageEntry = path.join(fixtures, "package", "dist", "index.js");
  const missing = detectPiLens({ cwd, home: cwd, configFiles: [], resolvePackage: () => { throw new Error("missing"); } });
  assert.equal(missing.state, "optional");
  assert.equal(missing.detection, "optional-absent");
  assert.equal(missing.remediation, `${PI_LENS_INSTALL} (${PI_LENS_URL}), then /reload.`);

  const configured = detectPiLens({ cwd, home: cwd, configFiles: [path.join(fixtures, "valid-global.json")], resolvePackage: () => { throw new Error("missing"); } });
  assert.equal(configured.state, "degraded");
  assert.equal(configured.detection, "configured");

  const present = detectPiLens({ cwd, home: cwd, configFiles: [], resolvePackage: () => packageEntry });
  assert.equal(present.state, "degraded");
  assert.equal(present.detection, "present");
  assert.equal(present.installed, true);

  const malformed = detectPiLens({ cwd, home: cwd, configFiles: [path.join(fixtures, "malformed-global.json")], resolvePackage: () => packageEntry });
  assert.equal(malformed.state, "degraded");
  assert.equal(malformed.detection, "malformed");

  const unverifiable = detectPiLens({ cwd, home: cwd, configFiles: [], resolvePackage: () => path.join(cwd, "unknown", "index.js") });
  assert.equal(unverifiable.detection, "unverifiable");

  const active = detectPiLens({ cwd, home: cwd, configFiles: [], runtimeSources: [packageEntry], resolvePackage: () => packageEntry });
  assert.equal(active.state, "active");
  assert.equal(active.detection, "present");

  const falsePositiveRuntime = detectPiLens({
    cwd,
    home: cwd,
    configFiles: [],
    runtimeSources: ["/plugins/not-pi-lens/index.js", "/plugins/pi-lens-extra/index.js"],
    resolvePackage: () => { throw new Error("missing"); },
  });
  assert.equal(falsePositiveRuntime.extensionActive, false);
  const exactRuntime = detectPiLens({ cwd, home: cwd, configFiles: [], runtimeSources: ["/plugins/pi-lens/index.js"], resolvePackage: () => { throw new Error("missing"); } });
  assert.equal(exactRuntime.extensionActive, true);

  const settingsHome = mkdtempSync(path.join(tmpdir(), "lens-settings-"));
  const settingsDir = path.join(settingsHome, ".pi", "agent");
  mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({
    packages: ["not-pi-lens", "npm:pi-lens-extra", "git:github.com/apmantza/not-pi-lens"],
    extensions: ["pi-lens"],
  }));
  const falsePositiveSettings = detectPiLens({ cwd, home: settingsHome, configFiles: [], resolvePackage: () => { throw new Error("missing"); } });
  assert.equal(falsePositiveSettings.detection, "optional-absent");
  writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "git:github.com/apmantza/pi-lens" }] }));
  const exactSettings = detectPiLens({ cwd, home: settingsHome, configFiles: [], resolvePackage: () => { throw new Error("missing"); } });
  assert.equal(exactSettings.detection, "configured");
});

test("root package pins, bundles, and activates pi-lens", () => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
  } catch (error) {
    assert.fail(`root package.json must be valid JSON: ${error}`);
  }
  assert.match(
    manifest.dependencies?.["pi-lens"],
    /^git\+https:\/\/github\.com\/gaboe\/pi-lens\.git#[0-9a-f]{40}$/,
  );
  assert.equal(
    (manifest.pi?.extensions ?? []).includes("./node_modules/pi-lens/dist/index.js"),
    true,
  );
  assert.equal((manifest.bundledDependencies ?? []).includes("pi-lens"), true);
  assert.equal((manifest.bundleDependencies ?? []).includes("pi-lens"), true);
});
