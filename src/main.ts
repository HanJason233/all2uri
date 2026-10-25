import jsQR from "jsqr";
import { invoke } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { detectSubscriptionInput } from "./core/subscription-import/index.ts";
import { convertSourcesInWorker } from "./core/worker-client.ts";
import { diagnostic } from "./core/diagnostics/index.ts";
import type { Diagnostic } from "./core/diagnostics/index.ts";
import type { ProxyProtocol } from "./core/model/proxy-node.ts";
import {
  countryCodeFromNodeName,
  countryNameForCode,
  DEFAULT_REGION_LOOKUP_METHODS,
  normalizeRegionCode,
  REGION_LOOKUP_OPTIONS,
  UNKNOWN_REGION_CODE,
} from "./core/location/region.ts";
import type { RegionLookupMethod } from "./core/location/region.ts";
import type { ConversionResult, SourceDocument } from "./core/pipeline.ts";

interface FetchedSubscription {
  content: string;
  finalUrl: string;
  contentType: string | null;
  subscriptionUserInfo: string | null;
  bytes: number;
  usedUserAgent: string;
}

interface FetchFailure {
  code?: string;
  message?: string;
  status?: number | null;
}

type SourceState = "pending" | "success" | "error";
type ProcessingState = "idle" | "running" | "done" | "warning" | "error";
interface CategorizedOutput {
  id: string;
  name: string;
  server: string;
  port: number;
  entryIps: string[] | null;
  protocol: ProxyProtocol;
  uri: string;
  countryCode: string | null;
  isCloudflare: boolean | null;
}

type CloudflareEntryFilter = "all" | "yes" | "no";

interface OutputFilter {
  protocols: ProxyProtocol[];
  countries: string[];
  cloudflareEntry: CloudflareEntryFilter;
}

type SourceKind = "local" | "remote";

interface SourceResult {
  sourceId: string;
  kind: SourceKind;
  url: string;
  state: SourceState;
  nodes: string[];
  content?: string;
  diagnostics: Diagnostic[];
  bytes?: number;
  finalUrl?: string;
  usedUserAgent?: string;
  errorCode?: string;
  errorMessage?: string;
}

const MIN_FETCH_CONCURRENCY = 1;
const MAX_FETCH_CONCURRENCY = 20;
const MAX_FETCH_CONCURRENCY_PERCENT = 100;
const MAX_REDIRECTS = 50;
const MAX_BATCH_INPUT_BYTES = 64 * 1024 * 1024;
const MIN_REMOTE_BATCH_BYTES = 1024 * 1024;
type FetchConcurrencyMode = "fixed" | "percent";

interface FetchConcurrencySetting {
  mode: FetchConcurrencyMode;
  value: number;
}

const OUTPUT_PROTOCOLS: Array<{ value: ProxyProtocol; label: string }> = [
  { value: "vless", label: "VLESS" },
  { value: "vmess", label: "VMess" },
  { value: "ss", label: "Shadowsocks" },
  { value: "trojan", label: "Trojan" },
  { value: "hysteria2", label: "Hysteria2" },
  { value: "tuic", label: "TUIC" },
  { value: "anytls", label: "AnyTLS" },
  { value: "socks5", label: "SOCKS5" },
  { value: "socks4", label: "SOCKS4" },
  { value: "socks4a", label: "SOCKS4a" },
  { value: "socks", label: "SOCKS" },
  { value: "wireguard", label: "WireGuard" },
  { value: "naive", label: "NaiveProxy" },
  { value: "masque", label: "MASQUE" },
];
const OUTPUT_FILTER_STORAGE_KEY = "all2uri.output-filter";
const OUTPUT_COLUMN_WIDTHS_STORAGE_KEY = "all2uri.output-column-widths";
const LEGACY_OUTPUT_COLUMN_RATIOS_STORAGE_KEY = "all2uri.output-column-ratios";
const REGION_LOOKUP_METHODS_STORAGE_KEY = "all2uri.region-lookup-methods";
const GEOIP_DATABASE_PATH_STORAGE_KEY = "all2uri.geoip-database-path";
const OUTPUT_COLUMN_DEFAULT_WIDTHS = [42, 84, 180, 180, 72, 100, 88, 74];
const OUTPUT_COLUMN_DEFAULT_TOTAL = OUTPUT_COLUMN_DEFAULT_WIDTHS.reduce((total, width) => total + width, 0);
const OUTPUT_COLUMN_MIN_WIDTH = 20;
const USER_AGENT_PRESETS: Record<string, string> = {
  nekobox: "NekoBox/Android/1.4.2 (Prefer ClashMeta Format)",
  "sing-box": "sing-box/1.15.0",
  clash: "clash-meta/1.19.0",
  v2rayn: "v2rayN/7.8.2",
};

class ConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

function getProtocolLabel(protocol: ProxyProtocol): string {
  return OUTPUT_PROTOCOLS.find(item => item.value === protocol)?.label ?? protocol.toUpperCase();
}

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === "string" && OUTPUT_PROTOCOLS.some(item => item.value === value);
}

function isRegionLookupMethod(value: unknown): value is RegionLookupMethod {
  return typeof value === "string" && REGION_LOOKUP_OPTIONS.some(item => item.value === value);
}

function loadRegionLookupMethods(): RegionLookupMethod[] {
  try {
    const stored = window.localStorage.getItem(REGION_LOOKUP_METHODS_STORAGE_KEY);
    if (stored === null) return [...DEFAULT_REGION_LOOKUP_METHODS];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? [...new Set(parsed.filter(isRegionLookupMethod))] : [...DEFAULT_REGION_LOOKUP_METHODS];
  } catch {
    return [...DEFAULT_REGION_LOOKUP_METHODS];
  }
}

function loadGeoIpDatabasePath(): string {
  try {
    return window.localStorage.getItem(GEOIP_DATABASE_PATH_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function loadOutputFilter(): OutputFilter {
  const empty = (): OutputFilter => ({ protocols: [], countries: [], cloudflareEntry: "all" });
  try {
    const stored = window.localStorage.getItem(OUTPUT_FILTER_STORAGE_KEY);
    if (stored === null) return empty();
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return empty();
    const candidate = parsed as Partial<OutputFilter> & { cloudflare?: unknown };
    const protocols = Array.isArray(candidate.protocols)
      ? [...new Set(candidate.protocols.filter(isProxyProtocol))]
      : [];
    const countries = Array.isArray(candidate.countries)
      ? [...new Set(candidate.countries.map(normalizeRegionCode).filter((code): code is string => code !== null))]
      : [];
    const cloudflareEntry: CloudflareEntryFilter =
      candidate.cloudflareEntry === "yes" || candidate.cloudflareEntry === "no" || candidate.cloudflareEntry === "all"
        ? candidate.cloudflareEntry
        : candidate.cloudflare === true ? "yes" : "all";
    return { protocols, countries, cloudflareEntry };
  } catch {
    return empty();
  }
}

function defaultOutputColumnWidths(): number[] {
  const targetWidth = Math.max(OUTPUT_COLUMN_DEFAULT_TOTAL, dom.outputTableWrap.clientWidth);
  const widths = OUTPUT_COLUMN_DEFAULT_WIDTHS.map(width => Math.round(width * targetWidth / OUTPUT_COLUMN_DEFAULT_TOTAL));
  widths[widths.length - 1] += targetWidth - widths.reduce((total, width) => total + width, 0);
  return widths;
}

function loadOutputColumnWidths(): number[] {
  try {
    const storedWidths = window.localStorage.getItem(OUTPUT_COLUMN_WIDTHS_STORAGE_KEY);
    if (storedWidths !== null) {
      const parsedWidths: unknown = JSON.parse(storedWidths);
      if (
        Array.isArray(parsedWidths)
        && parsedWidths.length === OUTPUT_COLUMN_DEFAULT_WIDTHS.length
        && parsedWidths.every(value => typeof value === "number" && Number.isFinite(value) && value > 0)
      ) return (parsedWidths as number[]).map(width => Math.max(OUTPUT_COLUMN_MIN_WIDTH, width));
    }

    // 兼容上一版按比例保存的列宽设置，并转换为像素宽度。
    const storedRatios = window.localStorage.getItem(LEGACY_OUTPUT_COLUMN_RATIOS_STORAGE_KEY);
    if (storedRatios === null) return defaultOutputColumnWidths();
    const parsed: unknown = JSON.parse(storedRatios);
    if (
      !Array.isArray(parsed)
      || parsed.length !== OUTPUT_COLUMN_DEFAULT_WIDTHS.length
      || !parsed.every(value => typeof value === "number" && Number.isFinite(value) && value > 0)
    ) return defaultOutputColumnWidths();
    const ratios = parsed as number[];
    const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
    if (total <= 0) return defaultOutputColumnWidths();
    const targetWidth = Math.max(OUTPUT_COLUMN_DEFAULT_TOTAL, dom.outputTableWrap.clientWidth);
    const widths = ratios.map(ratio => Math.round(ratio / total * targetWidth));
    widths[widths.length - 1] += targetWidth - widths.reduce((sum, width) => sum + width, 0);
    return widths.map(width => Math.max(OUTPUT_COLUMN_MIN_WIDTH, width));
  } catch {
    return defaultOutputColumnWidths();
  }
}

function saveOutputFilter() {
  try {
    window.localStorage.setItem(OUTPUT_FILTER_STORAGE_KEY, JSON.stringify(outputFilter));
  } catch {
    // 筛选条件仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

function saveOutputColumnWidths() {
  try {
    window.localStorage.setItem(OUTPUT_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(outputColumnWidths));
  } catch {
    // 列宽仍可在当前会话中调整；存储不可用时忽略持久化错误。
  }
}

function saveRegionLookupMethods() {
  try {
    window.localStorage.setItem(REGION_LOOKUP_METHODS_STORAGE_KEY, JSON.stringify(regionLookupMethods));
  } catch {
    // 查询规则仍可在当前会话中使用；存储不可用时忽略持久化错误。
  }
}

function updateRegionLookupMethods(methods: RegionLookupMethod[]) {
  regionLookupMethods = [...new Set(methods)];
  saveRegionLookupMethods();
  renderRegionLookupSettings();
  if (!running && outputEntries.length > 0) void enrichOutputRegions();
}

function renderRegionLookupSettings() {
  dom.regionLookupMethods.replaceChildren();
  const orderedOptions = [
    ...regionLookupMethods.map(method => REGION_LOOKUP_OPTIONS.find(option => option.value === method)!).filter(Boolean),
    ...REGION_LOOKUP_OPTIONS.filter(option => !regionLookupMethods.includes(option.value)),
  ];

  for (const option of orderedOptions) {
    const priority = regionLookupMethods.indexOf(option.value);
    const row = document.createElement("div");
    row.className = "region-lookup-method-row";

    const label = document.createElement("label");
    label.className = "region-lookup-method-label";
    label.title = option.description;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "settings-checkbox";
    checkbox.checked = priority >= 0;
    checkbox.setAttribute("aria-label", option.title);
    checkbox.addEventListener("change", () => {
      updateRegionLookupMethods(checkbox.checked
        ? [...regionLookupMethods, option.value]
        : regionLookupMethods.filter(method => method !== option.value));
    });

    const title = document.createElement("span");
    title.textContent = option.title;
    label.append(checkbox, title);

    const priorityLabel = document.createElement("span");
    priorityLabel.className = "region-lookup-priority";
    priorityLabel.textContent = priority >= 0 ? String(priority + 1) : "–";

    const moveUp = document.createElement("button");
    moveUp.className = "settings-link-button";
    moveUp.type = "button";
    moveUp.textContent = "↑";
    moveUp.disabled = priority <= 0;
    moveUp.setAttribute("aria-label", `提高${option.title}优先级`);
    moveUp.addEventListener("click", () => {
      if (priority <= 0) return;
      const methods = [...regionLookupMethods];
      [methods[priority - 1], methods[priority]] = [methods[priority], methods[priority - 1]];
      updateRegionLookupMethods(methods);
    });

    const moveDown = document.createElement("button");
    moveDown.className = "settings-link-button";
    moveDown.type = "button";
    moveDown.textContent = "↓";
    moveDown.disabled = priority < 0 || priority >= regionLookupMethods.length - 1;
    moveDown.setAttribute("aria-label", `降低${option.title}优先级`);
    moveDown.addEventListener("click", () => {
      if (priority < 0 || priority >= regionLookupMethods.length - 1) return;
      const methods = [...regionLookupMethods];
      [methods[priority], methods[priority + 1]] = [methods[priority + 1], methods[priority]];
      updateRegionLookupMethods(methods);
    });

    const controls = document.createElement("div");
    controls.className = "region-lookup-order-controls";
    controls.append(priorityLabel, moveUp, moveDown);
    row.append(label, controls);
    dom.regionLookupMethods.append(row);
  }

  const databaseName = geoIpDatabasePath.split(/[\\/]/).pop();
  dom.geoIpDatabaseName.textContent = databaseName || "内置 geoip.dat";
  dom.geoIpDatabaseName.title = geoIpDatabasePath || "自动使用安装包内置数据库";
  dom.clearGeoIpDatabaseButton.disabled = !geoIpDatabasePath;
}

async function chooseGeoIpDatabase() {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Xray / V2Ray GeoIP 数据库", extensions: ["dat"] }],
    });
    if (typeof selected !== "string") return;
    geoIpDatabasePath = selected;
    try {
      window.localStorage.setItem(GEOIP_DATABASE_PATH_STORAGE_KEY, selected);
    } catch {
      // 数据库仍可在当前会话中使用；存储不可用时忽略持久化错误。
    }
    renderRegionLookupSettings();
    if (!running && outputEntries.length > 0) void enrichOutputRegions();
  } catch (error) {
    showToast(failureFrom(error).message || "选择 GeoIP 数据库失败", true);
  }
}

function clearGeoIpDatabase() {
  geoIpDatabasePath = "";
  try {
    window.localStorage.removeItem(GEOIP_DATABASE_PATH_STORAGE_KEY);
  } catch {
    // 当前会话中仍按未选择数据库处理。
  }
  renderRegionLookupSettings();
  if (!running && outputEntries.length > 0) void enrichOutputRegions();
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

const dom = {
  urls: getElement<HTMLTextAreaElement>("subscription-urls"),
  importClipboardButton: getElement<HTMLButtonElement>("import-clipboard-button"),
  importFileButton: getElement<HTMLButtonElement>("import-file-button"),
  importQrButton: getElement<HTMLButtonElement>("import-qr-button"),
  qrScannerDialog: getElement<HTMLDialogElement>("qr-scanner-dialog"),
  qrScannerSourceOptions: getElement<HTMLElement>("qr-scanner-source-options"),
  qrScanScreenButton: getElement<HTMLButtonElement>("qr-scan-screen-button"),
  qrSelectImageButton: getElement<HTMLButtonElement>("qr-select-image-button"),
  qrScanCameraButton: getElement<HTMLButtonElement>("qr-scan-camera-button"),
  qrImageInput: getElement<HTMLInputElement>("qr-image-input"),
  qrScannerPreview: getElement<HTMLDivElement>("qr-scanner-preview"),
  qrScannerVideo: getElement<HTMLVideoElement>("qr-scanner-video"),
  qrScannerStatus: getElement<HTMLParagraphElement>("qr-scanner-status"),
  qrScannerClose: getElement<HTMLButtonElement>("qr-scanner-close"),
  qrScannerCancel: getElement<HTMLButtonElement>("qr-scanner-cancel"),
  qrScannerSourceBack: getElement<HTMLButtonElement>("qr-scanner-source-back"),
  qrScannerRetry: getElement<HTMLButtonElement>("qr-scanner-retry"),
  workspace: getElement<HTMLElement>("workspace"),
  panelResizers: Array.from(document.querySelectorAll<HTMLElement>(".panel-resizer")),
  validation: getElement<HTMLDivElement>("validation-message"),
  userAgentSelect: getElement<HTMLSelectElement>("user-agent-select"),
  customUserAgent: getElement<HTMLInputElement>("custom-user-agent"),
  fetchConcurrency: getElement<HTMLInputElement>("fetch-concurrency"),
  fetchConcurrencyMode: getElement<HTMLSelectElement>("fetch-concurrency-mode"),
  maxRedirects: getElement<HTMLInputElement>("max-redirects"),
  regionLookupMethods: getElement<HTMLDivElement>("region-lookup-methods"),
  geoIpDatabaseName: getElement<HTMLSpanElement>("geoip-database-name"),
  chooseGeoIpDatabaseButton: getElement<HTMLButtonElement>("choose-geoip-database"),
  clearGeoIpDatabaseButton: getElement<HTMLButtonElement>("clear-geoip-database"),
  deduplicateOutput: getElement<HTMLInputElement>("deduplicate-output"),
  includeLossyOutput: getElement<HTMLInputElement>("include-lossy-output"),
  skipCertificateVerification: getElement<HTMLInputElement>("skip-certificate-verification"),
  skipCertificateNote: getElement<HTMLParagraphElement>("skip-certificate-note"),
  allowLocalNetwork: getElement<HTMLInputElement>("allow-local-network"),
  convertButton: getElement<HTMLButtonElement>("convert-button"),
  convertLabel: getElement<HTMLSpanElement>("convert-button").querySelector<HTMLSpanElement>(".button-label")!,
  progressCopy: getElement<HTMLDivElement>("progress-copy"),
  progressBar: getElement<HTMLSpanElement>("progress-bar"),
  processingStatus: getElement<HTMLSpanElement>("processing-status"),
  logList: getElement<HTMLDivElement>("log-list"),
  clearLogButton: getElement<HTMLButtonElement>("clear-log-button"),
  outputFilterButton: getElement<HTMLButtonElement>("output-filter-button"),
  outputColumnResetButton: getElement<HTMLButtonElement>("output-column-reset-button"),
  outputFilterSummary: getElement<HTMLParagraphElement>("output-filter-summary"),
  outputFilterCount: getElement<HTMLSpanElement>("output-filter-count"),
  outputTableWrap: getElement<HTMLDivElement>("output-table-wrap"),
  outputTable: getElement<HTMLTableElement>("output-table"),
  outputTableBody: getElement<HTMLTableSectionElement>("output-table-body"),
  outputFilterDialog: getElement<HTMLDialogElement>("output-filter-dialog"),
  outputFilterDialogClose: getElement<HTMLButtonElement>("output-filter-dialog-close"),
  outputFilterDialogCancel: getElement<HTMLButtonElement>("output-filter-dialog-cancel"),
  outputFilterDialogSave: getElement<HTMLButtonElement>("output-filter-dialog-save"),
  outputFilterProtocolOptions: getElement<HTMLDivElement>("output-filter-protocol-options"),
  outputFilterProtocolSummary: getElement<HTMLSpanElement>("output-filter-protocol-summary"),
  outputFilterRegionOptions: getElement<HTMLDivElement>("output-filter-region-options"),
  outputFilterRegionSummary: getElement<HTMLSpanElement>("output-filter-region-summary"),
  outputFilterCloudflareEntry: getElement<HTMLSelectElement>("output-filter-cf-entry"),
  outputFilterCloudflareSummary: getElement<HTMLSpanElement>("output-filter-cf-summary"),
  outputOverview: getElement<HTMLSpanElement>("output-overview"),
  nodeCount: getElement<HTMLElement>("node-count"),
  sourceCount: getElement<HTMLElement>("source-count"),
  duplicateCount: getElement<HTMLElement>("duplicate-count"),
  copyButton: getElement<HTMLButtonElement>("copy-button"),
  saveButton: getElement<HTMLButtonElement>("save-button"),
  toast: getElement<HTMLDivElement>("toast"),
};

interface ResizeState {
  index: number;
  pointerId: number;
  startX: number;
  availableWidth: number;
  startRatios: number[];
}

interface OutputColumnResizeState {
  columnIndex: number;
  pointerId: number;
  startX: number;
  startWidth: number;
  handle: HTMLElement;
}

const MIN_PANEL_WIDTH = 200;
const SPLITTER_WIDTH = 13;
const DEFAULT_PANEL_RATIOS = [0.25, 0.34, 0.41];

let panelRatios = [...DEFAULT_PANEL_RATIOS];
let resizeState: ResizeState | null = null;
let outputColumnWidths = loadOutputColumnWidths();
let outputColumnResizeState: OutputColumnResizeState | null = null;
let sourceResults: SourceResult[] = [];
let outputUris: string[] = [];
let outputEntries: CategorizedOutput[] = [];
let outputFilter = loadOutputFilter();
let regionLookupMethods = loadRegionLookupMethods();
let geoIpDatabasePath = loadGeoIpDatabasePath();
let regionLookupState: "idle" | "running" | "done" | "error" = "idle";
let regionLookupRunId = 0;
let cloudflareDetectionState: "idle" | "running" | "done" | "error" = "idle";
let cloudflareDetectionRunId = 0;
let draftFilterProtocols: ProxyProtocol[] = [];
let draftFilterCountries: string[] = [];
let draftFilterCloudflareEntry: CloudflareEntryFilter = "all";
let duplicateCount = 0;
let activeSourceDocuments: SourceDocument[] = [];
let conversionAbort: AbortController | null = null;
let cancelRequested = false;
let running = false;
let completedSources = 0;
let fetchRunId = 0;
const activeFetchRequests = new Set<string>();
let toastTimer: number | undefined;
let qrCaptureStream: MediaStream | null = null;
let qrScanFrame: number | null = null;
let qrScanCanvas: HTMLCanvasElement | null = null;
let qrLastScanAt = 0;

function setValidation(message = "", warning = false) {
  dom.validation.textContent = message;
  dom.validation.hidden = !message;
  dom.validation.classList.toggle("warning", warning);
}

function showToast(message: string, error = false) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.toggle("error", error);
  dom.toast.classList.add("visible");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("visible"), 3200);
}

function availableWorkspaceWidth(): number {
  return Math.max(0, dom.workspace.getBoundingClientRect().width - dom.panelResizers.length * SPLITTER_WIDTH);
}

function clampPanelRatios(ratios: number[], availableWidth: number): number[] {
  if (availableWidth <= 0) return [...DEFAULT_PANEL_RATIOS];
  const minRatio = MIN_PANEL_WIDTH / availableWidth;
  let next = ratios.map(ratio => Math.max(minRatio, ratio));
  let total = next.reduce((sum, ratio) => sum + ratio, 0);
  if (total > 1) {
    const reducible = next.map(ratio => Math.max(0, ratio - minRatio));
    const reducibleTotal = reducible.reduce((sum, ratio) => sum + ratio, 0);
    if (reducibleTotal > 0) {
      const excess = total - 1;
      next = next.map((ratio, index) => ratio - excess * (reducible[index] / reducibleTotal));
    }
  }
  total = next.reduce((sum, ratio) => sum + ratio, 0);
  return total > 0 ? next.map(ratio => ratio / total) : [...DEFAULT_PANEL_RATIOS];
}

function applyPanelRatios() {
  dom.workspace.style.setProperty("--panel-a", `${panelRatios[0]}fr`);
  dom.workspace.style.setProperty("--panel-b", `${panelRatios[1]}fr`);
  dom.workspace.style.setProperty("--panel-c", `${panelRatios[2]}fr`);
}

function adjustPanelRatios(index: number, delta: number) {
  const availableWidth = availableWorkspaceWidth();
  if (availableWidth <= 0) return;
  const minRatio = MIN_PANEL_WIDTH / availableWidth;
  const next = [...panelRatios];
  const clamped = Math.min(Math.max(delta, minRatio - next[index]), next[index + 1] - minRatio);
  next[index] += clamped;
  next[index + 1] -= clamped;
  panelRatios = clampPanelRatios(next, availableWidth);
  applyPanelRatios();
}

function resetPanelRatios() {
  panelRatios = clampPanelRatios([...DEFAULT_PANEL_RATIOS], availableWorkspaceWidth());
  applyPanelRatios();
}

function applyOutputColumnWidths() {
  const columns = Array.from(dom.outputTable.querySelectorAll<HTMLTableColElement>("colgroup col"));
  if (columns.length !== outputColumnWidths.length + 1) return;

  outputColumnWidths.forEach((width, index) => {
    columns[index].style.width = `${width}px`;
  });
  columns[columns.length - 1].style.width = "auto";

  const columnsWidth = outputColumnWidths.reduce((total, width) => total + width, 0);
  dom.outputTable.style.width = `${Math.max(dom.outputTableWrap.clientWidth, columnsWidth)}px`;
  dom.outputTable.querySelectorAll<HTMLElement>(".output-column-resizer").forEach(handle => {
    const columnIndex = Number(handle.dataset.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= outputColumnWidths.length) return;
    handle.setAttribute("aria-valuenow", `${Math.round(outputColumnWidths[columnIndex])}`);
    handle.setAttribute("aria-valuemin", `${OUTPUT_COLUMN_MIN_WIDTH}`);
    // 分隔条只报告可访问性范围，不限制实际拖动宽度。
    handle.setAttribute("aria-valuemax", `${Math.max(10_000, Math.round(outputColumnWidths[columnIndex]))}`);
  });
}

function resizeOutputColumn(columnIndex: number, width: number) {
  if (columnIndex < 0 || columnIndex >= outputColumnWidths.length) return;
  outputColumnWidths[columnIndex] = Math.max(OUTPUT_COLUMN_MIN_WIDTH, width);
  applyOutputColumnWidths();
}

function resetOutputColumnWidths() {
  outputColumnWidths = defaultOutputColumnWidths();
  applyOutputColumnWidths();
  saveOutputColumnWidths();
}

function bindOutputTableColumnResizers() {
  const handles = Array.from(dom.outputTable.querySelectorAll<HTMLElement>(".output-column-resizer"));
  handles.forEach(handle => {
    const columnIndex = Number(handle.dataset.columnIndex);

    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= outputColumnWidths.length) return;
      event.preventDefault();
      outputColumnResizeState = {
        columnIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: outputColumnWidths[columnIndex],
        handle,
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // 后续窗口级指针事件仍可继续处理拖动。
      }
      handle.classList.add("is-active");
      document.body.classList.add("resizing-output-columns");
    });

    window.addEventListener("pointermove", event => {
      const state = outputColumnResizeState;
      if (!state || state.handle !== handle || event.pointerId !== state.pointerId) return;
      resizeOutputColumn(state.columnIndex, state.startWidth + event.clientX - state.startX);
    });

    const endResize = (event: PointerEvent) => {
      const state = outputColumnResizeState;
      if (!state || state.handle !== handle || event.pointerId !== state.pointerId) return;
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch {
        // 释放失败时不影响结束逻辑。
      }
      handle.classList.remove("is-active");
      document.body.classList.remove("resizing-output-columns");
      outputColumnResizeState = null;
      saveOutputColumnWidths();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);

    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 20 : 8;
      const delta = event.key === "ArrowLeft" ? -step : step;
      resizeOutputColumn(columnIndex, outputColumnWidths[columnIndex] + delta);
      saveOutputColumnWidths();
    });
  });

  applyOutputColumnWidths();
  new ResizeObserver(applyOutputColumnWidths).observe(dom.outputTableWrap);
}

function bindPanelResizers() {
  dom.panelResizers.forEach((handle, index) => {
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const availableWidth = availableWorkspaceWidth();
      if (availableWidth <= 0) return;
      resizeState = {
        index,
        pointerId: event.pointerId,
        startX: event.clientX,
        availableWidth,
        startRatios: [...panelRatios],
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // 指针捕获不可用时继续使用窗口级事跟踪
      }
      handle.classList.add("is-active");
      document.body.classList.add("resizing-panels");
    });

    handle.addEventListener("pointermove", event => {
      if (!resizeState || resizeState.index !== index || event.pointerId !== resizeState.pointerId) return;
      const minRatio = MIN_PANEL_WIDTH / resizeState.availableWidth;
      const next = [...resizeState.startRatios];
      const rawDelta = (event.clientX - resizeState.startX) / resizeState.availableWidth;
      const clamped = Math.min(Math.max(rawDelta, minRatio - next[index]), next[index + 1] - minRatio);
      next[index] += clamped;
      next[index + 1] -= clamped;
      panelRatios = clampPanelRatios(next, resizeState.availableWidth);
      applyPanelRatios();
    });

    const endResize = (event: PointerEvent) => {
      if (!resizeState || resizeState.index !== index) return;
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch {
        // 释放失败时不影响结束逻辑
      }
      handle.classList.remove("is-active");
      document.body.classList.remove("resizing-panels");
      resizeState = null;
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
    handle.addEventListener("dblclick", resetPanelRatios);
    handle.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      adjustPanelRatios(index, event.key === "ArrowLeft" ? -0.02 : 0.02);
    });
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth <= 760) return;
    panelRatios = clampPanelRatios(panelRatios, availableWorkspaceWidth());
    applyPanelRatios();
  });
}

function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?…" : ""}`;
  } catch {
    return "无效地址";
  }
}

function appendLog(message: string, error = false) {
  const line = document.createElement("div");
  line.className = error ? "log-line error" : "log-line";
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  dom.logList.append(line);
  dom.logList.scrollTop = dom.logList.scrollHeight;
}

function clearLog() {
  dom.logList.replaceChildren();
}

function resolveUserAgent(): string | null {
  const preset = dom.userAgentSelect.value;
  if (preset === "auto") return null;
  if (preset === "custom") {
    const custom = dom.customUserAgent.value.trim();
    if (!custom) {
      setValidation("已选择自定义 User-Agent，但输入内容为空。");
      dom.customUserAgent.focus();
      throw new ConversionError("invalid_user_agent", "自定义 User-Agent 不能为空。");
    }
    if (custom.length > 512 || /[\r\n]/.test(custom)) {
      setValidation("User-Agent 不能包含换行，且长度不能超过 512 个字符。");
      dom.customUserAgent.focus();
      throw new ConversionError("invalid_user_agent", "User-Agent 格式无效。");
    }
    return custom;
  }
  return USER_AGENT_PRESETS[preset] ?? null;
}

// 与 Android 客户端一致：同时保留远程订阅 URL 和本地节点/配置片段。
interface DetectedImportInput {
  urls: string[];
  local: string[];
  truncated: boolean;
  fragmentsTruncated: boolean;
  uriLimitReached: boolean;
  decodedTooLarge: number;
  depthLimited: boolean;
  inputTooLarge: boolean;
}

function readImportInput(): DetectedImportInput | null {
  const value = dom.urls.value.trim();
  if (!value) {
    setValidation("请先输入订阅 URL、节点 URI 或配置内容。");
    dom.urls.focus();
    return null;
  }

  const detected = detectSubscriptionInput(value);
  if (detected.inputTooLarge) {
    setValidation("输入内容超过 64 MiB 上限。");
    return null;
  }
  if (detected.urls.length === 0 && detected.local.length === 0) {
    setValidation("未检测到有效的订阅 URL、节点 URI 或配置内容。");
    dom.urls.focus();
    return null;
  }

  setValidation();
  return detected;
}

function replaceInputContent(content: string): boolean {
  if (!content.trim()) return false;
  if (new Blob([content]).size > MAX_BATCH_INPUT_BYTES) {
    showToast("导入内容超过 64 MiB 上限", true);
    return false;
  }
  dom.urls.value = content;
  setValidation();
  return true;
}

async function importClipboard() {
  if (running) return;
  try {
    const content = (await readText()).trim();
    if (!content) {
      showToast("剪贴板为空", true);
      return;
    }
    if (replaceInputContent(content)) showToast("已读取剪贴板内容");
  } catch {
    showToast("读取剪贴板失败，请检查剪贴板权限", true);
  }
}

// Android 智能识别窗口一次导入一个文本文件，并用文件内容替换输入框。
async function importFile() {
  if (running) return;
  try {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== "string") return;
    const content = await invoke<string>("read_text_file", { path: selected });
    if (!content.trim()) {
      showToast("文件内容为空", true);
      return;
    }
    if (replaceInputContent(content)) showToast("已读取文件内容");
  } catch (error) {
    showToast(failureFrom(error).message || "读取文件失败", true);
  }
}

function qrCameraErrorMessage(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "相机权限未获允许。请检查应用相机权限后重试。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到可用相机。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "相机正被其他应用占用，请关闭其他应用后重试。";
  }
  return "无法启动相机，请检查相机连接和权限。";
}

function decodeQrFromImage(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
  maxSide: number,
): string | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建二维码扫描画布");
  context.drawImage(source, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  return jsQR(image.data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

async function importQrImage(file: File) {
  if (file.size > 64 * 1024 * 1024) {
    showToast("图片文件超过 64 MiB 上限", true);
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    let content: string | null;
    try {
      content = decodeQrFromImage(bitmap, bitmap.width, bitmap.height, document.createElement("canvas"), 4096)?.trim() ?? null;
    } finally {
      bitmap.close();
    }
    if (!content) {
      showToast("图片中未识别到二维码", true);
      return;
    }
    closeQrScanner();
    if (replaceInputContent(content)) showToast("已从图片读取二维码内容");
  } catch {
    showToast("无法读取图片，请选择有效的图片文件", true);
  }
}

function releaseQrCapture() {
  if (qrScanFrame !== null) {
    cancelAnimationFrame(qrScanFrame);
    qrScanFrame = null;
  }
  qrCaptureStream?.getTracks().forEach(track => track.stop());
  qrCaptureStream = null;
  dom.qrScannerVideo.pause();
  dom.qrScannerVideo.srcObject = null;
  qrScanCanvas = null;
  qrLastScanAt = 0;
}

function closeQrScanner() {
  releaseQrCapture();
  if (dom.qrScannerDialog.open) dom.qrScannerDialog.close();
}

function showQrCaptureError(message: string, retryable = true) {
  releaseQrCapture();
  dom.qrScannerSourceOptions.hidden = false;
  dom.qrScannerPreview.hidden = true;
  dom.qrScannerStatus.textContent = message;
  dom.qrScannerStatus.hidden = false;
  dom.qrScannerSourceBack.hidden = true;
  dom.qrScannerRetry.hidden = !retryable;
  dom.qrScannerRetry.textContent = "重试摄像头";
}

function returnToQrSourceOptions() {
  releaseQrCapture();
  dom.qrScannerSourceOptions.hidden = false;
  dom.qrScannerPreview.hidden = true;
  dom.qrScannerStatus.hidden = true;
  dom.qrScannerStatus.textContent = "";
  dom.qrScannerSourceBack.hidden = true;
  dom.qrScannerRetry.hidden = true;
}

function scanQrVideoFrame(now: number) {
  qrScanFrame = null;
  if (!dom.qrScannerDialog.open || !qrCaptureStream) return;
  qrScanFrame = requestAnimationFrame(scanQrVideoFrame);
  if (now - qrLastScanAt < 180 || dom.qrScannerVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  qrLastScanAt = now;

  try {
    const video = dom.qrScannerVideo;
    const maxSide = 1920;
    qrScanCanvas ??= document.createElement("canvas");
    const content = decodeQrFromImage(video, video.videoWidth, video.videoHeight, qrScanCanvas, maxSide)?.trim();
    if (!content) return;

    closeQrScanner();
    if (replaceInputContent(content)) showToast("已读取二维码内容");
  } catch {
    showQrCaptureError("读取相机画面失败，请重试。");
  }
}

async function startQrCamera() {
  releaseQrCapture();
  dom.qrScannerSourceOptions.hidden = true;
  dom.qrScannerPreview.hidden = true;
  dom.qrScannerStatus.hidden = false;
  dom.qrScannerStatus.textContent = "正在启动相机…";
  dom.qrScannerSourceBack.hidden = true;
  dom.qrScannerRetry.hidden = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_capture_unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    if (!dom.qrScannerDialog.open) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    qrCaptureStream = stream;
    stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => {
      if (qrCaptureStream !== stream || !dom.qrScannerDialog.open) return;
      showQrCaptureError("相机已停止。", false);
    }, { once: true }));
    dom.qrScannerVideo.srcObject = stream;
    await dom.qrScannerVideo.play();
    if (!dom.qrScannerDialog.open) {
      releaseQrCapture();
      return;
    }
    dom.qrScannerPreview.hidden = false;
    dom.qrScannerStatus.textContent = "请将二维码放入取景框。";
    dom.qrScannerSourceBack.hidden = false;
    qrScanFrame = requestAnimationFrame(scanQrVideoFrame);
  } catch (error) {
    if (!dom.qrScannerDialog.open) {
      releaseQrCapture();
      return;
    }
    const message = error instanceof Error && error.message.endsWith("_unavailable")
      ? "当前运行环境不支持摄像头扫码。"
      : qrCameraErrorMessage(error);
    showQrCaptureError(message, !message.includes("不支持"));
  }
}

async function scanFullScreens() {
  if (running || !dom.qrScannerDialog.open) return;
  dom.qrScannerSourceOptions.hidden = true;
  dom.qrScannerPreview.hidden = true;
  dom.qrScannerStatus.hidden = false;
  dom.qrScannerStatus.textContent = "正在截取所有屏幕…";
  dom.qrScannerSourceBack.hidden = true;
  dom.qrScannerRetry.hidden = true;

  try {
    const screenshots = await invoke<string[]>("capture_full_screens");
    let content: string | null = null;
    for (const encoded of screenshots) {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      try {
        content = decodeQrFromImage(
          bitmap,
          bitmap.width,
          bitmap.height,
          document.createElement("canvas"),
          4096,
        )?.trim() ?? null;
      } finally {
        bitmap.close();
      }
      if (content) break;
    }

    if (!content) {
      dom.qrScannerSourceOptions.hidden = false;
      dom.qrScannerStatus.textContent = "全屏中未识别到二维码，可以重试或选择其他来源。";
      return;
    }
    closeQrScanner();
    if (replaceInputContent(content)) showToast("已从全屏读取二维码内容");
  } catch (error) {
    dom.qrScannerSourceOptions.hidden = false;
    dom.qrScannerStatus.textContent = failureFrom(error).message || "全屏扫描失败，请重试。";
  }
}

async function importQrCode() {
  if (running || dom.qrScannerDialog.open) return;
  returnToQrSourceOptions();
  dom.qrScannerRetry.hidden = true;
  dom.qrScannerDialog.showModal();
}

function handleQrImageSelection() {
  const file = dom.qrImageInput.files?.[0];
  dom.qrImageInput.value = "";
  if (file) void importQrImage(file);
}

function resolveMaxRedirects(): number {
  const maxRedirects = dom.maxRedirects.valueAsNumber;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    setValidation(`最大重定向必须是 0 到 ${MAX_REDIRECTS} 之间的整数。`);
    dom.maxRedirects.focus();
    throw new ConversionError("invalid_redirect_limit", "重定向设置无效。");
  }
  return maxRedirects;
}

function resolveFetchConcurrencySetting(): FetchConcurrencySetting {
  const mode: FetchConcurrencyMode = dom.fetchConcurrencyMode.value === "percent" ? "percent" : "fixed";
  const value = dom.fetchConcurrency.valueAsNumber;
  const max = mode === "percent" ? MAX_FETCH_CONCURRENCY_PERCENT : MAX_FETCH_CONCURRENCY;
  if (!Number.isInteger(value) || value < MIN_FETCH_CONCURRENCY || value > max) {
    setValidation(mode === "percent"
      ? `并发百分比必须是 ${MIN_FETCH_CONCURRENCY} 到 ${MAX_FETCH_CONCURRENCY_PERCENT} 之间的整数。`
      : `并发数量必须是 ${MIN_FETCH_CONCURRENCY} 到 ${MAX_FETCH_CONCURRENCY} 之间的整数。`);
    dom.fetchConcurrency.focus();
    throw new ConversionError("invalid_concurrency", "并发设置无效。");
  }
  return { mode, value };
}

function resolveFetchConcurrency(setting: FetchConcurrencySetting, totalRequests: number): number {
  if (setting.mode === "fixed") return Math.min(setting.value, Math.max(1, totalRequests));
  const requested = Math.max(1, Math.ceil(totalRequests * setting.value / 100));
  return Math.min(requested, MAX_FETCH_CONCURRENCY);
}

function describeFetchConcurrency(setting: FetchConcurrencySetting, totalRequests: number, effective: number): string {
  if (setting.mode === "percent") {
    const requested = Math.max(1, Math.ceil(totalRequests * setting.value / 100));
    const cap = requested > MAX_FETCH_CONCURRENCY ? `，超过并发上限 ${MAX_FETCH_CONCURRENCY}` : "";
    return `${setting.value}% × ${totalRequests} = ${requested} 个${cap}，实际并发 ${effective} 个`;
  }
  return `固定 ${setting.value} 个，本次实际并发 ${effective} 个`;
}

function syncFetchConcurrencyInput() {
  const percent = dom.fetchConcurrencyMode.value === "percent";
  const max = percent ? MAX_FETCH_CONCURRENCY_PERCENT : MAX_FETCH_CONCURRENCY;
  dom.fetchConcurrency.max = String(max);
  if (dom.fetchConcurrency.valueAsNumber > max) dom.fetchConcurrency.value = String(max);
  dom.fetchConcurrency.title = percent
    ? `按本次远程请求数的百分比计算，实际并发最高 ${MAX_FETCH_CONCURRENCY} 个`
    : `固定并发 ${MIN_FETCH_CONCURRENCY}–${MAX_FETCH_CONCURRENCY} 个`;
}

function shouldSkipCertificateVerification(): boolean {
  return dom.skipCertificateVerification.checked;
}

function shouldAllowLocalNetwork(): boolean {
  return dom.allowLocalNetwork.checked;
}

function shouldDeduplicateOutput(): boolean {
  return dom.deduplicateOutput.checked;
}

function shouldIncludeLossyOutput(): boolean {
  return dom.includeLossyOutput.checked;
}

function refreshForOutputSettingChange() {
  if (!running && activeSourceDocuments.length > 0) void refreshConversion();
}

function setProcessingStatus(label: string, state: ProcessingState) {
  dom.processingStatus.textContent = label;
  dom.processingStatus.dataset.state = state;
  dom.processingStatus.hidden = state === "idle" || !label;
}

function setBusy(busy: boolean) {
  running = busy;
  dom.convertButton.disabled = false;
  dom.urls.disabled = busy;
  dom.importClipboardButton.disabled = busy;
  dom.importFileButton.disabled = busy;
  dom.importQrButton.disabled = busy;
  dom.userAgentSelect.disabled = busy;
  dom.customUserAgent.disabled = busy;
  dom.fetchConcurrency.disabled = busy;
  dom.fetchConcurrencyMode.disabled = busy;
  dom.maxRedirects.disabled = busy;
  dom.deduplicateOutput.disabled = busy;
  dom.includeLossyOutput.disabled = busy;
  dom.skipCertificateVerification.disabled = busy;
  dom.allowLocalNetwork.disabled = busy;
  dom.convertButton.classList.toggle("busy", busy);
  dom.convertLabel.textContent = busy ? "取消处理" : "开始转换";
  setProcessingStatus(busy ? "处理中" : "已完成", busy ? "running" : "done");
}

function updateProgress(done: number, total: number) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  dom.progressBar.style.width = `${percent}%`;
  dom.progressCopy.textContent = running
    ? `正在处理 ${done} / ${total} 个来源 · ${percent}%`
    : `已处理 ${done} / ${total} 个来源`;
}

function appendConversionDiagnostics(result: ConversionResult) {
  const labels = new Map(sourceResults.map(source => [source.kind === "local" ? "local" : source.sourceId, source.kind === "local" ? "本地内容" : displayUrl(source.url)]));
  const visible = result.diagnostics.slice(0, 40);
  for (const item of visible) {
    const sourceLabel = labels.get(item.sourceId) ?? item.sourceId;
    const location = [item.location, item.nodeId ? `节点 ${item.nodeId}` : ""].filter(Boolean).join(" · ");
    const field = item.field ? ` 字段 ${item.field}` : "";
    appendLog(`${sourceLabel} · ${item.stage}/${item.code}${location ? ` · ${location}` : ""}${field}：${item.message}`, item.severity === "error");
  }
  if (result.diagnostics.length > visible.length) {
    appendLog(`另有 ${result.diagnostics.length - visible.length} 条诊断，已在转换结果中统计。`);
  }
}

function outputEntryMatchesFilter(entry: CategorizedOutput): boolean {
  if (outputFilter.protocols.length > 0 && !outputFilter.protocols.includes(entry.protocol)) return false;
  if (outputFilter.countries.length > 0 && !outputFilter.countries.includes(entry.countryCode ?? UNKNOWN_REGION_CODE)) return false;
  if (outputFilter.cloudflareEntry === "yes" && entry.isCloudflare !== true) return false;
  if (outputFilter.cloudflareEntry === "no" && entry.isCloudflare !== false) return false;
  return true;
}

function getFilteredOutputEntries(): CategorizedOutput[] {
  return outputEntries.filter(outputEntryMatchesFilter);
}

function getFilteredOutputUris(): string[] {
  return getFilteredOutputEntries().map(entry => entry.uri);
}

function isOutputFilterActive(): boolean {
  return outputFilter.protocols.length > 0 || outputFilter.countries.length > 0 || outputFilter.cloudflareEntry !== "all";
}

function outputFilterSummaryText(): string {
  if (!isOutputFilterActive()) return "全部节点";
  const parts = [
    outputFilter.protocols.length ? outputFilter.protocols.map(getProtocolLabel).join(" / ") : "全部协议",
    outputFilter.countries.length ? outputFilter.countries.map(countryNameForCode).join("、") : "全部地区",
  ];
  if (outputFilter.cloudflareEntry === "yes") parts.push("CF 入口");
  else if (outputFilter.cloudflareEntry === "no") parts.push("非 CF 入口");
  return parts.join(" · ");
}

function availableOutputRegionCodes(): string[] {
  return [...new Set([
    ...outputFilter.countries,
    ...outputEntries.map(entry => entry.countryCode ?? UNKNOWN_REGION_CODE),
  ])].sort((left, right) => {
    if (left === UNKNOWN_REGION_CODE) return 1;
    if (right === UNKNOWN_REGION_CODE) return -1;
    return countryNameForCode(left).localeCompare(countryNameForCode(right), "zh-CN");
  });
}

function updateOutputFilterDialogSummaries() {
  dom.outputFilterProtocolSummary.textContent = draftFilterProtocols.length
    ? `已选 ${draftFilterProtocols.length} 种协议`
    : "全部协议";
  dom.outputFilterRegionSummary.textContent = draftFilterCountries.length
    ? `已选 ${draftFilterCountries.length} 个地区`
    : "全部地区";
  dom.outputFilterCloudflareSummary.textContent = draftFilterCloudflareEntry === "yes"
    ? "CF 入口"
    : draftFilterCloudflareEntry === "no" ? "非 CF 入口" : "全部入口";
  dom.outputFilterCloudflareEntry.value = draftFilterCloudflareEntry;
}

function renderOutputFilterDialogOptions() {
  dom.outputFilterProtocolOptions.replaceChildren();
  for (const item of OUTPUT_PROTOCOLS) {
    const optionLabel = document.createElement("label");
    optionLabel.className = "output-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = item.value;
    checkbox.checked = draftFilterProtocols.includes(item.value);
    checkbox.setAttribute("aria-label", `协议类型：${item.label}`);
    const optionName = document.createElement("span");
    optionName.textContent = item.label;
    checkbox.addEventListener("change", () => {
      const selected = new Set(draftFilterProtocols);
      if (checkbox.checked) selected.add(item.value);
      else selected.delete(item.value);
      draftFilterProtocols = OUTPUT_PROTOCOLS
        .map(protocol => protocol.value)
        .filter(protocol => selected.has(protocol));
      updateOutputFilterDialogSummaries();
    });
    optionLabel.append(checkbox, optionName);
    dom.outputFilterProtocolOptions.append(optionLabel);
  }

  dom.outputFilterRegionOptions.replaceChildren();
  const regionCodes = availableOutputRegionCodes();
  if (regionCodes.length === 0) {
    const empty = document.createElement("span");
    empty.className = "output-region-empty";
    empty.textContent = "完成节点转换后，这里会显示识别到的地区。";
    dom.outputFilterRegionOptions.append(empty);
  }
  for (const code of regionCodes) {
    const optionLabel = document.createElement("label");
    optionLabel.className = "output-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = code;
    checkbox.checked = draftFilterCountries.includes(code);
    const regionName = countryNameForCode(code);
    checkbox.setAttribute("aria-label", `地区：${regionName}`);
    const optionName = document.createElement("span");
    optionName.textContent = `${regionName} · ${code}`;
    checkbox.addEventListener("change", () => {
      const selected = new Set(draftFilterCountries);
      if (checkbox.checked) selected.add(code);
      else selected.delete(code);
      draftFilterCountries = regionCodes.filter(regionCode => selected.has(regionCode));
      updateOutputFilterDialogSummaries();
    });
    optionLabel.append(checkbox, optionName);
    dom.outputFilterRegionOptions.append(optionLabel);
  }
  updateOutputFilterDialogSummaries();
}

function openOutputFilterDialog() {
  if (dom.outputFilterDialog.open) return;
  draftFilterProtocols = [...outputFilter.protocols];
  draftFilterCountries = [...outputFilter.countries];
  draftFilterCloudflareEntry = outputFilter.cloudflareEntry;
  renderOutputFilterDialogOptions();
  dom.outputFilterDialog.showModal();
}

function saveOutputFilterDialog() {
  outputFilter = {
    protocols: [...draftFilterProtocols],
    countries: [...draftFilterCountries],
    cloudflareEntry: draftFilterCloudflareEntry,
  };
  saveOutputFilter();
  dom.outputFilterDialog.close("save");
  renderOutputFilter();
  void enrichOutputCloudflare();
  dom.outputFilterButton.focus();
}

function renderOutputTableRow(entry: CategorizedOutput, index: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.dataset.nodeId = entry.id;

  const indexCell = document.createElement("td");
  indexCell.className = "output-table-index";
  indexCell.textContent = `${index + 1}`;

  const protocolCell = document.createElement("td");
  protocolCell.textContent = getProtocolLabel(entry.protocol);

  const nameCell = document.createElement("td");
  const name = document.createElement("strong");
  name.className = "output-table-primary output-table-truncate";
  name.textContent = entry.name.trim() || "未命名节点";
  name.title = name.textContent;
  nameCell.append(name);

  const addressCell = document.createElement("td");
  const address = document.createElement("span");
  address.className = "output-table-truncate output-table-ip";
  address.textContent = entry.server || "—";
  address.title = entry.server;
  addressCell.append(address);

  const portCell = document.createElement("td");
  portCell.className = "output-table-port";
  portCell.textContent = `${entry.port}`;

  const regionCell = document.createElement("td");
  const region = document.createElement("span");
  region.className = "output-table-truncate";
  region.textContent = entry.countryCode
    ? countryNameForCode(entry.countryCode)
    : regionLookupState === "running" ? "查询中" : "未知";
  region.title = entry.countryCode ? `${region.textContent} (${entry.countryCode})` : region.textContent;
  regionCell.append(region);

  const entryCell = document.createElement("td");
  const entryBadge = document.createElement("span");
  entryBadge.className = "output-entry-badge";
  if (entry.isCloudflare === true) {
    entryBadge.textContent = "CF";
    entryBadge.classList.add("is-cloudflare");
  } else if (entry.isCloudflare === false) {
    entryBadge.textContent = "非 CF";
    entryBadge.classList.add("is-non-cloudflare");
  } else if (cloudflareDetectionState === "running") {
    entryBadge.textContent = "检测中";
  } else {
    entryBadge.textContent = "—";
  }
  entryCell.append(entryBadge);

  const actionCell = document.createElement("td");
  actionCell.className = "output-table-action";
  const copy = document.createElement("button");
  copy.className = "output-row-copy";
  copy.type = "button";
  copy.textContent = "复制";
  copy.setAttribute("aria-label", `复制节点 ${name.textContent}`);
  copy.addEventListener("click", () => void copyUris([entry.uri], `节点“${name.textContent}”`));
  actionCell.append(copy);

  const fillerCell = document.createElement("td");
  fillerCell.className = "output-table-filler";
  fillerCell.setAttribute("aria-hidden", "true");

  row.append(indexCell, protocolCell, nameCell, addressCell, portCell, regionCell, entryCell, actionCell, fillerCell);
  return row;
}

function renderOutputFilter() {
  const filteredEntries = getFilteredOutputEntries();
  const uris = filteredEntries.map(entry => entry.uri);
  const value = uris.join("\n");
  const summary = outputFilterSummaryText();

  dom.outputTableBody.replaceChildren();
  filteredEntries.forEach((entry, index) => dom.outputTableBody.append(renderOutputTableRow(entry, index)));
  dom.outputTableWrap.hidden = false;
  dom.outputFilterCount.textContent = `${uris.length} 个节点 · ${formatBytes(new Blob([value]).size)}`;
  dom.outputFilterSummary.textContent = summary;
  dom.outputFilterSummary.title = summary;

  const regionStatus = regionLookupState === "running" ? " · 地区查询中" : "";
  const cloudflareCount = outputEntries.filter(entry => entry.isCloudflare === true).length;
  const unresolvedCloudflareCount = outputEntries.filter(entry => entry.isCloudflare === null).length;
  const cloudflareStatus = cloudflareDetectionState === "running"
    ? " · CF 入口检测中"
    : cloudflareDetectionState === "done"
      ? ` · CF 入口 ${cloudflareCount} 个${unresolvedCloudflareCount > 0 ? `（${unresolvedCloudflareCount} 个未解析）` : ""}`
      : cloudflareDetectionState === "error" ? " · CF 入口检测失败" : "";
  const countText = isOutputFilterActive()
    ? `${uris.length} / ${outputUris.length} 个节点`
    : `${outputUris.length} 个节点`;
  dom.outputOverview.textContent = `${countText}${regionStatus}${cloudflareStatus}`;
  dom.copyButton.disabled = uris.length === 0;
  dom.saveButton.disabled = uris.length === 0;
}

async function enrichOutputRegions() {
  const runId = ++regionLookupRunId;
  const entries = [...outputEntries];
  if (entries.length === 0) {
    regionLookupState = "idle";
    renderOutputFilter();
    return;
  }

  regionLookupState = regionLookupMethods.length > 0 ? "running" : "done";
  for (const entry of entries) entry.countryCode = null;
  renderOutputFilter();

  const unresolved = new Map(entries.map(entry => [entry.id, entry]));
  let lookupFailed = false;
  for (const method of regionLookupMethods) {
    if (runId !== regionLookupRunId) return;
    if (unresolved.size === 0) break;

    if (method === "NODE_NAME") {
      for (const [id, entry] of unresolved) {
        const countryCode = countryCodeFromNodeName(entry.name);
        if (!countryCode) continue;
        entry.countryCode = countryCode;
        unresolved.delete(id);
      }
      continue;
    }

    const pendingEntries = [...unresolved.values()];
    if (pendingEntries.length === 0) break;
    try {
      const results = await invoke<Array<{ id: string; countryCode: string | null }>>("lookup_node_regions", {
        nodes: pendingEntries.map(({ id, server }) => ({ id, server })),
        lookupMethod: method,
        geoIpDatabasePath: method === "LOCAL_GEOIP" ? geoIpDatabasePath : null,
      });
      if (runId !== regionLookupRunId) return;
      const resultById = new Map(results.map(result => [result.id, normalizeRegionCode(result.countryCode)]));
      for (const [id, entry] of unresolved) {
        const countryCode = resultById.get(id);
        if (!countryCode) continue;
        entry.countryCode = countryCode;
        unresolved.delete(id);
      }
    } catch (error) {
      lookupFailed = true;
      appendLog(`${method === "LOCAL_GEOIP" ? "本地 GeoIP" : "远程地区 API"}查询失败：${failureFrom(error).message}`, true);
    }
  }

  if (runId !== regionLookupRunId) return;
  regionLookupState = lookupFailed ? "error" : "done";
  renderOutputFilter();
}

async function enrichOutputCloudflare() {
  const entries = [...outputEntries];
  if (entries.length === 0) {
    cloudflareDetectionRunId += 1;
    cloudflareDetectionState = "idle";
    return;
  }
  if (cloudflareDetectionState === "running") return;
  if (cloudflareDetectionState === "done" && entries.every(entry => entry.isCloudflare !== null)) return;

  const runId = ++cloudflareDetectionRunId;
  cloudflareDetectionState = "running";
  for (const entry of entries) entry.isCloudflare = null;
  renderOutputFilter();
  try {
    const results = await invoke<Array<{
      id: string;
      isCloudflare: boolean | null;
      entryIps: string[];
    }>>("lookup_cloudflare_entries", {
      nodes: entries.map(({ id, server }) => ({ id, server })),
    });
    if (runId !== cloudflareDetectionRunId) return;
    const resultById = new Map(results.map(result => [result.id, result] as const));
    for (const entry of entries) {
      const result = resultById.get(entry.id);
      entry.isCloudflare = result?.isCloudflare ?? null;
      entry.entryIps = result?.entryIps ?? [];
    }
    cloudflareDetectionState = "done";
  } catch (error) {
    if (runId !== cloudflareDetectionRunId) return;
    cloudflareDetectionState = "error";
    appendLog(`CF 入口检测失败：${failureFrom(error).message}`, true);
  }
  if (runId === cloudflareDetectionRunId) renderOutputFilter();
}

function aggregateResults(result: ConversionResult, logDiagnostics = true) {
  cloudflareDetectionRunId += 1;
  cloudflareDetectionState = "idle";
  outputEntries = result.encoded
    .filter(item => item.uri && (item.status === "complete" || (shouldIncludeLossyOutput() && item.status === "lossy")))
    .map((item, index) => ({
      id: `${item.node.id}-${index}`,
      name: item.node.name,
      server: item.node.server,
      port: item.node.port,
      entryIps: null,
      protocol: item.node.protocol,
      uri: item.uri!,
      countryCode: null,
      isCloudflare: null,
    }));
  outputUris = outputEntries.map(item => item.uri);
  duplicateCount = result.stats.duplicates;
  const allowed = new Set(outputUris);

  for (const source of sourceResults) {
    const sourceId = source.kind === "local" ? "local" : source.sourceId;
    source.diagnostics = result.diagnostics.filter(item => item.sourceId === sourceId);
    const sourceEncodings = result.encoded.filter(item => item.node.sources.some(origin => origin.sourceId === sourceId));
    source.nodes = sourceEncodings
      .filter(item => item.uri && allowed.has(item.uri))
      .map(item => item.uri as string);
    if (source.content !== undefined) {
      if (source.nodes.length > 0) source.state = "success";
      else {
        source.state = "error";
        const hasLossyOnlyResults = !shouldIncludeLossyOutput() && sourceEncodings.some(item => item.status === "lossy");
        source.errorCode = hasLossyOnlyResults ? "lossy_only" : "no_nodes";
        source.errorMessage = hasLossyOnlyResults
          ? "节点包含无法无损转换的字段；可在输出设置中允许有损结果。"
          : "来源内容没有生成可用 URI，请查看解析与验证诊断。";
      }
    }
  }

  const successfulSources = sourceResults.filter(source => source.state === "success").length;
  dom.nodeCount.textContent = String(outputUris.length);
  dom.sourceCount.textContent = String(successfulSources);
  dom.duplicateCount.textContent = String(duplicateCount);

  renderOutputFilter();
  if (logDiagnostics) appendConversionDiagnostics(result);
  void enrichOutputRegions();
  void enrichOutputCloudflare();
}

async function refreshConversion() {
  if (!activeSourceDocuments.length || running) return;
  const controller = new AbortController();
  conversionAbort = controller;
  setBusy(true);
  try {
    const result = await convertSourcesInWorker(activeSourceDocuments, {
      deduplicate: shouldDeduplicateOutput(),
      includeLossy: shouldIncludeLossyOutput(),
      signal: controller.signal,
    });
    aggregateResults(result, false);
  } catch (error) {
    appendLog(`重新转换失败：${failureFrom(error).message}`, true);
  } finally {
    if (conversionAbort === controller) conversionAbort = null;
    setBusy(false);
  }
}

function cancelConversion() {
  if (!running) return;
  cancelRequested = true;
  conversionAbort?.abort();
  for (const requestId of activeFetchRequests) {
    void invoke<boolean>("cancel_subscription", { requestId }).catch(() => undefined);
  }
  dom.convertButton.disabled = true;
  dom.convertLabel.textContent = "正在取消…";
  appendLog("正在取消后续处理…");
}
function failureFrom(error: unknown): { code: string; message: string } {
  if (error instanceof ConversionError) return { code: error.code, message: error.message };
  if (typeof error === "object" && error !== null) {
    const failure = error as FetchFailure;
    return {
      code: failure.code || "unknown_error",
      message: failure.message || "请求失败，请检查订阅地址和网络连接。",
    };
  }
  if (typeof error === "string" && error.trim()) {
    return { code: "unknown_error", message: error };
  }
  return { code: "unknown_error", message: "请求失败，请稍后重试。" };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !cancelRequested) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function shouldRetryAutomaticUserAgent(result: ConversionResult): boolean {
  if (result.stats.parsedNodes > 0) return false;
  return result.diagnostics.some(item => ["unknown_format", "no_native_nodes", "no_proxy_section", "no_uri_nodes"].includes(item.code));
}

async function probeSubscription(content: string, sourceId: string, signal?: AbortSignal): Promise<ConversionResult> {
  return convertSourcesInWorker([{ sourceId, sourceName: "User-Agent probe", content }], {
    deduplicate: false,
    includeLossy: true,
    signal,
  });
}

async function fetchSubscriptionWithFallback(
  url: string,
  userAgent: string | null,
  maxRedirects: number,
  sourceId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<FetchedSubscription> {
  let requestAttempt = 0;
  const fetch = async (agent: string | null) => {
    if (signal.aborted) throw new ConversionError("cancelled", "处理已取消。");
    const activeRequestId = `${requestId}:${++requestAttempt}`;
    const cancelRequest = () => {
      void invoke<boolean>("cancel_subscription", { requestId: activeRequestId }).catch(() => undefined);
    };
    activeFetchRequests.add(activeRequestId);
    signal.addEventListener("abort", cancelRequest, { once: true });
    if (signal.aborted) cancelRequest();
    try {
      return await invoke<FetchedSubscription>("fetch_subscription", {
        url,
        userAgent: agent,
        requestId: activeRequestId,
        skipCertificateVerification: shouldSkipCertificateVerification(),
        allowLocalNetwork: shouldAllowLocalNetwork(),
        maxRedirects,
      });
    } finally {
      signal.removeEventListener("abort", cancelRequest);
      activeFetchRequests.delete(activeRequestId);
    }
  };

  let fetched = await fetch(userAgent);
  if (userAgent !== null) return fetched;
  let probe = await probeSubscription(fetched.content, sourceId, signal);
  if (!shouldRetryAutomaticUserAgent(probe)) return fetched;

  const tried = new Set([fetched.usedUserAgent]);
  for (const agent of Object.values(USER_AGENT_PRESETS)) {
    if (cancelRequested) return fetched;
    if (tried.has(agent)) continue;
    tried.add(agent);
    appendLog(`远程订阅 ${displayUrl(url)}：内容无法识别，改用 ${agent} 重试`);
    try {
      const candidate = await fetch(agent);
      const candidateProbe = await probeSubscription(candidate.content, sourceId, signal);
      fetched = candidate;
      probe = candidateProbe;
      if (!shouldRetryAutomaticUserAgent(candidateProbe)) return candidate;
    } catch (error) {
      appendLog(`User-Agent ${agent} 重试失败：${failureFrom(error).message}`);
    }
  }
  return fetched;
}

async function startConversion() {
  if (running) return;

  const input = readImportInput();
  if (!input) return;

  let userAgent: string | null = null;
  let fetchConcurrency = MIN_FETCH_CONCURRENCY;
  let fetchConcurrencySetting: FetchConcurrencySetting | null = null;
  let maxRedirects = 0;
  if (input.urls.length > 0) {
    try {
      userAgent = resolveUserAgent();
      fetchConcurrencySetting = resolveFetchConcurrencySetting();
      fetchConcurrency = resolveFetchConcurrency(fetchConcurrencySetting, input.urls.length);
      maxRedirects = resolveMaxRedirects();
    } catch (error) {
      showToast(failureFrom(error).message, true);
      return;
    }
  }

  cancelRequested = false;
  activeSourceDocuments = [];
  const runController = new AbortController();
  conversionAbort = runController;
  fetchRunId++;

  // 本地内容与每个远程订阅分别保留来源 ID，统一进入转换管线。
  const hasLocal = input.local.length > 0;
  const localContent = hasLocal ? input.local.join("\n") : undefined;
  const localBytes = hasLocal ? new Blob([input.local.join("\n")]).size : 0;
  let accumulatedContentBytes = localBytes;
  const localInputDiagnostics: Diagnostic[] = [];
  if (hasLocal && input.fragmentsTruncated) {
    localInputDiagnostics.push(diagnostic(
      { sourceId: "local", stage: "preprocess" },
      "fragment_limit",
      "warning",
      "Input expansion stopped at the configured fragment limit.",
    ));
  }
  if (hasLocal && input.uriLimitReached) {
    localInputDiagnostics.push(diagnostic(
      { sourceId: "local", stage: "preprocess" },
      "uri_limit",
      "warning",
      "URI extraction stopped at the 100,000 node limit.",
    ));
  }
  if (hasLocal && input.decodedTooLarge > 0) {
    localInputDiagnostics.push(diagnostic(
      { sourceId: "local", stage: "preprocess" },
      "decoded_fragment_too_large",
      "warning",
      `${input.decodedTooLarge} decoded fragment(s) exceeded the 64 MiB limit.`,
    ));
  }
  if (hasLocal && input.depthLimited) {
    localInputDiagnostics.push(diagnostic(
      { sourceId: "local", stage: "preprocess" },
      "recursion_limit",
      "warning",
      "Base64 expansion stopped at depth 16.",
    ));
  }
  const remoteOffset = hasLocal ? 1 : 0;
  const totalSources = input.urls.length + remoteOffset;
  const remainingBatchBytes = Math.max(0, MAX_BATCH_INPUT_BYTES - localBytes);
  const canFetchRemote = input.urls.length === 0 || remainingBatchBytes >= MIN_REMOTE_BATCH_BYTES;
  sourceResults = [];
  if (hasLocal) {
    sourceResults.push({
      sourceId: "local",
      kind: "local",
      url: "",
      state: "pending",
      nodes: [],
      diagnostics: localInputDiagnostics,
      content: localContent,
      bytes: localBytes,
    });
  }
  sourceResults.push(...input.urls.map((url, index) => ({
    sourceId: `remote-${index + 1}`,
    kind: "remote" as const,
    url,
    state: "pending" as const,
    nodes: [],
    diagnostics: [],
  })));

  dom.logList.replaceChildren();
  appendLog(`开始处理：${totalSources} 个来源`);
  if (canFetchRemote && input.urls.length > 0 && fetchConcurrencySetting) {
    appendLog(`远程请求并发：${describeFetchConcurrency(fetchConcurrencySetting, input.urls.length, fetchConcurrency)}`);
  }
  if (!hasLocal && (input.fragmentsTruncated || input.uriLimitReached || input.decodedTooLarge > 0 || input.depthLimited)) {
    appendLog("输入展开或 URI 提取触及资源上限，部分内容已跳过。", true);
  }
  if (hasLocal) {
    appendLog("本地内容：已加入统一转换队列");
  }
  if (input.urls.length > 0 && !canFetchRemote) {
    for (const source of sourceResults.slice(remoteOffset)) {
      source.state = "error";
      source.errorCode = "batch_input_too_large";
      source.errorMessage = "Local input leaves less than 1 MiB of the 64 MiB conversion limit.";
    }
    appendLog("本地输入已达到 64 MiB 上限，远程订阅未发起请求。", true);
  }

  outputUris = [];
  outputEntries = [];
  regionLookupRunId += 1;
  regionLookupState = "idle";
  cloudflareDetectionRunId += 1;
  cloudflareDetectionState = "idle";
  duplicateCount = 0;
  completedSources = sourceResults.filter(source => source.state === "error").length;

  dom.nodeCount.textContent = "0";
  dom.sourceCount.textContent = "0";
  dom.duplicateCount.textContent = "0";
  setBusy(true);
  renderOutputFilter();
  updateProgress(completedSources, totalSources);

  await runWithConcurrency(canFetchRemote ? input.urls : [], fetchConcurrency, async (url, index) => {
    const sourceIndex = remoteOffset + index;
    const source = sourceResults[sourceIndex];
    appendLog(`远程订阅 ${displayUrl(url)}：开始拉取`);
    try {
      const fetched = await fetchSubscriptionWithFallback(
        url,
        userAgent,
        maxRedirects,
        source.sourceId,
        `${fetchRunId}:${source.sourceId}`,
        runController.signal,
      );
      if (cancelRequested) {
        sourceResults[sourceIndex] = { ...source, state: "error", errorCode: "cancelled", errorMessage: "处理已取消。" };
      } else if (accumulatedContentBytes + fetched.bytes > MAX_BATCH_INPUT_BYTES) {
        sourceResults[sourceIndex] = {
          ...source,
          state: "error",
          errorCode: "batch_input_too_large",
          errorMessage: "Combined subscription content exceeds the 64 MiB conversion limit.",
        };
        appendLog(`远程订阅 ${displayUrl(url)}：内容未加入转换，合并输入超过 64 MiB 上限`, true);
      } else {
        accumulatedContentBytes += fetched.bytes;
        sourceResults[sourceIndex] = {
        ...source,
        state: "pending",
        content: fetched.content,
        bytes: fetched.bytes,
        finalUrl: fetched.finalUrl,
        usedUserAgent: fetched.usedUserAgent,
      };
        appendLog(`远程订阅 ${displayUrl(url)}：已获取 ${formatBytes(fetched.bytes)}，开始统一解析`);
      }
    } catch (error) {
      const failure = failureFrom(error);
      sourceResults[sourceIndex] = {
        ...source,
        state: "error",
        errorCode: failure.code,
        errorMessage: failure.message,
      };
      appendLog(`远程订阅 ${displayUrl(url)}：失败，${failure.message}`, true);
    } finally {
      completedSources++;
      updateProgress(completedSources, totalSources);
    }
  });

  for (const source of sourceResults) {
    if (source.state === "pending" && cancelRequested) {
      source.state = "error";
      source.errorCode = "cancelled";
      source.errorMessage = "处理已取消。";
      completedSources++;
    }
  }

  activeSourceDocuments = sourceResults
    .filter(source => source.content !== undefined && source.state === "pending")
    .map(source => ({
      sourceId: source.sourceId,
      sourceName: source.kind === "local" ? "本地内容" : displayUrl(source.url),
      content: source.content as string,
      ...(source.diagnostics.length ? { diagnostics: source.diagnostics } : {}),
    }));

  if (activeSourceDocuments.length > 0 && !cancelRequested) {
    try {
      const result = await convertSourcesInWorker(activeSourceDocuments, {
        deduplicate: shouldDeduplicateOutput(),
        includeLossy: shouldIncludeLossyOutput(),
        signal: runController.signal,
      });
      aggregateResults(result);
      if (result.cancelled) cancelRequested = true;
    } catch (error) {
      appendLog(`统一转换失败：${failureFrom(error).message}`, true);
    } finally {
      if (conversionAbort === runController) conversionAbort = null;
    }
  }
  if (conversionAbort === runController) conversionAbort = null;

  completedSources = totalSources;
  setBusy(false);
  updateProgress(totalSources, totalSources);

  const successful = sourceResults.filter(source => source.state === "success").length;
  if (cancelRequested) setProcessingStatus("已取消", "warning");
  else if (successful === totalSources) setProcessingStatus("全部完成", "done");
  else if (successful > 0) setProcessingStatus("部分完成", "warning");
  else setProcessingStatus("处理失败", "error");

  if (outputUris.length > 0) {
    dom.progressCopy.textContent = `转换完成 · ${successful} 个来源 · ${outputUris.length} 个唯一节点`;
    appendLog(`处理完成：成功 ${successful}/${totalSources} 个来源，输出 ${outputUris.length} 个唯一节点`);
    showToast(`已生成 ${outputUris.length} 个节点 URI`);
  } else {
    dom.progressCopy.textContent = cancelRequested ? "处理已取消" : "转换结束，但没有获得可用节点";
    appendLog(`处理结束：成功 ${successful}/${totalSources} 个来源，没有可用节点`, true);
    showToast("没有获得可用节点，请查看日志中的错误信息", true);
  }
  cancelRequested = false;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("clipboard_unavailable");
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "output";
}

function defaultSaveName(fileName = "all"): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `chimera-subscriptions-${safeFilePart(fileName)}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
}

async function copyUris(uris: string[], label: string) {
  if (uris.length === 0) return;
  try {
    await copyText(uris.join("\n"));
    showToast(`已复制${label}的 ${uris.length} 个节点 URI`);
  } catch {
    showToast("复制失败，请手动选择文本框内容", true);
  }
}

async function copyFilteredOutput() {
  const uris = getFilteredOutputUris();
  await copyUris(uris, isOutputFilterActive() ? "筛选结果" : "全部输出");
}

async function saveUris(uris: string[], fileName: string, label: string) {
  if (uris.length === 0) return;
  try {
    const path = await save({
      defaultPath: defaultSaveName(fileName),
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (!path) return;
    await invoke<string>("save_text_file", { path, content: uris.join("\n") });
    showToast(`已保存${label}的 ${uris.length} 个节点 URI`);
  } catch (error) {
    showToast(failureFrom(error).message || "保存文件失败", true);
  }
}

async function saveFilteredOutput() {
  const uris = getFilteredOutputUris();
  const filtered = isOutputFilterActive();
  await saveUris(uris, filtered ? "filtered" : "all", filtered ? "筛选结果" : "全部输出");
}

function bindEvents() {
  dom.convertButton.addEventListener("click", () => {
    if (running) cancelConversion();
    else void startConversion();
  });
  dom.clearLogButton.addEventListener("click", clearLog);
  dom.importClipboardButton.addEventListener("click", () => void importClipboard());
  dom.importFileButton.addEventListener("click", () => void importFile());
  dom.importQrButton.addEventListener("click", () => void importQrCode());
  dom.qrScannerClose.addEventListener("click", closeQrScanner);
  dom.qrScannerCancel.addEventListener("click", closeQrScanner);
  dom.qrScanScreenButton.addEventListener("click", () => void scanFullScreens());
  dom.qrSelectImageButton.addEventListener("click", () => dom.qrImageInput.click());
  dom.qrScanCameraButton.addEventListener("click", () => void startQrCamera());
  dom.qrImageInput.addEventListener("change", handleQrImageSelection);
  dom.qrScannerRetry.addEventListener("click", () => void startQrCamera());
  dom.qrScannerSourceBack.addEventListener("click", returnToQrSourceOptions);
  dom.qrScannerDialog.addEventListener("close", releaseQrCapture);
  dom.qrScannerDialog.addEventListener("click", event => {
    if (event.target === dom.qrScannerDialog) closeQrScanner();
  });
  syncFetchConcurrencyInput();
  dom.fetchConcurrencyMode.addEventListener("change", () => {
    syncFetchConcurrencyInput();
    if (!dom.validation.hidden) setValidation();
  });
  dom.outputFilterButton.addEventListener("click", openOutputFilterDialog);
  dom.outputColumnResetButton.addEventListener("click", resetOutputColumnWidths);
  dom.outputFilterDialogClose.addEventListener("click", () => dom.outputFilterDialog.close("cancel"));
  dom.outputFilterDialogCancel.addEventListener("click", () => dom.outputFilterDialog.close("cancel"));
  dom.outputFilterDialogSave.addEventListener("click", saveOutputFilterDialog);
  dom.outputFilterCloudflareEntry.addEventListener("change", () => {
    const value = dom.outputFilterCloudflareEntry.value;
    draftFilterCloudflareEntry = value === "yes" || value === "no" ? value : "all";
    updateOutputFilterDialogSummaries();
  });
  dom.outputFilterDialog.addEventListener("click", event => {
    if (event.target === dom.outputFilterDialog) dom.outputFilterDialog.close("cancel");
  });
  dom.chooseGeoIpDatabaseButton.addEventListener("click", () => void chooseGeoIpDatabase());
  dom.clearGeoIpDatabaseButton.addEventListener("click", clearGeoIpDatabase);
  dom.copyButton.addEventListener("click", () => void copyFilteredOutput());
  dom.saveButton.addEventListener("click", () => void saveFilteredOutput());
  dom.urls.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void startConversion();
    }
  });

  dom.userAgentSelect.addEventListener("change", () => {
    dom.customUserAgent.hidden = dom.userAgentSelect.value !== "custom";
    if (!dom.customUserAgent.hidden) dom.customUserAgent.focus();
  });

  dom.skipCertificateVerification.addEventListener("change", () => {
    dom.skipCertificateNote.hidden = !shouldSkipCertificateVerification();
  });
  dom.deduplicateOutput.addEventListener("change", refreshForOutputSettingChange);
  dom.includeLossyOutput.addEventListener("change", refreshForOutputSettingChange);

  for (const input of [dom.fetchConcurrency, dom.maxRedirects]) {
    input.addEventListener("input", () => {
      if (!dom.validation.hidden) setValidation();
    });
  }

  dom.urls.addEventListener("input", () => {
    if (!dom.validation.hidden) setValidation();
  });

  renderRegionLookupSettings();
  renderOutputFilter();
  bindPanelResizers();
  bindOutputTableColumnResizers();
  applyPanelRatios();
}

bindEvents();
