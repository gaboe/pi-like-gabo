import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const PI_LENS_URL = "https://github.com/apmantza/pi-lens";
export const PI_LENS_INSTALL = "pi install git:github.com/apmantza/pi-lens";

export type CapabilityKind = "extension" | "skill" | "theme" | "tool" | "command" | "provider" | "dependency" | "optional" | "discovery";
export type CapabilityState = "registered" | "loaded" | "active" | "optional" | "degraded";
export type CollisionType = "declared-override" | "unintended-conflict";

export interface Diagnostic {
  code: string;
  message: string;
  remediation?: string;
}

export interface Collision {
  type: CollisionType;
  name: string;
  sources: string[];
}

export interface Provenance {
  owner: string;
  source: string;
  scope?: "user" | "project" | "temporary";
  origin?: "package" | "top-level";
}

export interface CapabilityRecord {
  id: string;
  kind: CapabilityKind;
  state: CapabilityState;
  provenance: Provenance;
  diagnostics: Diagnostic[];
  collisions: Collision[];
}

export interface PackageManifest {
  pi?: { extensions?: string[]; skills?: string[]; themes?: string[] };
}

export interface RuntimeCapability {
  name: string;
  sourceInfo: {
    source: string;
    path: string;
    scope?: "user" | "project" | "temporary";
    origin?: "package" | "top-level";
  };
  active?: boolean;
}

export interface RuntimeDiscovery {
  tools: RuntimeCapability[];
  commands: RuntimeCapability[];
}

function ownerFor(source: string): string {
  if (source.includes("vendor/pi-tools/")) return "pi-tools (vendored)";
  if (source.includes("vendor/pi-caveman/")) return "pi-caveman (pinned)";
  return "pi-like-gabo";
}

export function sanitizeSource(value: string): string {
  let clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const protocolRelative = clean.startsWith("//");
  try {
    const url = new URL(clean, protocolRelative ? "https://relative.invalid" : undefined);
    if (!protocolRelative && !/^[a-z][a-z\d+.-]*:/i.test(clean)) throw new Error("relative path");
    clean = `${protocolRelative ? "//" : `${url.protocol}//`}${url.host}${url.pathname}`;
  } catch {
    clean = clean.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/@]*@/i, "$1");
    clean = clean.replace(/^[^/\s@]+@([^/:\s]+[:/])/i, "$1");
    clean = clean.split(/[?#]/, 1)[0];
  }
  const home = homedir();
  return (home !== path.parse(home).root ? clean.replaceAll(home, "~") : clean).slice(0, 240);
}

function stableSourceId(source: string): string {
  const normalized = source.replaceAll("\\", "/").replace(/^\.\//, "");
  const knownRoot = normalized.match(/(?:^|\/)((?:extensions|skills|vendor)\/.*)$/);
  return knownRoot?.[1] ?? normalized;
}

function capabilityName(source: string): string {
  let pathname = source;
  try {
    pathname = new URL(source, source.startsWith("//") ? "https://relative.invalid" : undefined).pathname;
  } catch {}
  const normalized = pathname.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\.(?:ts|json)$/, "");
  const parts = normalized.split("/");
  return parts.at(-1) === "index" ? parts.at(-2) ?? "root" : parts.at(-1) || "root";
}

function provenance(input: RuntimeCapability["sourceInfo"], source: string): Provenance {
  return {
    owner: ownerFor(source),
    source,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  };
}

export function discoverManifestRecords(manifest: PackageManifest): CapabilityRecord[] {
  const groups = [
    ["extension", manifest.pi?.extensions ?? []],
    ["skill", manifest.pi?.skills ?? []],
    ["theme", manifest.pi?.themes ?? []],
  ] as const;
  return groups.flatMap(([kind, sources]) => sources.map((rawSource) => {
    const source = sanitizeSource(rawSource);
    return {
      id: `${kind}:${stableSourceId(source)}`,
      kind,
      state: "registered" as const,
      provenance: { owner: ownerFor(source), source },
      diagnostics: [{ code: "package-registered", message: `${capabilityName(source)} is declared; runtime activity is not implied.` }],
      collisions: [],
    };
  }));
}

export function discoverRuntimeRecords(runtime: RuntimeDiscovery): CapabilityRecord[] {
  const groups = [["tool", runtime.tools], ["command", runtime.commands]] as const;
  const records = groups.flatMap(([kind, items]) => items.map((item) => {
    const source = sanitizeSource(item.sourceInfo.source);
    const active = item.active !== false;
    return {
      id: `${kind}:${item.name}:${stableSourceId(source)}`,
      kind,
      state: active ? "active" as const : "loaded" as const,
      provenance: provenance(item.sourceInfo, source),
      diagnostics: [{ code: active ? "runtime-active" : "runtime-loaded", message: active ? `${kind} ${item.name} is callable in this session.` : `${kind} ${item.name} is loaded but inactive.` }],
      collisions: [],
    };
  }));
  return [...records, {
    id: "discovery:runtime-collisions",
    kind: "discovery",
    state: "degraded",
    provenance: { owner: "pi", source: "runtime-registry" },
    diagnostics: [{
      code: "collision-detection-unavailable",
      message: "Pi 0.82 runtime registries are post-deduplication/post-renaming; registration collision detection is unavailable.",
    }],
    collisions: [],
  }];
}

function executableAvailable(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      accessSync(path.join(directory, name), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function isPiLensPackageSource(value: string): boolean {
  const source = value.trim().toLowerCase();
  if (/^(?:npm:)?pi-lens(?:@[^/\s]+)?$/.test(source)) return true;
  return /^(?:git:)?(?:(?:https?|ssh):\/\/git@|(?:https?|ssh):\/\/|git@)?github\.com[/:]apmantza\/pi-lens(?:\.git)?(?:@[^/?#]+)?(?:[?#].*)?$/.test(source);
}

function settingsDeclarePiLens(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return Array.isArray(value.packages) && value.packages.some((item) => {
      const source = typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as Record<string, unknown>).source === "string"
          ? (item as { source: string }).source
          : "";
      return isPiLensPackageSource(source);
    });
  } catch {
    return false;
  }
}

export type PiLensDetection = "optional-absent" | "configured" | "present" | "malformed" | "unverifiable";

export interface PiLensProbeOptions {
  cwd: string;
  home?: string;
  runtimeSources?: string[];
  resolvePackage?: (specifier: string) => string;
  configFiles?: string[];
}

export interface PiLensProbe {
  state: "active" | "optional" | "degraded";
  detection: PiLensDetection;
  installed: boolean;
  extensionActive: boolean;
  configPresent: boolean;
  remediation: string;
}

function verifyPiLensPackage(entry: string): "present" | "unverifiable" {
  let directory = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest & { name?: unknown };
        const extensions = manifest.pi?.extensions;
        return manifest.name === "pi-lens" && Array.isArray(extensions) && extensions.some((item) => typeof item === "string")
          ? "present"
          : "unverifiable";
      } catch {
        return "unverifiable";
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "unverifiable";
    directory = parent;
  }
}

function probeConfigFiles(files: string[]): { detection: "configured" | "malformed" | "unverifiable" | "optional-absent"; present: boolean } {
  let configured = false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { detection: "malformed", present: true };
      configured = true;
    } catch (error) {
      return { detection: error instanceof SyntaxError ? "malformed" : "unverifiable", present: true };
    }
  }
  return configured ? { detection: "configured", present: true } : { detection: "optional-absent", present: false };
}

function findProjectLensConfigPath(cwd: string): string | undefined {
  let directory = path.resolve(cwd);
  while (true) {
    for (const name of [".pi-lens.json", "pi-lens.json"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function runtimeSourceIsPiLens(source: string): boolean {
  if (isPiLensPackageSource(source)) return true;
  const sanitized = sanitizeSource(source);
  if (sanitized.toLowerCase().split(/[\\/]/).includes("pi-lens")) return true;
  return existsSync(source) && verifyPiLensPackage(source) === "present";
}

export function detectPiLens(options: PiLensProbeOptions): PiLensProbe {
  const home = options.home ?? homedir();
  const extensionActive = (options.runtimeSources ?? []).some(runtimeSourceIsPiLens);
  let packageDetection: "present" | "optional-absent" | "unverifiable" = "optional-absent";
  try {
    const resolvePackage = options.resolvePackage ?? createRequire(path.join(options.cwd, "package.json")).resolve;
    packageDetection = verifyPiLensPackage(resolvePackage("pi-lens"));
  } catch {}

  const projectConfig = findProjectLensConfigPath(options.cwd);
  const configFiles = options.configFiles ?? [path.join(home, ".pi-lens", "config.json"), ...(projectConfig ? [projectConfig] : [])];
  const config = probeConfigFiles(configFiles);
  const settingsConfigured = settingsDeclarePiLens(path.join(home, ".pi", "agent", "settings.json"))
    || settingsDeclarePiLens(path.join(options.cwd, ".pi", "settings.json"));
  const configPresent = config.present || settingsConfigured;
  const detection: PiLensDetection = config.detection === "malformed" || config.detection === "unverifiable"
    ? config.detection
    : packageDetection === "unverifiable"
      ? "unverifiable"
      : extensionActive || packageDetection === "present"
        ? "present"
        : configPresent
          ? "configured"
          : "optional-absent";
  const installed = extensionActive || packageDetection === "present";

  if (detection === "malformed") return { state: "degraded", detection, installed, extensionActive, configPresent, remediation: "Fix or remove malformed pi-lens JSON config, then /reload." };
  if (detection === "unverifiable") return { state: "degraded", detection, installed, extensionActive, configPresent, remediation: "Verify pi-lens package metadata/config readability, then /reload." };
  if (extensionActive) return { state: "active", detection, installed, extensionActive, configPresent, remediation: "none" };
  if (detection === "present" || detection === "configured") return {
    state: "degraded",
    detection,
    installed,
    extensionActive,
    configPresent,
    remediation: detection === "configured" ? `${PI_LENS_INSTALL}, then /reload.` : "Run /reload to activate the installed pi-lens extension.",
  };
  return {
    state: "optional",
    detection,
    installed,
    extensionActive,
    configPresent,
    remediation: `${PI_LENS_INSTALL} (${PI_LENS_URL}), then /reload.`,
  };
}

export interface DiscoveryAdapters {
  manifest(): PackageManifest;
  runtime(): RuntimeDiscovery;
  provider(): { configured: boolean; name?: string };
  dependency(name: "fd" | "git" | "rg" | "firecrawl"): boolean;
  piLens(): PiLensProbe;
}

function degraded(id: string, kind: CapabilityKind, code: string, message: string, remediation: string): CapabilityRecord {
  return {
    id,
    kind,
    state: "degraded",
    provenance: { owner: "pi-doctor", source: "metadata-probe" },
    diagnostics: [{ code, message, remediation }],
    collisions: [],
  };
}

function probeRecord(id: string, kind: CapabilityKind, probe: () => boolean, remediation: string): CapabilityRecord {
  try {
    const available = probe();
    return {
      id,
      kind,
      state: available ? "active" : "degraded",
      provenance: { owner: "pi-doctor", source: "metadata-probe" },
      diagnostics: available
        ? [{ code: "probe-ok", message: `${id} metadata is available.` }]
        : [{ code: "probe-missing", message: `${id} metadata is unavailable.`, remediation }],
      collisions: [],
    };
  } catch {
    return degraded(id, kind, "probe-failed", `${id} metadata probe failed in isolation.`, remediation);
  }
}

export function collectCapabilityRecords(adapters: DiscoveryAdapters): CapabilityRecord[] {
  let manifestRecords: CapabilityRecord[];
  try {
    manifestRecords = discoverManifestRecords(adapters.manifest());
  } catch {
    manifestRecords = [degraded("discovery:manifest", "discovery", "manifest-failed", "Package manifest discovery failed in isolation.", "Check package.json readability and JSON syntax.")];
  }

  let runtimeRecords: CapabilityRecord[];
  try {
    runtimeRecords = discoverRuntimeRecords(adapters.runtime());
  } catch {
    runtimeRecords = [degraded("discovery:runtime", "discovery", "runtime-failed", "Runtime registry discovery failed in isolation.", "Run /reload; inspect extension load errors.")];
  }

  const runtimeSources = runtimeRecords.map((record) => stableSourceId(record.provenance.source));
  manifestRecords = manifestRecords.map((record) => {
    const source = stableSourceId(record.provenance.source);
    return runtimeSources.some((runtimeSource) => runtimeSource.includes(source) || source.includes(runtimeSource))
      ? { ...record, state: "loaded", diagnostics: [{ code: "runtime-loaded", message: "Package declaration has runtime provenance; activity depends on its registered surface." }] }
      : record;
  });

  let providerRecord: CapabilityRecord;
  try {
    const provider = adapters.provider();
    providerRecord = {
      id: "provider:selected",
      kind: "provider",
      state: provider.configured ? "active" : "degraded",
      provenance: { owner: "pi", source: "model-registry" },
      diagnostics: provider.configured
        ? [{ code: "provider-active", message: `Selected provider: ${sanitizeSource(provider.name ?? "configured")}.` }]
        : [{ code: "provider-missing", message: "No selected model provider.", remediation: "Select or configure a model provider." }],
      collisions: [],
    };
  } catch {
    providerRecord = degraded("provider:selected", "provider", "provider-probe-failed", "Provider metadata probe failed in isolation.", "Inspect model provider configuration.");
  }

  const dependencyRecords = (["fd", "git", "rg", "firecrawl"] as const).map((name) => probeRecord(
    `dependency:${name}`,
    name === "firecrawl" ? "provider" : "dependency",
    () => adapters.dependency(name),
    name === "firecrawl" ? "Set FIRECRAWL_API_KEY in ~/.pi/agent/.env or disable Firecrawl." : `Install ${name} or disable its capability.`,
  ));

  let lensRecord: CapabilityRecord;
  try {
    const lens = adapters.piLens();
    lensRecord = {
      id: "optional:pi-lens",
      kind: "optional",
      state: lens.state,
      provenance: { owner: "apmantza/pi-lens", source: PI_LENS_URL },
      diagnostics: [{
        code: `pi-lens-${lens.state}`,
        message: `detection=${lens.detection}; installed=${lens.installed}; extension=${lens.extensionActive}; config=${lens.configPresent}; separate failure domain`,
        ...(lens.remediation === "none" ? {} : { remediation: lens.remediation }),
      }],
      collisions: [],
    };
  } catch {
    lensRecord = degraded("optional:pi-lens", "optional", "pi-lens-probe-failed", "Optional pi-lens metadata probe failed in isolation; doctor remains available.", `${PI_LENS_INSTALL} (${PI_LENS_URL})`);
  }

  return [...manifestRecords, ...runtimeRecords, providerRecord, ...dependencyRecords, lensRecord]
    .sort((a, b) => a.id.localeCompare(b.id) || a.provenance.source.localeCompare(b.provenance.source));
}

export function createDiscoveryAdapters(
  pi: { getAllTools(): RuntimeCapability[]; getActiveTools(): string[]; getCommands(): RuntimeCapability[] },
  packageRoot: string,
  cwd: string,
  providerName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DiscoveryAdapters {
  let runtime: RuntimeDiscovery | undefined;
  const loadRuntime = () => {
    if (runtime) return runtime;
    const activeTools = new Set(pi.getActiveTools());
    runtime = {
      tools: pi.getAllTools().map((tool) => ({ ...tool, active: activeTools.has(tool.name) })),
      commands: pi.getCommands(),
    };
    return runtime;
  };
  return {
    manifest: () => JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageManifest,
    runtime: loadRuntime,
    provider: () => ({ configured: Boolean(providerName), ...(providerName ? { name: providerName } : {}) }),
    dependency: (name) => name === "firecrawl" ? Boolean(env.FIRECRAWL_API_KEY) : executableAvailable(name, env),
    piLens: () => {
      const current = loadRuntime();
      const runtimeSources = [...current.tools, ...current.commands].flatMap((item) => [item.sourceInfo.source, item.sourceInfo.path]);
      return detectPiLens({ cwd, runtimeSources });
    },
  };
}

export function formatDoctorReport(records: CapabilityRecord[]): string {
  const collisions = records.flatMap((record) => record.collisions);
  const uniqueCollisions = new Map(collisions.map((collision) => [`${collision.type}:${collision.name}`, collision]));
  const declared = [...uniqueCollisions.values()].filter(({ type }) => type === "declared-override").map(({ name }) => name).sort();
  const unintended = [...uniqueCollisions.values()].filter(({ type }) => type === "unintended-conflict").map(({ name }) => name).sort();
  return [
    "Pi Doctor (one-shot, read-only)",
    "permission mode: observe-only; audit classification only; never block/ask/deny",
    "trust boundary: trusted in-process policy; NOT an OS sandbox or process/filesystem/network boundary",
    "states: registered=manifest only; loaded=runtime provenance seen; active=callable/probe ready; degraded=isolated failure; optional=absent by choice",
    records.some((record) => record.diagnostics.some(({ code }) => code === "collision-detection-unavailable"))
      ? "collisions: runtime-detection=unavailable; manifest-raw-declarations=unavailable"
      : `collisions: declared-overrides=${declared.join(",") || "none"}; unintended-conflicts=${unintended.join(",") || "none"}`,
    ...records.map((record) => {
      const diagnostics = record.diagnostics.map((item) => `${item.code}:${item.message}${item.remediation ? ` remediation=${item.remediation}` : ""}`).join("; ");
      const recordCollisions = record.collisions.map((item) => `${item.type}:${item.name}`).join(",") || "none";
      return `- ${record.id} | kind=${record.kind} | state=${record.state} | owner=${record.provenance.owner} | source=${record.provenance.source} | diagnostics=${diagnostics} | collisions=${recordCollisions}`;
    }),
    "pi-lens: optional package, separate failure domain, no bundled LSP runtime or hard dependency",
    "doctor action: none; report never mutates or repairs",
  ].join("\n");
}
