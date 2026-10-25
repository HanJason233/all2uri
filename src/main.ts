import { invoke } from "@tauri-apps/api/core";
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
  protocol: ProxyProtocol;
  uri: string;
  countryCode: string | null;
  isCloudflare: boolean | null;
}

interface OutputFilter {
  protocols: ProxyProtocol[];
  countries: string[];
  cloudflare: boolean;
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
const MIN_RESPONSE_MIB = 1;
const MAX_RESPONSE_MIB = 64;
const MAX_REDIRECTS = 50;
const MAX_BATCH_INPUT_BYTES = 64 * 1024 * 1024;
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
const REGION_LOOKUP_METHODS_STORAGE_KEY = "all2uri.region-lookup-methods";
const GEOIP_DATABASE_PATH_STORAGE_KEY = "all2uri.geoip-database-path";
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
  const empty = (): OutputFilter => ({ protocols: [], countries: [], cloudflare: false });
  try {
    const stored = window.localStorage.getItem(OUTPUT_FILTER_STORAGE_KEY);
    if (stored === null) return empty();
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return empty();
    const candidate = parsed as Partial<OutputFilter>;
    const protocols = Array.isArray(candidate.protocols)
      ? [...new Set(candidate.protocols.filter(isProxyProtocol))]
      : [];
    const countries = Array.isArray(candidate.countries)
      ? [...new Set(candidate.countries.map(normalizeRegionCode).filter((code): code is string => code !== null))]
      : [];
    return { protocols, countries, cloudflare: candidate.cloudflare === true };
  } catch {
    return empty();
  }
}

function saveOutputFilter() {
  try {
    window.localStorage.setItem(OUTPUT_FILTER_STORAGE_KEY, JSON.stringify(outputFilter));
  } catch {
    // 筛选条件仍可在当前会话中使用；存储不可用时忽略持久化错误。
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
  importFileButton: getElement<HTMLButtonElement>("import-file-button"),
  workspace: getElement<HTMLElement>("workspace"),
  panelResizers: Array.from(document.querySelectorAll<HTMLElement>(".panel-resizer")),
  validation: getElement<HTMLDivElement>("validation-message"),
  userAgentSelect: getElement<HTMLSelectElement>("user-agent-select"),
  customUserAgent: getElement<HTMLInputElement>("custom-user-agent"),
  fetchConcurrency: getElement<HTMLInputElement>("fetch-concurrency"),
  maxResponseMib: getElement<HTMLInputElement>("max-response-mib"),
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
  outputFilterSummary: getElement<HTMLParagraphElement>("output-filter-summary"),
  outputFilterCount: getElement<HTMLSpanElement>("output-filter-count"),
  outputFilterText: getElement<HTMLTextAreaElement>("output-filter-text"),
  outputFilterEmpty: getElement<HTMLDivElement>("output-filter-empty"),
  outputFilterDialog: getElement<HTMLDialogElement>("output-filter-dialog"),
  outputFilterDialogClose: getElement<HTMLButtonElement>("output-filter-dialog-close"),
  outputFilterDialogCancel: getElement<HTMLButtonElement>("output-filter-dialog-cancel"),
  outputFilterDialogSave: getElement<HTMLButtonElement>("output-filter-dialog-save"),
  outputFilterProtocolOptions: getElement<HTMLDivElement>("output-filter-protocol-options"),
  outputFilterProtocolSummary: getElement<HTMLSpanElement>("output-filter-protocol-summary"),
  outputFilterRegionOptions: getElement<HTMLDivElement>("output-filter-region-options"),
  outputFilterRegionSummary: getElement<HTMLSpanElement>("output-filter-region-summary"),
  outputFilterCloudflareEntry: getElement<HTMLInputElement>("output-filter-cf-entry"),
  outputFilterCloudflareSummary: getElement<HTMLSpanElement>("output-filter-cf-summary"),
  outputOverview: getElement<HTMLSpanElement>("output-overview"),
  nodeCount: getElement<HTMLElement>("node-count"),
  sourceCount: getElement<HTMLElement>("source-count"),
  duplicateCount: getElement<HTMLElement>("duplicate-count"),
  copyButton: getElement<HTMLButtonElement>("copy-button"),
  saveButton: getElement<HTMLButtonElement>("save-button"),
  toast: getElement<HTMLDivElement>("toast"),
  inputPanel: getElement<HTMLElement>("input-panel"),
  processingPanel: getElement<HTMLElement>("processing-panel"),
  outputPanel: getElement<HTMLElement>("output-panel"),
  inputDetailButton: getElement<HTMLButtonElement>("input-detail-button"),
  processingDetailButton: getElement<HTMLButtonElement>("processing-detail-button"),
  outputDetailButton: getElement<HTMLButtonElement>("output-detail-button"),
  detailBackdrop: getElement<HTMLDivElement>("detail-backdrop"),
};

interface DetailView {
  panel: HTMLElement;
  button: HTMLButtonElement;
}

interface ResizeState {
  index: number;
  pointerId: number;
  startX: number;
  availableWidth: number;
  startRatios: number[];
}

const detailViews: DetailView[] = [
  { panel: dom.inputPanel, button: dom.inputDetailButton },
  { panel: dom.processingPanel, button: dom.processingDetailButton },
  { panel: dom.outputPanel, button: dom.outputDetailButton },
];

const MIN_PANEL_WIDTH = 200;
const SPLITTER_WIDTH = 9;
const DEFAULT_PANEL_RATIOS = [0.29, 0.42, 0.29];

let activeDetail: DetailView | null = null;
let panelRatios = [...DEFAULT_PANEL_RATIOS];
let resizeState: ResizeState | null = null;
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
let draftFilterCloudflare = false;
let duplicateCount = 0;
let activeSourceDocuments: SourceDocument[] = [];
let conversionAbort: AbortController | null = null;
let cancelRequested = false;
let running = false;
let completedSources = 0;
let fetchRunId = 0;
const activeFetchRequests = new Set<string>();
let toastTimer: number | undefined;

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

function closeDetail(focusTrigger = true) {
  if (!activeDetail) return;
  const { panel, button } = activeDetail;
  panel.classList.remove("is-expanded");
  panel.removeAttribute("role");
  panel.removeAttribute("aria-modal");
  button.textContent = "查看详情";
  button.setAttribute("aria-expanded", "false");
  dom.detailBackdrop.hidden = true;
  document.body.classList.remove("detail-open");
  activeDetail = null;
  if (focusTrigger) button.focus();
}

function openDetail(view: DetailView) {
  if (activeDetail && activeDetail !== view) closeDetail(false);
  activeDetail = view;
  view.panel.classList.add("is-expanded");
  view.panel.setAttribute("role", "dialog");
  view.panel.setAttribute("aria-modal", "true");
  view.button.textContent = "收起详情";
  view.button.setAttribute("aria-expanded", "true");
  dom.detailBackdrop.hidden = false;
  document.body.classList.add("detail-open");
}

function toggleDetail(view: DetailView) {
  if (activeDetail === view) closeDetail();
  else openDetail(view);
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

// 文件只作为文本来源，后续仍走同一套智能识别逻辑。
async function importFile() {
  if (running) return;
  try {
    const selected = await open({ multiple: true, directory: false });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const imported = await Promise.all(paths.map(path => invoke<string>("read_text_file", { path })));
    const nonempty = imported.filter(content => content.trim());
    if (!nonempty.length) {
      showToast("文件内容为空", true);
      return;
    }
    const appended = nonempty.join("\n---\n");
    const combined = [dom.urls.value.trimEnd(), appended].filter(Boolean).join("\n---\n");
    if (new Blob([combined]).size > 64 * 1024 * 1024) {
      showToast("追加后输入超过 64 MiB 上限", true);
      return;
    }
    dom.urls.value = combined;
    setValidation();
    showToast(`已追加 ${nonempty.length} 个文件`);
  } catch (error) {
    showToast(failureFrom(error).message || "读取文件失败", true);
  }
}

function resolveRequestLimits(): { maxResponseBytes: number; maxRedirects: number } {
  const maxResponseMib = dom.maxResponseMib.valueAsNumber;
  if (!Number.isInteger(maxResponseMib) || maxResponseMib < MIN_RESPONSE_MIB || maxResponseMib > MAX_RESPONSE_MIB) {
    setValidation(`响应上限必须是 ${MIN_RESPONSE_MIB} 到 ${MAX_RESPONSE_MIB} MiB 之间的整数。`);
    dom.maxResponseMib.focus();
    throw new ConversionError("invalid_response_limit", "响应上限设置无效。");
  }

  const maxRedirects = dom.maxRedirects.valueAsNumber;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    setValidation(`最大重定向必须是 0 到 ${MAX_REDIRECTS} 之间的整数。`);
    dom.maxRedirects.focus();
    throw new ConversionError("invalid_redirect_limit", "重定向设置无效。");
  }

  return { maxResponseBytes: maxResponseMib * 1024 * 1024, maxRedirects };
}

function resolveFetchConcurrency(): number {
  const concurrency = dom.fetchConcurrency.valueAsNumber;
  if (!Number.isInteger(concurrency) || concurrency < MIN_FETCH_CONCURRENCY || concurrency > MAX_FETCH_CONCURRENCY) {
    setValidation(`并发数量必须是 ${MIN_FETCH_CONCURRENCY} 到 ${MAX_FETCH_CONCURRENCY} 之间的整数。`);
    dom.fetchConcurrency.focus();
    throw new ConversionError("invalid_concurrency", "并发数量设置无效。");
  }
  return concurrency;
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
  dom.importFileButton.disabled = busy;
  dom.userAgentSelect.disabled = busy;
  dom.customUserAgent.disabled = busy;
  dom.fetchConcurrency.disabled = busy;
  dom.maxResponseMib.disabled = busy;
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
  return !outputFilter.cloudflare || entry.isCloudflare === true;
}

function getFilteredOutputEntries(): CategorizedOutput[] {
  return outputEntries.filter(outputEntryMatchesFilter);
}

function getFilteredOutputUris(): string[] {
  return getFilteredOutputEntries().map(entry => entry.uri);
}

function isOutputFilterActive(): boolean {
  return outputFilter.protocols.length > 0 || outputFilter.countries.length > 0 || outputFilter.cloudflare;
}

function outputFilterSummaryText(): string {
  if (!isOutputFilterActive()) return "全部节点";
  const parts = [
    outputFilter.protocols.length ? outputFilter.protocols.map(getProtocolLabel).join(" / ") : "全部类型",
    outputFilter.countries.length ? outputFilter.countries.map(countryNameForCode).join("、") : "全部地区",
  ];
  if (outputFilter.cloudflare) parts.push("CF 入口");
  return parts.join(" · ");
}

function filteredResultEmptyText(): string {
  if (outputFilter.cloudflare && cloudflareDetectionState === "running") return "正在检查服务器入口 IP，完成后显示 CF 节点";
  if (outputFilter.cloudflare && cloudflareDetectionState === "error") return "CF 入口检测失败，请重新应用筛选条件";
  if (outputFilter.cloudflare && cloudflareDetectionState === "idle" && outputEntries.length > 0) return "等待 CF 入口检测";
  if (outputFilter.cloudflare && cloudflareDetectionState === "done" && outputEntries.some(entry => entry.isCloudflare === null)) {
    return "部分服务器入口无法解析，未识别的节点不会显示";
  }
  if (regionLookupState === "running") return "正在查询节点地区，完成后显示筛选结果";
  if (running) return "正在处理订阅，完成后显示筛选结果";
  if (outputFilter.countries.length > 0 && regionLookupState === "error") return "地区查询失败，请检查网络或数据库设置";
  if (outputUris.length > 0) return "当前筛选条件没有匹配到节点";
  if (sourceResults.length > 0) return "本次转换没有可用节点";
  return "等待转换结果";
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
    ? `已选 ${draftFilterProtocols.length} 种`
    : "全部类型";
  dom.outputFilterRegionSummary.textContent = draftFilterCountries.length
    ? `已选 ${draftFilterCountries.length} 个地区`
    : "全部地区";
  dom.outputFilterCloudflareSummary.textContent = draftFilterCloudflare ? "仅 CF 入口" : "全部入口";
  dom.outputFilterCloudflareEntry.checked = draftFilterCloudflare;
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
    checkbox.setAttribute("aria-label", `节点类型：${item.label}`);
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
  draftFilterCloudflare = outputFilter.cloudflare;
  renderOutputFilterDialogOptions();
  dom.outputFilterDialog.showModal();
}

function saveOutputFilterDialog() {
  outputFilter = {
    protocols: [...draftFilterProtocols],
    countries: [...draftFilterCountries],
    cloudflare: draftFilterCloudflare,
  };
  saveOutputFilter();
  dom.outputFilterDialog.close("save");
  renderOutputFilter();
  void enrichOutputCloudflare();
  dom.outputFilterButton.focus();
}

function renderOutputFilter() {
  const filteredEntries = getFilteredOutputEntries();
  const uris = filteredEntries.map(entry => entry.uri);
  const value = uris.join("\n");
  const summary = outputFilterSummaryText();

  dom.outputFilterText.value = value;
  dom.outputFilterText.hidden = uris.length === 0;
  dom.outputFilterEmpty.hidden = uris.length > 0;
  dom.outputFilterEmpty.textContent = filteredResultEmptyText();
  dom.outputFilterCount.textContent = `${uris.length} 个节点 · ${formatBytes(new Blob([value]).size)}`;
  dom.outputFilterSummary.textContent = summary;
  dom.outputFilterSummary.title = summary;

  const regionStatus = regionLookupState === "running" ? " · 地区查询中" : "";
  const cloudflareCount = outputEntries.filter(entry => entry.isCloudflare === true).length;
  const unresolvedCloudflareCount = outputEntries.filter(entry => entry.isCloudflare === null).length;
  const cloudflareStatus = cloudflareDetectionState === "running" && outputFilter.cloudflare
    ? " · CF 入口检测中"
    : cloudflareDetectionState === "done" && outputFilter.cloudflare
      ? ` · CF 入口 ${cloudflareCount} 个${unresolvedCloudflareCount > 0 ? `（${unresolvedCloudflareCount} 个未解析）` : ""}`
      : "";
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
  if (!outputFilter.cloudflare) {
    if (cloudflareDetectionState === "running") {
      cloudflareDetectionRunId += 1;
      cloudflareDetectionState = "idle";
    }
    return;
  }
  if (cloudflareDetectionState === "running") return;
  if (cloudflareDetectionState === "done" && entries.every(entry => entry.isCloudflare !== null)) return;

  const runId = ++cloudflareDetectionRunId;
  cloudflareDetectionState = "running";
  for (const entry of entries) entry.isCloudflare = null;
  renderOutputFilter();
  try {
    const results = await invoke<Array<{ id: string; isCloudflare: boolean | null }>>("lookup_cloudflare_entries", {
      nodes: entries.map(({ id, server }) => ({ id, server })),
    });
    if (runId !== cloudflareDetectionRunId) return;
    const resultById = new Map(results.map(result => [result.id, result.isCloudflare]));
    for (const entry of entries) entry.isCloudflare = resultById.get(entry.id) ?? null;
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
  requestLimits: { maxResponseBytes: number; maxRedirects: number },
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
        maxResponseBytes: requestLimits.maxResponseBytes,
        maxRedirects: requestLimits.maxRedirects,
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
  let requestLimits = { maxResponseBytes: MIN_RESPONSE_MIB * 1024 * 1024, maxRedirects: 0 };
  if (input.urls.length > 0) {
    try {
      userAgent = resolveUserAgent();
      fetchConcurrency = resolveFetchConcurrency();
      requestLimits = resolveRequestLimits();
    } catch (error) {
      showToast(failureFrom(error).message, true);
      return;
    }
  }

  closeDetail(false);

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
  const canFetchRemote = input.urls.length === 0 || remainingBatchBytes >= MIN_RESPONSE_MIB * 1024 * 1024;
  const configuredResponseLimit = requestLimits.maxResponseBytes;
  const configuredFetchConcurrency = fetchConcurrency;
  if (canFetchRemote && input.urls.length > 0) {
    const effectiveResponseLimit = Math.min(requestLimits.maxResponseBytes, remainingBatchBytes);
    requestLimits = { ...requestLimits, maxResponseBytes: effectiveResponseLimit };
    fetchConcurrency = Math.min(
      fetchConcurrency,
      Math.max(1, Math.floor(remainingBatchBytes / effectiveResponseLimit)),
    );
  }

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
  } else if (requestLimits.maxResponseBytes < configuredResponseLimit || fetchConcurrency < configuredFetchConcurrency) {
    appendLog(`为控制合并输入大小，单个响应上限调整为 ${formatBytes(requestLimits.maxResponseBytes)}，并发调整为 ${fetchConcurrency}。`);
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
        requestLimits,
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
  dom.importFileButton.addEventListener("click", () => void importFile());
  dom.outputFilterButton.addEventListener("click", openOutputFilterDialog);
  dom.outputFilterDialogClose.addEventListener("click", () => dom.outputFilterDialog.close("cancel"));
  dom.outputFilterDialogCancel.addEventListener("click", () => dom.outputFilterDialog.close("cancel"));
  dom.outputFilterDialogSave.addEventListener("click", saveOutputFilterDialog);
  dom.outputFilterCloudflareEntry.addEventListener("change", () => {
    draftFilterCloudflare = dom.outputFilterCloudflareEntry.checked;
    updateOutputFilterDialogSummaries();
  });
  dom.outputFilterDialog.addEventListener("click", event => {
    if (event.target === dom.outputFilterDialog) dom.outputFilterDialog.close("cancel");
  });
  dom.chooseGeoIpDatabaseButton.addEventListener("click", () => void chooseGeoIpDatabase());
  dom.clearGeoIpDatabaseButton.addEventListener("click", clearGeoIpDatabase);
  dom.copyButton.addEventListener("click", () => void copyFilteredOutput());
  dom.saveButton.addEventListener("click", () => void saveFilteredOutput());
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (activeDetail) {
      closeDetail();
      return;
    }
  });

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

  for (const view of detailViews) {
    view.button.addEventListener("click", () => toggleDetail(view));
  }
  dom.detailBackdrop.addEventListener("click", () => closeDetail());

  for (const input of [dom.fetchConcurrency, dom.maxResponseMib, dom.maxRedirects]) {
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
  applyPanelRatios();
}

bindEvents();
