import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { detectSubscriptionInput, toStandardUris } from "./core/subscription-import/index.ts";

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
type SettingsView = "input" | "processing" | "output";

type SourceKind = "local" | "remote";

interface SourceResult {
  kind: SourceKind;
  url: string;
  state: SourceState;
  nodes: string[];
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

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素 #${id}`);
  return element as T;
}

const dom = {
  urls: getElement<HTMLTextAreaElement>("subscription-urls"),
  pasteButton: getElement<HTMLButtonElement>("paste-button"),
  importFileButton: getElement<HTMLButtonElement>("import-file-button"),
  settingsDialog: getElement<HTMLElement>("settings-dialog"),
  settingsBackdrop: getElement<HTMLDivElement>("settings-backdrop"),
  settingsCloseButton: getElement<HTMLButtonElement>("settings-close-button"),
  settingsButtons: Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-button")),
  settingsTitle: getElement<HTMLElement>("settings-title"),
  settingsPanes: Array.from(document.querySelectorAll<HTMLElement>(".settings-pane")),
  workspace: getElement<HTMLElement>("workspace"),
  panelResizers: Array.from(document.querySelectorAll<HTMLElement>(".panel-resizer")),
  validation: getElement<HTMLDivElement>("validation-message"),
  userAgentSelect: getElement<HTMLSelectElement>("user-agent-select"),
  customUserAgent: getElement<HTMLInputElement>("custom-user-agent"),
  fetchConcurrency: getElement<HTMLInputElement>("fetch-concurrency"),
  maxResponseMib: getElement<HTMLInputElement>("max-response-mib"),
  maxRedirects: getElement<HTMLInputElement>("max-redirects"),
  deduplicateOutput: getElement<HTMLButtonElement>("deduplicate-output"),
  skipCertificateVerification: getElement<HTMLButtonElement>("skip-certificate-verification"),
  skipCertificateNote: getElement<HTMLParagraphElement>("skip-certificate-note"),
  convertButton: getElement<HTMLButtonElement>("convert-button"),
  convertLabel: getElement<HTMLSpanElement>("convert-button").querySelector<HTMLSpanElement>(".button-label")!,
  progressCopy: getElement<HTMLDivElement>("progress-copy"),
  progressBar: getElement<HTMLSpanElement>("progress-bar"),
  processingStatus: getElement<HTMLSpanElement>("processing-status"),
  processingEmpty: getElement<HTMLDivElement>("processing-empty"),
  emptyState: getElement<HTMLDivElement>("empty-state"),
  emptyStateTitle: getElement<HTMLElement>("empty-state-title"),
  logList: getElement<HTMLDivElement>("log-list"),
  clearLogButton: getElement<HTMLButtonElement>("clear-log-button"),
  outputArea: getElement<HTMLDivElement>("output-area"),
  output: getElement<HTMLTextAreaElement>("output-uris"),
  outputSize: getElement<HTMLSpanElement>("output-size"),
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
const DEFAULT_PANEL_RATIOS = [1 / 3, 1 / 3, 1 / 3];

let activeDetail: DetailView | null = null;
let panelRatios = [...DEFAULT_PANEL_RATIOS];
let resizeState: ResizeState | null = null;
let activeSettingsView: SettingsView | null = null;
let settingsTrigger: HTMLButtonElement | null = null;
let sourceResults: SourceResult[] = [];
let outputUris: string[] = [];
let duplicateCount = 0;
let running = false;
let completedSources = 0;
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

const SETTINGS_TITLES: Record<SettingsView, string> = {
  input: "输入设置",
  processing: "处理设置",
  output: "输出设置",
};

function openSettings(view: SettingsView, trigger?: HTMLButtonElement) {
  if (activeDetail) closeDetail(false);
  if (trigger) settingsTrigger = trigger;
  else if (!activeSettingsView) settingsTrigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  activeSettingsView = view;
  dom.settingsTitle.textContent = SETTINGS_TITLES[view];
  for (const pane of dom.settingsPanes) pane.hidden = pane.dataset.settingsView !== view;
  dom.settingsDialog.hidden = false;
  dom.settingsBackdrop.hidden = false;
  document.body.classList.add("settings-open");
  const activePane = dom.settingsPanes.find(pane => pane.dataset.settingsView === view);
  window.requestAnimationFrame(() => activePane?.querySelector<HTMLElement>("select, input, button")?.focus());
}

function closeSettings(focusTrigger = true) {
  if (dom.settingsDialog.hidden) return;
  dom.settingsDialog.hidden = true;
  dom.settingsBackdrop.hidden = true;
  document.body.classList.remove("settings-open");
  const trigger = settingsTrigger;
  activeSettingsView = null;
  settingsTrigger = null;
  if (focusTrigger) trigger?.focus();
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
  closeSettings(false);
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
      openSettings("input");
      setValidation("已选择自定义 User-Agent，但输入内容为空。");
      dom.customUserAgent.focus();
      throw new ConversionError("invalid_user_agent", "自定义 User-Agent 不能为空。");
    }
    if (custom.length > 512 || /[\r\n]/.test(custom)) {
      openSettings("input");
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
}

function readImportInput(): DetectedImportInput | null {
  const value = dom.urls.value.trim();
  if (!value) {
    setValidation("请先输入订阅 URL、节点 URI 或配置内容。");
    dom.urls.focus();
    return null;
  }

  const detected = detectSubscriptionInput(value);
  if (detected.urls.length === 0 && detected.local.length === 0) {
    setValidation("未检测到有效的订阅 URL、节点 URI 或配置内容。");
    dom.urls.focus();
    return null;
  }

  setValidation();
  return detected;
}

// Windows 端使用剪贴板读取对应 Android 的剪贴板导入。
async function pasteFromClipboard() {
  if (running) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast("剪贴板为空", true);
      return;
    }
    dom.urls.value = text;
    setValidation();
    showToast("已从剪贴板粘贴");
  } catch {
    showToast("无法读取剪贴板，请使用 Ctrl+V 手动粘贴", true);
  }
}

// 文件只作为文本来源，后续仍走同一套智能识别逻辑。
async function importFile() {
  if (running) return;
  try {
    const selected = await open({ multiple: false, directory: false });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    const content = await invoke<string>("read_text_file", { path });
    if (!content.trim()) {
      showToast("文件内容为空", true);
      return;
    }
    dom.urls.value = content;
    setValidation();
    showToast("已导入文件内容");
  } catch (error) {
    showToast(failureFrom(error).message || "读取文件失败", true);
  }
}

function resolveRequestLimits(): { maxResponseBytes: number; maxRedirects: number } {
  const maxResponseMib = dom.maxResponseMib.valueAsNumber;
  if (!Number.isInteger(maxResponseMib) || maxResponseMib < MIN_RESPONSE_MIB || maxResponseMib > MAX_RESPONSE_MIB) {
    openSettings("processing");
    setValidation(`响应上限必须是 ${MIN_RESPONSE_MIB} 到 ${MAX_RESPONSE_MIB} MiB 之间的整数。`);
    dom.maxResponseMib.focus();
    throw new ConversionError("invalid_response_limit", "响应上限设置无效。");
  }

  const maxRedirects = dom.maxRedirects.valueAsNumber;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    openSettings("processing");
    setValidation(`最大重定向必须是 0 到 ${MAX_REDIRECTS} 之间的整数。`);
    dom.maxRedirects.focus();
    throw new ConversionError("invalid_redirect_limit", "重定向设置无效。");
  }

  return { maxResponseBytes: maxResponseMib * 1024 * 1024, maxRedirects };
}

function resolveFetchConcurrency(): number {
  const concurrency = dom.fetchConcurrency.valueAsNumber;
  if (!Number.isInteger(concurrency) || concurrency < MIN_FETCH_CONCURRENCY || concurrency > MAX_FETCH_CONCURRENCY) {
    openSettings("processing");
    setValidation(`并发数量必须是 ${MIN_FETCH_CONCURRENCY} 到 ${MAX_FETCH_CONCURRENCY} 之间的整数。`);
    dom.fetchConcurrency.focus();
    throw new ConversionError("invalid_concurrency", "并发数量设置无效。");
  }
  return concurrency;
}

function shouldSkipCertificateVerification(): boolean {
  return dom.skipCertificateVerification.getAttribute("aria-pressed") === "true";
}

function toggleCertificateVerification() {
  const skip = !shouldSkipCertificateVerification();
  dom.skipCertificateVerification.setAttribute("aria-pressed", String(skip));
  dom.skipCertificateNote.hidden = !skip;
}

function shouldDeduplicateOutput(): boolean {
  return dom.deduplicateOutput.getAttribute("aria-pressed") !== "false";
}

function toggleOutputDeduplication() {
  const deduplicate = !shouldDeduplicateOutput();
  dom.deduplicateOutput.setAttribute("aria-pressed", String(deduplicate));
  if (!running && sourceResults.length > 0) aggregateResults();
}

function setProcessingStatus(label: string, state: ProcessingState) {
  dom.processingStatus.textContent = label;
  dom.processingStatus.dataset.state = state;
  dom.processingStatus.hidden = state === "idle" || !label;
}

function setBusy(busy: boolean) {
  running = busy;
  dom.convertButton.disabled = busy;
  dom.urls.disabled = busy;
  dom.pasteButton.disabled = busy;
  dom.importFileButton.disabled = busy;
  dom.userAgentSelect.disabled = busy;
  dom.customUserAgent.disabled = busy;
  dom.fetchConcurrency.disabled = busy;
  dom.maxResponseMib.disabled = busy;
  dom.maxRedirects.disabled = busy;
  dom.deduplicateOutput.disabled = busy;
  dom.skipCertificateVerification.disabled = busy;
  dom.convertButton.classList.toggle("busy", busy);
  dom.convertLabel.textContent = busy ? "正在转换…" : "开始转换";
  setProcessingStatus(busy ? "处理中" : "已完成", busy ? "running" : "done");
}

function updateProgress(done: number, total: number) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  dom.progressBar.style.width = `${percent}%`;
  dom.progressCopy.textContent = running
    ? `正在处理 ${done} / ${total} 个来源 · ${percent}%`
    : `已处理 ${done} / ${total} 个来源`;
}

function aggregateResults() {
  const deduplicate = shouldDeduplicateOutput();
  const seenNodes = new Set<string>();
  const nodes: string[] = [];
  duplicateCount = 0;

  for (const source of sourceResults) {
    if (source.state !== "success") continue;
    for (const node of source.nodes) {
      const duplicate = seenNodes.has(node);
      if (duplicate) duplicateCount++;
      else seenNodes.add(node);
      if (!deduplicate || !duplicate) nodes.push(node);
    }
  }

  outputUris = nodes;
  const successfulSources = sourceResults.filter(source => source.state === "success").length;
  dom.nodeCount.textContent = String(outputUris.length);
  dom.sourceCount.textContent = String(successfulSources);
  dom.duplicateCount.textContent = String(duplicateCount);

  const hasOutput = outputUris.length > 0;
  dom.output.value = outputUris.join("\n");
  dom.outputSize.textContent = `${outputUris.length} 条 · ${formatBytes(new Blob([dom.output.value]).size)}`;
  dom.outputArea.hidden = !hasOutput;
  dom.emptyState.hidden = hasOutput;
  if (!hasOutput) {
    dom.emptyStateTitle.textContent = sourceResults.length > 0 ? "没有可用节点" : "等待输出";
  }
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
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
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

  closeSettings(false);
  closeDetail(false);

  // 本地内容先解析为一个来源，再与远程订阅并发处理。
  const hasLocal = input.local.length > 0;
  const localNodes = hasLocal ? toStandardUris(input.local) : [];
  const localBytes = hasLocal ? new Blob([input.local.join("\n")]).size : 0;
  const remoteOffset = hasLocal ? 1 : 0;
  const totalSources = input.urls.length + remoteOffset;

  sourceResults = [];
  if (hasLocal) {
    sourceResults.push(localNodes.length > 0
      ? { kind: "local", url: "", state: "success", nodes: localNodes, bytes: localBytes }
      : { kind: "local", url: "", state: "error", nodes: [], errorCode: "no_nodes", errorMessage: "本地内容未解析到可用节点。" });
  }
  sourceResults.push(...input.urls.map(url => ({ kind: "remote" as const, url, state: "pending" as const, nodes: [] })));

  dom.logList.replaceChildren();
  dom.processingEmpty.hidden = true;
  appendLog(`开始处理：${totalSources} 个来源`);
  if (hasLocal) {
    appendLog(
      localNodes.length > 0
        ? `本地内容：解析到 ${localNodes.length} 个节点`
        : "本地内容：未解析到可用节点",
      localNodes.length === 0,
    );
  }

  outputUris = [];
  duplicateCount = 0;
  completedSources = hasLocal ? 1 : 0;

  dom.nodeCount.textContent = "0";
  dom.sourceCount.textContent = "0";
  dom.duplicateCount.textContent = "0";
  dom.outputArea.hidden = true;
  dom.emptyState.hidden = false;
  dom.emptyStateTitle.textContent = "正在转换";
  setBusy(true);
  updateProgress(completedSources, totalSources);

  await runWithConcurrency(input.urls, fetchConcurrency, async (url, index) => {
    const sourceIndex = remoteOffset + index;
    appendLog(`远程订阅 ${displayUrl(url)}：开始拉取`);
    try {
      const fetched = await invoke<FetchedSubscription>("fetch_subscription", {
        url,
        userAgent,
        skipCertificateVerification: shouldSkipCertificateVerification(),
        maxResponseBytes: requestLimits.maxResponseBytes,
        maxRedirects: requestLimits.maxRedirects,
      });
      const nodes = toStandardUris(fetched.content).filter(node => !/^https?:\/\//i.test(node));
      if (nodes.length === 0) {
        throw new ConversionError(
          "no_nodes",
          "订阅内容已获取，但未找到可转换的节点；请检查订阅格式或更换 User-Agent。",
        );
      }

      sourceResults[sourceIndex] = {
        kind: "remote",
        url,
        state: "success",
        nodes,
        bytes: fetched.bytes,
        finalUrl: fetched.finalUrl,
        usedUserAgent: fetched.usedUserAgent,
      };
      appendLog(`远程订阅 ${displayUrl(url)}：成功，${nodes.length} 个节点`);
    } catch (error) {
      const failure = failureFrom(error);
      sourceResults[sourceIndex] = {
        kind: "remote",
        url,
        state: "error",
        nodes: [],
        errorCode: failure.code,
        errorMessage: failure.message,
      };
      appendLog(`远程订阅 ${displayUrl(url)}：失败，${failure.message}`, true);
    } finally {
      completedSources++;
      updateProgress(completedSources, totalSources);
    }
  });

  aggregateResults();
  setBusy(false);
  updateProgress(totalSources, totalSources);

  const successful = sourceResults.filter(source => source.state === "success").length;
  if (successful === totalSources) setProcessingStatus("全部完成", "done");
  else if (successful > 0) setProcessingStatus("部分完成", "warning");
  else setProcessingStatus("处理失败", "error");

  if (outputUris.length > 0) {
    dom.progressCopy.textContent = `转换完成 · ${successful} 个来源 · ${outputUris.length} 个唯一节点`;
    appendLog(`处理完成：成功 ${successful}/${totalSources} 个来源，输出 ${outputUris.length} 个唯一节点`);
    showToast(`已生成 ${outputUris.length} 个节点 URI`);
  } else {
    dom.progressCopy.textContent = "转换结束，但没有获得可用节点";
    appendLog(`处理结束：成功 ${successful}/${totalSources} 个来源，没有可用节点`, true);
    showToast("没有获得可用节点，请查看日志中的错误信息", true);
  }
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

async function copyAll() {
  if (outputUris.length === 0) return;
  try {
    await copyText(dom.output.value);
    showToast(`已复制 ${outputUris.length} 个节点 URI`);
  } catch {
    showToast("复制失败，请手动选择文本框内容", true);
  }
}

function defaultSaveName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `chimera-subscriptions-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
}

async function saveAll() {
  if (outputUris.length === 0) return;
  try {
    const path = await save({
      defaultPath: defaultSaveName(),
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (!path) return;
    await invoke<string>("save_text_file", { path, content: dom.output.value });
    showToast(`已保存 ${outputUris.length} 个节点 URI`);
  } catch (error) {
    showToast(failureFrom(error).message || "保存文件失败", true);
  }
}

function bindEvents() {
  dom.convertButton.addEventListener("click", () => void startConversion());
  dom.clearLogButton.addEventListener("click", clearLog);
  dom.pasteButton.addEventListener("click", () => void pasteFromClipboard());
  dom.importFileButton.addEventListener("click", () => void importFile());
  dom.copyButton.addEventListener("click", () => void copyAll());
  dom.saveButton.addEventListener("click", () => void saveAll());
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (activeDetail) {
      closeDetail();
      return;
    }
    if (!dom.settingsDialog.hidden) closeSettings();
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

  dom.skipCertificateVerification.addEventListener("click", toggleCertificateVerification);

  for (const button of dom.settingsButtons) {
    button.addEventListener("click", () => {
      const view = button.dataset.settingsView;
      if (view === "input" || view === "processing" || view === "output") openSettings(view, button);
    });
  }
  dom.settingsCloseButton.addEventListener("click", () => closeSettings());
  dom.settingsBackdrop.addEventListener("click", () => closeSettings());
  dom.deduplicateOutput.addEventListener("click", toggleOutputDeduplication);

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

  bindPanelResizers();
  applyPanelRatios();
}

bindEvents();
