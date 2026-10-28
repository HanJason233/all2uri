import { invoke } from "@tauri-apps/api/core";
import type { ProxyNode, ProxyProtocol } from "./core/model/proxy-node.ts";
import { buildSingBoxTestProfile } from "./core/testing/sing-box.ts";

export type NodeTestKind = "tcping" | "url204" | "bandwidth" | "linkType" | "unlock";

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

interface UnlockServiceResult {
  id: string;
  name: string;
  state: string;
  detail: string;
  statusCode?: number;
}

interface NodeTestResponse {
  success: boolean;
  latencyMs?: number;
  downloadMbps?: number;
  statusCode?: number;
  linkType?: string;
  entryIps?: string[];
  exitIp?: string;
  cdnProvider?: string;
  unlock?: UnlockServiceResult[];
  error?: string;
}

interface TestSettings {
  timeoutMs: number;
  concurrency: number;
  url204: string;
  bandwidthUrl: string;
  bandwidthDurationMs: number;
}

export interface NodeTestController {
  getResult(entryId: string, kind: NodeTestKind): NodeTestResultState | undefined;
  isRunning(): boolean;
}

interface NodeTestUiOptions {
  getEntries: () => NodeTestEntry[];
  onResultsChanged: () => void;
}

const DEFAULT_204_URL = "https://www.google.com/generate_204";
const DEFAULT_BANDWIDTH_URL = "https://speed.cloudflare.com/__down?bytes=25000000";
const SETTINGS_KEY = "all2uri.node-test-settings";
const TEST_KINDS: NodeTestKind[] = ["tcping", "url204", "bandwidth", "linkType", "unlock"];

const resultMap = new Map<string, Map<NodeTestKind, NodeTestResultState>>();
let testButtons: HTMLButtonElement[] = [];
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

function defaultSettings(): TestSettings {
  return {
    timeoutMs: 10_000,
    concurrency: 3,
    url204: DEFAULT_204_URL,
    bandwidthUrl: DEFAULT_BANDWIDTH_URL,
    bandwidthDurationMs: 3_000,
  };
}

function loadSettings(): TestSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<TestSettings>;
    return {
      timeoutMs: clampNumber(String(parsed.timeoutMs ?? ""), 10_000, 1_000, 120_000),
      concurrency: clampNumber(String(parsed.concurrency ?? ""), 3, 1, 8),
      url204: typeof parsed.url204 === "string" && parsed.url204.trim() ? parsed.url204.trim() : DEFAULT_204_URL,
      bandwidthUrl: typeof parsed.bandwidthUrl === "string" && parsed.bandwidthUrl.trim() ? parsed.bandwidthUrl.trim() : DEFAULT_BANDWIDTH_URL,
      bandwidthDurationMs: clampNumber(String(parsed.bandwidthDurationMs ?? ""), 3_000, 1_000, 60_000),
    };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings: TestSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 当前会话仍可使用内存中的测试参数。
  }
}

function kindLabel(kind: NodeTestKind): string {
  switch (kind) {
    case "tcping": return "TCPing";
    case "url204": return "204 URL";
    case "bandwidth": return "\u5e26\u5bbd\u6d4b\u901f";
    case "linkType": return "\u94fe\u8def\u7c7b\u578b";
    case "unlock": return "\u6d41\u5a92\u4f53\u4e0e AI \u89e3\u9501";
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
      return result.statusCode === undefined ? "\u6210\u529f" : `${result.statusCode}`;
    case "bandwidth":
      return result.downloadMbps === undefined ? "\u6210\u529f" : `${result.downloadMbps.toFixed(1)}M`;
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
    case "url204":
      return `HTTP ${result.statusCode ?? "?"} \u00b7 ${result.latencyMs ?? "?"} ms`;
    case "bandwidth":
      return `\u4e0b\u8f7d ${result.downloadMbps?.toFixed(2) ?? "?"} Mbps`;
    case "linkType": {
      const label = result.linkType === "direct" ? "\u76f4\u8fde" : result.linkType === "cdn-relay" ? "CDN \u4e2d\u8f6c" : "\u666e\u901a\u4e2d\u8f6c";
      const provider = result.cdnProvider ? ` \u00b7 ${result.cdnProvider}` : "";
      const entry = result.entryIps?.length ? `\n\u5165\u53e3\uff1a${result.entryIps.join(", ")}` : "";
      const exit = result.exitIp ? `\n\u51fa\u53e3\uff1a${result.exitIp}` : "";
      return `${label}${provider}${entry}${exit}`;
    }
    case "unlock":
      return (result.unlock ?? []).map(item => `${item.name}\uff1a${item.state}`).join("\n");
  }
}

export function initNodeTestUi(options: NodeTestUiOptions): NodeTestController {
  testButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-node-test-kind]"));
  const timeoutInput = byId<HTMLInputElement>("node-test-timeout-ms");
  const concurrencyInput = byId<HTMLInputElement>("node-test-concurrency");
  const url204Input = byId<HTMLInputElement>("node-test-url204");
  const bandwidthUrlInput = byId<HTMLInputElement>("node-test-bandwidth-url");
  const durationInput = byId<HTMLInputElement>("node-test-bandwidth-duration");
  const status = byId<HTMLSpanElement>("node-test-status");

  const applySettings = (settings: TestSettings) => {
    timeoutInput.value = String(settings.timeoutMs);
    concurrencyInput.value = String(settings.concurrency);
    url204Input.value = settings.url204;
    bandwidthUrlInput.value = settings.bandwidthUrl;
    durationInput.value = String(settings.bandwidthDurationMs);
  };

  const readSettings = (): TestSettings => ({
    timeoutMs: clampNumber(timeoutInput.value, 10_000, 1_000, 120_000),
    concurrency: clampNumber(concurrencyInput.value, 3, 1, 8),
    url204: url204Input.value.trim() || DEFAULT_204_URL,
    bandwidthUrl: bandwidthUrlInput.value.trim() || DEFAULT_BANDWIDTH_URL,
    bandwidthDurationMs: clampNumber(durationInput.value, 3_000, 1_000, 60_000),
  });

  applySettings(loadSettings());
  const persist = () => saveSettings(readSettings());
  for (const input of [timeoutInput, concurrencyInput, url204Input, bandwidthUrlInput, durationInput]) {
    input.addEventListener("change", persist);
  }

  const runTest = async (kind: NodeTestKind) => {
    if (running) return;
    const entries = options.getEntries();
    if (entries.length === 0) return;
    const settings = readSettings();
    saveSettings(settings);
    running = true;
    refreshNodeTestButtons(true);
    status.textContent = `\u6b63\u5728\u6d4b\u8bd5 ${kindLabel(kind)}`;
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
              timeoutMs: settings.timeoutMs,
              durationMs: settings.bandwidthDurationMs,
            },
          });
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
        status.textContent = `\u5df2\u5b8c\u6210 ${completed}/${entries.length}`;
        options.onResultsChanged();
      }
    };

    await Promise.all(Array.from({ length: Math.min(settings.concurrency, entries.length) }, () => worker()));
    running = false;
    refreshNodeTestButtons(options.getEntries().length > 0);
    status.textContent = `\u6d4b\u8bd5\u5b8c\u6210\uff1a\u6210\u529f ${succeeded}\uff0c\u5931\u8d25 ${failed}`;
    options.onResultsChanged();
  };

  for (const button of testButtons) {
    const kind = button.dataset.nodeTestKind as NodeTestKind | undefined;
    if (!kind || !TEST_KINDS.includes(kind)) continue;
    button.addEventListener("click", () => void runTest(kind));
  }
  refreshNodeTestButtons(options.getEntries().length > 0);

  return {
    getResult,
    isRunning: () => running,
  };
}
