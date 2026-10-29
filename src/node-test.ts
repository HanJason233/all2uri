import { invoke } from "@tauri-apps/api/core";
import type { ProxyNode, ProxyProtocol } from "./core/model/proxy-node.ts";
import { buildSingBoxTestProfile } from "./core/testing/sing-box.ts";

export type NodeTestKind = "tcping" | "url204" | "bandwidth" | "linkType" | "unlock";
type ConcurrencyMode = "count" | "percent";

export interface NodeTestEntry {
  id: string;
  name: string;
  server: string;
  port: number;
  protocol: ProxyProtocol;
  node: ProxyNode;
}

export interface NodeTestResultState {
  state: "running" | "done" | "error";
  result?: NodeTestResponse;
  error?: string;
}

export interface UnlockServiceResult {
  id: string;
  name: string;
  state: string;
  detail: string;
  ipRisk?: "low" | "high";
  statusCode?: number;
}

export interface NodeTestResponse {
  success: boolean;
  latencyMs?: number;
  latencyMinMs?: number;
  latencyMaxMs?: number;
  latencyJitterMs?: number;
  latencySamplesMs?: number[];
  downloadMbps?: number;
  downloadMaxMbps?: number;
  downloadJitterMbps?: number;
  downloadSamples?: Array<{ durationMs: number; mbps: number }>;
  statusCode?: number;
  linkType?: string;
  entryIps?: string[];
  exitIp?: string;
  cdnProvider?: string;
  unlock?: UnlockServiceResult[];
  error?: string;
}

export interface UnlockServiceDefinition {
  id: string;
  name: string;
  category: "network" | "ai" | "streaming" | "other";
}

interface TestSettings {
  oneClickTestKinds: NodeTestKind[];

  tcpingTimeoutMs: number;
  tcpingConcurrencyMode: ConcurrencyMode;
  tcpingConcurrency: number;
  tcpingAutoDeleteTimeoutNodes: boolean;

  url204: string;
  url204Backup: string;
  url204WarmupTimeoutMs: number;
  url204MeasurementTimeoutMs: number;
  url204ConcurrencyMode: ConcurrencyMode;
  url204Concurrency: number;
  url204AutoDeleteTimeoutNodes: boolean;

  bandwidthUrl: string;
  bandwidthDurationMs: number;
  bandwidthStreams: number;
  bandwidthConcurrencyMode: ConcurrencyMode;
  bandwidthConcurrency: number;
  bandwidthAutoDeleteLowSpeedNodes: boolean;
  bandwidthAutoDeleteThresholdMbps: number;

  linkTypeConcurrencyMode: ConcurrencyMode;
  linkTypeConcurrency: number;
  linkTypeAcceptDirect: boolean;
  linkTypeAcceptRelay: boolean;
  linkTypeAcceptCdnRelay: boolean;

  unlockConcurrencyMode: ConcurrencyMode;
  unlockConcurrency: number;
  unlockRequestConcurrency: number;
  unlockServiceTimeoutMs: number;
  unlockTestIds: string[];
}

export interface NodeTestController {
  getResult(entryId: string, kind: NodeTestKind): NodeTestResultState | undefined;
  clearResults(): void;
  getUnlockServices(): UnlockServiceDefinition[];
  isRunning(): boolean;
}

interface NodeTestUiOptions {
  getEntries: () => NodeTestEntry[];
  onResultsChanged: () => void;
  onDeleteEntries: (entryIds: string[]) => void;
  onTestStarted: (kind: NodeTestKind) => void;
}

const DEFAULT_204_URL = "https://www.google.com/generate_204";
const DEFAULT_204_BACKUP_URL = "https://www.gstatic.com/generate_204";
const DEFAULT_BANDWIDTH_URL = "https://speed.cloudflare.com/__down?bytes=25000000";
const SETTINGS_KEY = "all2uri.node-test-settings";
const SETTINGS_SCHEMA_VERSION = 3;
const TEST_KINDS: NodeTestKind[] = ["tcping", "url204", "bandwidth", "linkType", "unlock"];
const TEST_KIND_LABELS: Record<NodeTestKind, string> = {
  tcping: "TCPing",
  url204: "204 URL",
  bandwidth: "传输质量",
  linkType: "链路类型",
  unlock: "流媒体与 AI 解锁",
};
const UNLOCK_SERVICES: UnlockServiceDefinition[] = [
  { id: "google_cn", name: "Google \u9001\u4e2d\u68c0\u6d4b", category: "network" },
  { id: "chatgpt", name: "ChatGPT / OpenAI", category: "ai" },
  { id: "copilot", name: "Microsoft Copilot", category: "ai" },
  { id: "claude", name: "Claude", category: "ai" },
  { id: "gemini", name: "Google Gemini", category: "ai" },
  { id: "llama", name: "Meta Llama API", category: "ai" },
  { id: "perplexity", name: "Perplexity", category: "ai" },
  { id: "sora", name: "Sora", category: "ai" },
  { id: "grok", name: "Grok", category: "ai" },
  { id: "netflix", name: "Netflix", category: "streaming" },
  { id: "disney", name: "Disney+", category: "streaming" },
  { id: "bilibili", name: "\u54d4\u54e9\u54d4\u54e9\u6e2f\u6fb3\u53f0", category: "streaming" },
  { id: "dazn", name: "DAZN", category: "streaming" },
  { id: "abema", name: "AbemaTV", category: "streaming" },
  { id: "bahamut", name: "\u5df4\u54c8\u59c6\u7279\u52a8\u753b\u75af", category: "streaming" },
  { id: "max", name: "Max (HBO)", category: "streaming" },
  { id: "prime", name: "Prime Video", category: "streaming" },
  { id: "youtube", name: "YouTube Premium", category: "streaming" },
  { id: "tiktok", name: "TikTok", category: "streaming" },
  { id: "steam", name: "Steam \u5546\u5e97\u533a", category: "other" },
  { id: "spotify", name: "Spotify", category: "other" },
  { id: "wikipedia", name: "Wikipedia", category: "other" },
];
const LEGACY_DEFAULT_UNLOCK_IDS = [
  "google_cn", "chatgpt", "claude", "gemini", "netflix", "disney", "max", "prime",
  "youtube", "tiktok", "spotify", "wikipedia",
];
const DEFAULT_UNLOCK_IDS = UNLOCK_SERVICES.map(item => item.id);

const resultMap = new Map<string, Map<NodeTestKind, NodeTestResultState>>();
let testButtons: HTMLButtonElement[] = [];
let oneClickTestButton: HTMLButtonElement | null = null;
let hasOneClickTests = true;
let running = false;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function concurrencyMode(value: unknown): ConcurrencyMode {
  return value === "count" ? "count" : "percent";
}

function defaultSettings(): TestSettings {
  return {
    oneClickTestKinds: [...TEST_KINDS],
    tcpingTimeoutMs: 2_000,
    tcpingConcurrencyMode: "percent",
    tcpingConcurrency: 30,
    tcpingAutoDeleteTimeoutNodes: true,
    url204: DEFAULT_204_URL,
    url204Backup: DEFAULT_204_BACKUP_URL,
    url204WarmupTimeoutMs: 4_000,
    url204MeasurementTimeoutMs: 1_000,
    url204ConcurrencyMode: "percent",
    url204Concurrency: 30,
    url204AutoDeleteTimeoutNodes: true,
    bandwidthUrl: DEFAULT_BANDWIDTH_URL,
    bandwidthDurationMs: 3_000,
    bandwidthStreams: 4,
    bandwidthConcurrencyMode: "percent",
    bandwidthConcurrency: 10,
    bandwidthAutoDeleteLowSpeedNodes: true,
    bandwidthAutoDeleteThresholdMbps: 1,
    linkTypeConcurrencyMode: "percent",
    linkTypeConcurrency: 30,
    linkTypeAcceptDirect: true,
    linkTypeAcceptRelay: true,
    linkTypeAcceptCdnRelay: true,
    unlockConcurrencyMode: "percent",
    unlockConcurrency: 30,
    unlockRequestConcurrency: 4,
    unlockServiceTimeoutMs: 3_000,
    unlockTestIds: [...DEFAULT_UNLOCK_IDS],
  };
}

function loadSettings(): TestSettings {
  const fallback = defaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TestSettings> & Record<string, unknown>;
    const storedSettingsVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
    const legacyTimeout = parsed.timeoutMs;
    const legacyConcurrency = parsed.concurrency;
    const selectedIds = Array.isArray(parsed.unlockTestIds)
      ? parsed.unlockTestIds.filter((id): id is string => typeof id === "string" && UNLOCK_SERVICES.some(service => service.id === id))
      : fallback.unlockTestIds;
    const unlockTestIds = selectedIds.length === LEGACY_DEFAULT_UNLOCK_IDS.length
      && LEGACY_DEFAULT_UNLOCK_IDS.every(id => selectedIds.includes(id))
      ? [...DEFAULT_UNLOCK_IDS]
      : selectedIds.length ? selectedIds : [...DEFAULT_UNLOCK_IDS];
    if (storedSettingsVersion < 2) {
      // 仅迁移与旧默认值完全相同的字段，保留用户主动修改过的参数。
      if (parsed.tcpingTimeoutMs === 1_000) parsed.tcpingTimeoutMs = fallback.tcpingTimeoutMs;
      if (parsed.tcpingAutoDeleteTimeoutNodes === false) parsed.tcpingAutoDeleteTimeoutNodes = true;
      if (parsed.url204AutoDeleteTimeoutNodes === false) parsed.url204AutoDeleteTimeoutNodes = true;
      if (parsed.bandwidthConcurrencyMode === "percent" && parsed.bandwidthConcurrency === 3) {
        parsed.bandwidthConcurrency = fallback.bandwidthConcurrency;
      }
      if (parsed.bandwidthAutoDeleteLowSpeedNodes === false) parsed.bandwidthAutoDeleteLowSpeedNodes = true;
      if (parsed.bandwidthAutoDeleteThresholdMbps === 10) parsed.bandwidthAutoDeleteThresholdMbps = fallback.bandwidthAutoDeleteThresholdMbps;
      if (parsed.linkTypeConcurrencyMode === "count" && parsed.linkTypeConcurrency === 3) {
        parsed.linkTypeConcurrencyMode = fallback.linkTypeConcurrencyMode;
        parsed.linkTypeConcurrency = fallback.linkTypeConcurrency;
      }
      if (parsed.unlockConcurrencyMode === "count" && parsed.unlockConcurrency === 3) {
        parsed.unlockConcurrencyMode = fallback.unlockConcurrencyMode;
        parsed.unlockConcurrency = fallback.unlockConcurrency;
      }
      if (parsed.unlockServiceTimeoutMs === 12_000) parsed.unlockServiceTimeoutMs = fallback.unlockServiceTimeoutMs;
    }
    const savedBandwidthConcurrencyMode = concurrencyMode(parsed.bandwidthConcurrencyMode ?? fallback.bandwidthConcurrencyMode);
    const savedBandwidthConcurrencyMax = savedBandwidthConcurrencyMode === "percent" ? 100 : 3;
    const selectedTestKinds = Array.isArray(parsed.oneClickTestKinds)
      ? parsed.oneClickTestKinds.filter((kind): kind is NodeTestKind => typeof kind === "string" && TEST_KINDS.includes(kind as NodeTestKind))
      : fallback.oneClickTestKinds;
    const settings: TestSettings = {
      oneClickTestKinds: [...new Set(selectedTestKinds)],
      tcpingTimeoutMs: clampNumber(String(parsed.tcpingTimeoutMs ?? legacyTimeout ?? fallback.tcpingTimeoutMs), fallback.tcpingTimeoutMs, 500, 120_000),
      tcpingConcurrencyMode: concurrencyMode(parsed.tcpingConcurrencyMode ?? fallback.tcpingConcurrencyMode),
      tcpingConcurrency: clampNumber(String(parsed.tcpingConcurrency ?? legacyConcurrency ?? fallback.tcpingConcurrency), fallback.tcpingConcurrency, 1, 512),
      tcpingAutoDeleteTimeoutNodes: typeof parsed.tcpingAutoDeleteTimeoutNodes === "boolean" ? parsed.tcpingAutoDeleteTimeoutNodes : fallback.tcpingAutoDeleteTimeoutNodes,
      url204: typeof parsed.url204 === "string" && parsed.url204.trim() ? parsed.url204.trim() : fallback.url204,
      url204Backup: typeof parsed.url204Backup === "string" ? parsed.url204Backup.trim() : fallback.url204Backup,
      url204WarmupTimeoutMs: clampNumber(String(parsed.url204WarmupTimeoutMs ?? fallback.url204WarmupTimeoutMs), fallback.url204WarmupTimeoutMs, 1_000, 120_000),
      url204MeasurementTimeoutMs: clampNumber(String(parsed.url204MeasurementTimeoutMs ?? fallback.url204MeasurementTimeoutMs), fallback.url204MeasurementTimeoutMs, 1_000, 120_000),
      url204ConcurrencyMode: concurrencyMode(parsed.url204ConcurrencyMode ?? fallback.url204ConcurrencyMode),
      url204Concurrency: clampNumber(String(parsed.url204Concurrency ?? legacyConcurrency ?? fallback.url204Concurrency), fallback.url204Concurrency, 1, 512),
      url204AutoDeleteTimeoutNodes: typeof parsed.url204AutoDeleteTimeoutNodes === "boolean" ? parsed.url204AutoDeleteTimeoutNodes : fallback.url204AutoDeleteTimeoutNodes,
      bandwidthUrl: typeof parsed.bandwidthUrl === "string" && parsed.bandwidthUrl.trim() ? parsed.bandwidthUrl.trim() : fallback.bandwidthUrl,
      bandwidthDurationMs: clampNumber(String(parsed.bandwidthDurationMs ?? fallback.bandwidthDurationMs), fallback.bandwidthDurationMs, 1_000, 60_000),
      bandwidthStreams: clampNumber(String(parsed.bandwidthStreams ?? fallback.bandwidthStreams), fallback.bandwidthStreams, 1, 8),
      bandwidthConcurrencyMode: savedBandwidthConcurrencyMode,
      bandwidthConcurrency: clampNumber(String(parsed.bandwidthConcurrency ?? legacyConcurrency ?? fallback.bandwidthConcurrency), fallback.bandwidthConcurrency, 1, savedBandwidthConcurrencyMax),
      bandwidthAutoDeleteLowSpeedNodes: typeof parsed.bandwidthAutoDeleteLowSpeedNodes === "boolean" ? parsed.bandwidthAutoDeleteLowSpeedNodes : fallback.bandwidthAutoDeleteLowSpeedNodes,
      bandwidthAutoDeleteThresholdMbps: clampNumber(String(parsed.bandwidthAutoDeleteThresholdMbps ?? fallback.bandwidthAutoDeleteThresholdMbps), fallback.bandwidthAutoDeleteThresholdMbps, 1, 10_000),
      linkTypeConcurrencyMode: concurrencyMode(parsed.linkTypeConcurrencyMode ?? fallback.linkTypeConcurrencyMode),
      linkTypeConcurrency: clampNumber(String(parsed.linkTypeConcurrency ?? fallback.linkTypeConcurrency), fallback.linkTypeConcurrency, 1, 512),
      linkTypeAcceptDirect: typeof parsed.linkTypeAcceptDirect === "boolean" ? parsed.linkTypeAcceptDirect : fallback.linkTypeAcceptDirect,
      linkTypeAcceptRelay: typeof parsed.linkTypeAcceptRelay === "boolean" ? parsed.linkTypeAcceptRelay : fallback.linkTypeAcceptRelay,
      linkTypeAcceptCdnRelay: typeof parsed.linkTypeAcceptCdnRelay === "boolean" ? parsed.linkTypeAcceptCdnRelay : fallback.linkTypeAcceptCdnRelay,
      unlockConcurrencyMode: concurrencyMode(parsed.unlockConcurrencyMode ?? fallback.unlockConcurrencyMode),
      unlockConcurrency: clampNumber(String(parsed.unlockConcurrency ?? fallback.unlockConcurrency), fallback.unlockConcurrency, 1, 512),
      unlockRequestConcurrency: clampNumber(String(parsed.unlockRequestConcurrency ?? fallback.unlockRequestConcurrency), fallback.unlockRequestConcurrency, 1, 12),
      unlockServiceTimeoutMs: clampNumber(String(parsed.unlockServiceTimeoutMs ?? fallback.unlockServiceTimeoutMs), fallback.unlockServiceTimeoutMs, 1_000, 120_000),
      unlockTestIds,
    };
    if (storedSettingsVersion < SETTINGS_SCHEMA_VERSION) saveSettings(settings);
    return settings;
  } catch {
    return fallback;
  }
}

function saveSettings(settings: TestSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, schemaVersion: SETTINGS_SCHEMA_VERSION }));
  } catch {
    // Current session can continue without persistence.
  }
}

function kindLabel(kind: NodeTestKind): string {
  switch (kind) {
    case "tcping": return "TCPing";
    case "url204": return "204 URL";
    case "bandwidth": return "\u4f20\u8f93\u8d28\u91cf";
    case "linkType": return "\u94fe\u8def\u7c7b\u578b";
    case "unlock": return "\u6d41\u5a92\u4f53\u4e0e AI \u89e3\u9501";
  }
}

function unlockStateLabel(value: string): string {
  switch (value) {
    case "unlocked": return "\u652f\u6301";
    case "partial": return "\u90e8\u5206";
    case "blocked": return "\u53d7\u9650";
    case "warning": return "\u5f85\u786e\u8ba4";
    case "error": return "\u5931\u8d25";
    default: return value;
  }
}

function setResult(entryId: string, kind: NodeTestKind, value: NodeTestResultState): void {
  let entryResults = resultMap.get(entryId);
  if (!entryResults) {
    entryResults = new Map();
    resultMap.set(entryId, entryResults);
  }
  entryResults.set(kind, value);
}

function getResult(entryId: string, kind: NodeTestKind): NodeTestResultState | undefined {
  return resultMap.get(entryId)?.get(kind);
}

export function refreshNodeTestButtons(enabled: boolean): void {
  for (const button of testButtons) {
    button.disabled = !enabled || running;
  }
  if (oneClickTestButton) oneClickTestButton.disabled = !enabled || running || !hasOneClickTests;
}

export function nodeTestResultClass(state: NodeTestResultState | undefined): string {
  return state ? `state-${state.state}` : "state-idle";
}

export function nodeTestResultText(state: NodeTestResultState | undefined, kind: NodeTestKind): string {
  if (!state) return "\u2014";
  if (state.state === "running") return "\u6d4b\u8bd5\u4e2d";
  if (state.state === "error") return "\u5931\u8d25";
  const result = state.result;
  if (!result || !result.success) return "\u5931\u8d25";
  switch (kind) {
    case "tcping":
      return result.latencyMs === undefined ? "\u6210\u529f" : `${result.latencyMs} ms`;
    case "url204":
      return result.latencyMs === undefined ? "\u6210\u529f" : `${result.latencyMs} ms`;
    case "bandwidth": {
      if (result.downloadMbps === undefined) return "\u6210\u529f";
      const peak = result.downloadMaxMbps ?? result.downloadMbps;
      return `${result.downloadMbps.toFixed(1)}/${peak.toFixed(1)}M`;
    }
    case "linkType":
      if (result.linkType === "direct") return "\u76f4\u8fde";
      if (result.linkType === "cdn-relay") return "CDN";
      if (result.linkType === "relay") return "\u4e2d\u8f6c";
      return "\u672a\u77e5";
    case "unlock": {
      const services = result.unlock ?? [];
      const unlocked = services.filter(item => item.state === "unlocked").length;
      return `${unlocked}/${services.length}`;
    }
  }
}

export function nodeTestResultTitle(state: NodeTestResultState | undefined, kind: NodeTestKind): string {
  if (!state) return "";
  if (state.state === "running") return `${kindLabel(kind)} \u6d4b\u8bd5\u4e2d`;
  if (state.state === "error") return state.error ?? "\u6d4b\u8bd5\u5931\u8d25";
  const result = state.result;
  if (!result) return "";
  if (!result.success) return result.error ?? "\u6d4b\u8bd5\u5931\u8d25";
  switch (kind) {
    case "tcping":
      return `TCPing \u6210\u529f \u00b7 ${result.latencyMs ?? "?"} ms`;
    case "url204": {
      const samples = result.latencySamplesMs?.map(value => `${value} ms`).join(" / ") ?? "";
      const range = result.latencyMinMs === undefined || result.latencyMaxMs === undefined
        ? ""
        : ` \u00b7 ${result.latencyMinMs}\u2013${result.latencyMaxMs} ms`;
      const jitter = result.latencyJitterMs === undefined ? "" : ` \u00b7 \u76f8\u90bb\u6837\u672c\u5e73\u5747\u5dee ${result.latencyJitterMs.toFixed(1)} ms`;
      const series = samples ? `\n\u6837\u672c\uff1a${samples}` : "";
      return `HTTP ${result.statusCode ?? "?"} \u00b7 \u5e73\u5747 ${result.latencyMs ?? "?"} ms${range}${jitter}${series}`;
    }
    case "bandwidth": {
      const average = result.downloadMbps?.toFixed(2) ?? "?";
      const peak = result.downloadMaxMbps?.toFixed(2) ?? average;
      const jitter = result.downloadJitterMbps === undefined ? "" : ` \u00b7 \u6bcf\u79d2\u6ce2\u52a8 ${result.downloadJitterMbps.toFixed(2)} Mbps`;
      const samples = result.downloadSamples?.map(sample => `${sample.durationMs} ms: ${sample.mbps.toFixed(2)} Mbps`).join("\n") ?? "";
      return `\u5e73\u5747 ${average} Mbps \u00b7 \u5cf0\u503c ${peak} Mbps${jitter}${samples ? `\n\u9010\u79d2\uff1a\n${samples}` : ""}`;
    }
    case "linkType": {
      const label = result.linkType === "direct" ? "\u76f4\u8fde" : result.linkType === "cdn-relay" ? "CDN \u4e2d\u8f6c" : "\u666e\u901a\u4e2d\u8f6c";
      const provider = result.cdnProvider ? ` \u00b7 ${result.cdnProvider}` : "";
      const entry = result.entryIps?.length ? `\n\u5165\u53e3\uff1a${result.entryIps.join(", ")}` : "";
      const exit = result.exitIp ? `\n\u51fa\u53e3\uff1a${result.exitIp}` : "";
      return `${label}${provider}${entry}${exit}`;
    }
    case "unlock":
      return (result.unlock ?? []).map(item => `${item.name}\uff1a${unlockStateLabel(item.state)}`).join("\n");
  }
}

export function initNodeTestUi(options: NodeTestUiOptions): NodeTestController {
  testButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-node-test-kind]"));
  oneClickTestButton = byId<HTMLButtonElement>("node-test-all-button");
  const tcpingTimeout = byId<HTMLInputElement>("node-test-tcping-timeout");
  const tcpingConcurrency = byId<HTMLInputElement>("node-test-tcping-concurrency");
  const tcpingMode = byId<HTMLSelectElement>("node-test-tcping-concurrency-mode");
  const tcpingAutoDelete = byId<HTMLInputElement>("node-test-tcping-auto-delete");
  const url204 = byId<HTMLInputElement>("node-test-url204");
  const url204Backup = byId<HTMLInputElement>("node-test-url204-backup");
  const url204Warmup = byId<HTMLInputElement>("node-test-url204-warmup-timeout");
  const url204Measurement = byId<HTMLInputElement>("node-test-url204-measurement-timeout");
  const url204Concurrency = byId<HTMLInputElement>("node-test-url204-concurrency");
  const url204Mode = byId<HTMLSelectElement>("node-test-url204-concurrency-mode");
  const url204AutoDelete = byId<HTMLInputElement>("node-test-url204-auto-delete");
  const bandwidthUrl = byId<HTMLInputElement>("node-test-bandwidth-url");
  const bandwidthDuration = byId<HTMLInputElement>("node-test-bandwidth-duration");
  const bandwidthStreams = byId<HTMLInputElement>("node-test-bandwidth-streams");
  const bandwidthConcurrency = byId<HTMLInputElement>("node-test-bandwidth-concurrency");
  const bandwidthMode = byId<HTMLSelectElement>("node-test-bandwidth-concurrency-mode");
  const bandwidthAutoDelete = byId<HTMLInputElement>("node-test-bandwidth-auto-delete");
  const bandwidthThreshold = byId<HTMLInputElement>("node-test-bandwidth-threshold");
  const linkTypeConcurrency = byId<HTMLInputElement>("node-test-linktype-concurrency");
  const linkTypeMode = byId<HTMLSelectElement>("node-test-linktype-concurrency-mode");
  const linkTypeAcceptDirect = byId<HTMLInputElement>("node-test-linktype-accept-direct");
  const linkTypeAcceptRelay = byId<HTMLInputElement>("node-test-linktype-accept-relay");
  const linkTypeAcceptCdn = byId<HTMLInputElement>("node-test-linktype-accept-cdn");
  const unlockConcurrency = byId<HTMLInputElement>("node-test-unlock-concurrency");
  const unlockMode = byId<HTMLSelectElement>("node-test-unlock-concurrency-mode");
  const unlockRequestConcurrency = byId<HTMLInputElement>("node-test-unlock-request-concurrency");
  const unlockServiceTimeout = byId<HTMLInputElement>("node-test-service-timeout");
  const unlockServices = byId<HTMLDivElement>("node-test-unlock-services");
  const oneClickTestOptions = byId<HTMLDivElement>("node-test-one-click-options");
  const status = byId<HTMLSpanElement>("node-test-status");

  const syncBandwidthConcurrencyRange = () => {
    const max = bandwidthMode.value === "percent" ? 100 : 3;
    bandwidthConcurrency.max = String(max);
    const value = Number(bandwidthConcurrency.value);
    if (Number.isFinite(value) && value > max) bandwidthConcurrency.value = String(max);
  };

  const readSettings = (): TestSettings => {
    const selectedBandwidthConcurrencyMode = concurrencyMode(bandwidthMode.value);
    const selectedIds = Array.from(unlockServices.querySelectorAll<HTMLInputElement>("input[data-service-id]:checked"))
      .map(input => input.dataset.serviceId ?? "")
      .filter(Boolean);
    const selectedTestKinds = Array.from(oneClickTestOptions.querySelectorAll<HTMLInputElement>("input[data-one-click-test-kind]:checked"))
      .map(input => input.dataset.oneClickTestKind as NodeTestKind | undefined)
      .filter((kind): kind is NodeTestKind => kind !== undefined && TEST_KINDS.includes(kind));
    return {
      oneClickTestKinds: selectedTestKinds,
      tcpingTimeoutMs: clampNumber(tcpingTimeout.value, 2_000, 500, 120_000),
      tcpingConcurrencyMode: concurrencyMode(tcpingMode.value),
      tcpingConcurrency: clampNumber(tcpingConcurrency.value, 30, 1, 512),
      tcpingAutoDeleteTimeoutNodes: tcpingAutoDelete.checked,
      url204: url204.value.trim() || DEFAULT_204_URL,
      url204Backup: url204Backup.value.trim(),
      url204WarmupTimeoutMs: clampNumber(url204Warmup.value, 4_000, 1_000, 120_000),
      url204MeasurementTimeoutMs: clampNumber(url204Measurement.value, 1_000, 1_000, 120_000),
      url204ConcurrencyMode: concurrencyMode(url204Mode.value),
      url204Concurrency: clampNumber(url204Concurrency.value, 30, 1, 512),
      url204AutoDeleteTimeoutNodes: url204AutoDelete.checked,
      bandwidthUrl: bandwidthUrl.value.trim() || DEFAULT_BANDWIDTH_URL,
      bandwidthDurationMs: clampNumber(bandwidthDuration.value, 3_000, 1_000, 60_000),
      bandwidthStreams: clampNumber(bandwidthStreams.value, 4, 1, 8),
      bandwidthConcurrencyMode: selectedBandwidthConcurrencyMode,
      bandwidthConcurrency: clampNumber(bandwidthConcurrency.value, 10, 1, selectedBandwidthConcurrencyMode === "percent" ? 100 : 3),
      bandwidthAutoDeleteLowSpeedNodes: bandwidthAutoDelete.checked,
      bandwidthAutoDeleteThresholdMbps: clampNumber(bandwidthThreshold.value, 1, 1, 10_000),
      linkTypeConcurrencyMode: concurrencyMode(linkTypeMode.value),
      linkTypeConcurrency: clampNumber(linkTypeConcurrency.value, 30, 1, 512),
      linkTypeAcceptDirect: linkTypeAcceptDirect.checked,
      linkTypeAcceptRelay: linkTypeAcceptRelay.checked,
      linkTypeAcceptCdnRelay: linkTypeAcceptCdn.checked,
      unlockConcurrencyMode: concurrencyMode(unlockMode.value),
      unlockConcurrency: clampNumber(unlockConcurrency.value, 30, 1, 512),
      unlockRequestConcurrency: clampNumber(unlockRequestConcurrency.value, 4, 1, 12),
      unlockServiceTimeoutMs: clampNumber(unlockServiceTimeout.value, 3_000, 1_000, 120_000),
      unlockTestIds: selectedIds.length ? selectedIds : [...DEFAULT_UNLOCK_IDS],
    };
  };

  const persist = () => {
    const settings = readSettings();
    saveSettings(settings);
    hasOneClickTests = settings.oneClickTestKinds.length > 0;
    refreshNodeTestButtons(options.getEntries().length > 0);
    options.onResultsChanged();
  };

  const renderOneClickTestKinds = (selectedKinds: NodeTestKind[]) => {
    oneClickTestOptions.replaceChildren();
    for (const kind of TEST_KINDS) {
      const label = document.createElement("label");
      label.className = "test-service-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.oneClickTestKind = kind;
      input.checked = selectedKinds.includes(kind);
      input.addEventListener("change", persist);
      const text = document.createElement("span");
      text.textContent = TEST_KIND_LABELS[kind];
      label.append(input, text);
      oneClickTestOptions.append(label);
    }
    hasOneClickTests = selectedKinds.length > 0;
  };

  const renderUnlockServices = (selectedIds: string[]) => {
    unlockServices.replaceChildren();
    const categories = [
      ["network", "\u7f51\u7edc\u72b6\u6001"],
      ["ai", "AI \u670d\u52a1"],
      ["streaming", "\u6d41\u5a92\u4f53"],
      ["other", "\u5176\u4ed6\u670d\u52a1"],
    ] as const;
    for (const [category, title] of categories) {
      const services = UNLOCK_SERVICES.filter(service => service.category === category);
      if (!services.length) continue;
      const heading = document.createElement("strong");
      heading.className = "test-service-category";
      heading.textContent = title;
      unlockServices.append(heading);
      for (const service of services) {
        const label = document.createElement("label");
        label.className = "test-service-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.serviceId = service.id;
        input.checked = selectedIds.includes(service.id);
        input.addEventListener("change", persist);
        const text = document.createElement("span");
        text.textContent = service.name;
        label.append(input, text);
        unlockServices.append(label);
      }
    }
  };

  const applySettings = (settings: TestSettings) => {
    tcpingTimeout.value = String(settings.tcpingTimeoutMs);
    tcpingConcurrency.value = String(settings.tcpingConcurrency);
    tcpingMode.value = settings.tcpingConcurrencyMode;
    tcpingAutoDelete.checked = settings.tcpingAutoDeleteTimeoutNodes;
    url204.value = settings.url204;
    url204Backup.value = settings.url204Backup;
    url204Warmup.value = String(settings.url204WarmupTimeoutMs);
    url204Measurement.value = String(settings.url204MeasurementTimeoutMs);
    url204Concurrency.value = String(settings.url204Concurrency);
    url204Mode.value = settings.url204ConcurrencyMode;
    url204AutoDelete.checked = settings.url204AutoDeleteTimeoutNodes;
    bandwidthUrl.value = settings.bandwidthUrl;
    bandwidthDuration.value = String(settings.bandwidthDurationMs);
    bandwidthStreams.value = String(settings.bandwidthStreams);
    bandwidthConcurrency.value = String(settings.bandwidthConcurrency);
    bandwidthMode.value = settings.bandwidthConcurrencyMode;
    syncBandwidthConcurrencyRange();
    bandwidthAutoDelete.checked = settings.bandwidthAutoDeleteLowSpeedNodes;
    bandwidthThreshold.value = String(settings.bandwidthAutoDeleteThresholdMbps);
    linkTypeConcurrency.value = String(settings.linkTypeConcurrency);
    linkTypeMode.value = settings.linkTypeConcurrencyMode;
    linkTypeAcceptDirect.checked = settings.linkTypeAcceptDirect;
    linkTypeAcceptRelay.checked = settings.linkTypeAcceptRelay;
    linkTypeAcceptCdn.checked = settings.linkTypeAcceptCdnRelay;
    unlockConcurrency.value = String(settings.unlockConcurrency);
    unlockMode.value = settings.unlockConcurrencyMode;
    unlockRequestConcurrency.value = String(settings.unlockRequestConcurrency);
    unlockServiceTimeout.value = String(settings.unlockServiceTimeoutMs);
    renderOneClickTestKinds(settings.oneClickTestKinds);
    renderUnlockServices(settings.unlockTestIds);
  };

  applySettings(loadSettings());
  bandwidthMode.addEventListener("change", syncBandwidthConcurrencyRange);
  for (const input of [
    tcpingTimeout, tcpingConcurrency, tcpingMode, tcpingAutoDelete,
    url204, url204Backup, url204Warmup, url204Measurement, url204Concurrency, url204Mode, url204AutoDelete,
    bandwidthUrl, bandwidthDuration, bandwidthStreams, bandwidthConcurrency, bandwidthMode, bandwidthAutoDelete, bandwidthThreshold,
    linkTypeConcurrency, linkTypeMode, linkTypeAcceptDirect, linkTypeAcceptRelay, linkTypeAcceptCdn,
    unlockConcurrency, unlockMode, unlockRequestConcurrency, unlockServiceTimeout,
  ]) {
    input.addEventListener("change", persist);
  }

  const isTimeoutError = (state: NodeTestResultState): boolean => {
    const message = state.error ?? state.result?.error ?? "";
    return message.includes("\u8d85\u65f6");
  };

  const effectiveConcurrency = (mode: ConcurrencyMode, value: number, total: number, max: number): number => {
    const raw = mode === "percent" ? Math.ceil(total * value / 100) : value;
    return Math.min(max, Math.max(1, raw));
  };

  const runTest = async (kind: NodeTestKind, settingsOverride?: TestSettings, batch?: { index: number; total: number }): Promise<boolean> => {
    if (running) return false;
    const entries = options.getEntries();
    if (entries.length === 0) return false;
    const settings = settingsOverride ?? readSettings();
    if (!settingsOverride) saveSettings(settings);
    options.onTestStarted(kind);
    const concurrency = kind === "tcping"
      ? effectiveConcurrency(settings.tcpingConcurrencyMode, settings.tcpingConcurrency, entries.length, 32)
      : kind === "url204"
        ? effectiveConcurrency(settings.url204ConcurrencyMode, settings.url204Concurrency, entries.length, 32)
        : kind === "bandwidth"
          ? effectiveConcurrency(settings.bandwidthConcurrencyMode, settings.bandwidthConcurrency, entries.length, 3)
          : kind === "linkType"
            ? effectiveConcurrency(settings.linkTypeConcurrencyMode, settings.linkTypeConcurrency, entries.length, 32)
            : effectiveConcurrency(settings.unlockConcurrencyMode, settings.unlockConcurrency, entries.length, 32);

    running = true;
    refreshNodeTestButtons(true);
    status.textContent = batch
      ? `一键测试 ${batch.index}/${batch.total}：正在测试 ${kindLabel(kind)}`
      : `\u6b63\u5728\u6d4b\u8bd5 ${kindLabel(kind)}`;
    for (const entry of entries) {
      setResult(entry.id, kind, { state: "running" });
    }
    options.onResultsChanged();

    let nextIndex = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          const profile = kind === "tcping" ? undefined : buildSingBoxTestProfile(entry.node);
          if (kind !== "tcping" && !profile?.profile) {
            throw new Error(profile?.error ?? "\u65e0\u6cd5\u751f\u6210 sing-box \u914d\u7f6e");
          }
          const result = await invoke<NodeTestResponse>("run_node_test", {
            request: {
              server: entry.server,
              port: entry.port,
              kind,
              outbound: profile?.profile?.outbound ?? null,
              endpoint: profile?.profile?.endpoint ?? null,
              url: kind === "url204" ? settings.url204 : kind === "bandwidth" ? settings.bandwidthUrl : null,
              backupUrl: kind === "url204" ? settings.url204Backup : null,
              timeoutMs: kind === "tcping"
                ? settings.tcpingTimeoutMs
                : kind === "url204"
                  ? settings.url204MeasurementTimeoutMs
                  : kind === "bandwidth"
                    ? settings.bandwidthDurationMs + 6_000
                  : settings.unlockServiceTimeoutMs,
              warmupTimeoutMs: kind === "url204" ? settings.url204WarmupTimeoutMs : null,
              measurementTimeoutMs: kind === "url204" ? settings.url204MeasurementTimeoutMs : null,
              durationMs: kind === "bandwidth" ? settings.bandwidthDurationMs : null,
              bandwidthStreams: kind === "bandwidth" ? settings.bandwidthStreams : null,
              unlockServiceIds: kind === "unlock" ? settings.unlockTestIds : null,
              unlockRequestConcurrency: kind === "unlock" ? settings.unlockRequestConcurrency : null,
            },
          });
          if (kind === "linkType" && result.success) {
            const accepted = result.linkType === "direct"
              ? settings.linkTypeAcceptDirect
              : result.linkType === "cdn-relay"
                ? settings.linkTypeAcceptCdnRelay
                : settings.linkTypeAcceptRelay;
            if (!accepted) {
              result.success = false;
              result.error = "\u94fe\u8def\u7c7b\u578b\u4e0d\u5728\u5141\u8bb8\u8303\u56f4";
            }
          }
          setResult(entry.id, kind, {
            state: result.success ? "done" : "error",
            result,
            error: result.success ? undefined : result.error ?? "\u6d4b\u8bd5\u5931\u8d25",
          });
          if (result.success) succeeded++;
          else failed++;
        } catch (error) {
          setResult(entry.id, kind, { state: "error", error: errorMessage(error) });
          failed++;
        }
        completed++;
        status.textContent = batch
          ? `一键测试 ${batch.index}/${batch.total}：${kindLabel(kind)} ${completed}/${entries.length}`
          : `\u5df2\u5b8c\u6210 ${completed}/${entries.length}`;
        options.onResultsChanged();
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));

    const deleteIds: string[] = [];
    if (kind === "tcping" && settings.tcpingAutoDeleteTimeoutNodes
      || kind === "url204" && settings.url204AutoDeleteTimeoutNodes
      || kind === "bandwidth" && settings.bandwidthAutoDeleteLowSpeedNodes) {
      for (const entry of entries) {
        const state = getResult(entry.id, kind);
        if (!state) continue;
        const shouldDelete = kind === "bandwidth"
          ? state.state === "error" || (state.result?.downloadMbps ?? 0) < settings.bandwidthAutoDeleteThresholdMbps
          : isTimeoutError(state);
        if (shouldDelete) deleteIds.push(entry.id);
      }
    }
    if (deleteIds.length) options.onDeleteEntries(deleteIds);

    running = false;
    refreshNodeTestButtons(options.getEntries().length > 0);
    const deleted = deleteIds.length ? `\uff0c\u5df2\u5220\u9664 ${deleteIds.length} \u4e2a\u8282\u70b9` : "";
    status.textContent = batch
      ? `一键测试 ${batch.index}/${batch.total} 完成：成功 ${succeeded}，失败 ${failed}${deleted}`
      : `\u6d4b\u8bd5\u5b8c\u6210\uff1a\u6210\u529f ${succeeded}\uff0c\u5931\u8d25 ${failed}${deleted}`;
    options.onResultsChanged();
    return true;
  };

  for (const button of testButtons) {
    const kind = button.dataset.nodeTestKind as NodeTestKind | undefined;
    if (!kind || !TEST_KINDS.includes(kind)) continue;
    button.addEventListener("click", () => void runTest(kind));
  }
  oneClickTestButton.addEventListener("click", () => {
    void (async () => {
      if (running) return;
      const settings = readSettings();
      const selectedKinds = settings.oneClickTestKinds;
      if (!selectedKinds.length || options.getEntries().length === 0) return;
      saveSettings(settings);
      let completedKinds = 0;
      // 按设置中的项目顺序逐项执行，避免多个测试同时争用节点和网络。
      for (let index = 0; index < selectedKinds.length; index++) {
        const completed = await runTest(selectedKinds[index], settings, { index: index + 1, total: selectedKinds.length });
        if (!completed) break;
        completedKinds++;
      }
      status.textContent = `一键测试完成：执行 ${completedKinds}/${selectedKinds.length} 项`;
      options.onResultsChanged();
    })();
  });
  refreshNodeTestButtons(options.getEntries().length > 0);

  return {
    getResult,
    clearResults: () => resultMap.clear(),
    getUnlockServices: () => readSettings().unlockTestIds
      .map(id => UNLOCK_SERVICES.find(service => service.id === id))
      .filter((service): service is UnlockServiceDefinition => service !== undefined),
    isRunning: () => running,
  };
}
