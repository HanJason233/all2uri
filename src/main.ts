import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { detectSubscriptionInput } from "./core/subscription-import/index.ts";
import { convertSourcesInWorker } from "./core/worker-client.ts";
import { diagnostic } from "./core/diagnostics/index.ts";
import type { Diagnostic } from "./core/diagnostics/index.ts";
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
type SettingsView = "input" | "processing" | "output";

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
  includeLossyOutput: getElement<HTMLButtonElement>("include-lossy-output"),
  skipCertificateVerification: getElement<HTMLButtonElement>("skip-certificate-verification"),
  skipCertificateNote: getElement<HTMLParagraphElement>("skip-certificate-note"),
  allowLocalNetwork: getElement<HTMLButtonElement>("allow-local-network"),
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

function shouldAllowLocalNetwork(): boolean {
  return dom.allowLocalNetwork.getAttribute("aria-pressed") === "true";
}

function toggleCertificateVerification() {
  const skip = !shouldSkipCertificateVerification();
  dom.skipCertificateVerification.setAttribute("aria-pressed", String(skip));
  dom.skipCertificateNote.hidden = !skip;
}

function shouldDeduplicateOutput(): boolean {
  return dom.deduplicateOutput.getAttribute("aria-pressed") !== "false";
}

function shouldIncludeLossyOutput(): boolean {
  return dom.includeLossyOutput.getAttribute("aria-pressed") === "true";
}

function toggleOutputDeduplication() {
  const deduplicate = !shouldDeduplicateOutput();
  dom.deduplicateOutput.setAttribute("aria-pressed", String(deduplicate));
  if (!running && activeSourceDocuments.length > 0) void refreshConversion();
}

function toggleLossyOutput() {
  const includeLossy = !shouldIncludeLossyOutput();
  dom.includeLossyOutput.setAttribute("aria-pressed", String(includeLossy));
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

function aggregateResults(result: ConversionResult, logDiagnostics = true) {
  outputUris = [...result.uris];
  duplicateCount = result.stats.duplicates;
  const allowed = new Set(result.encoded
    .filter(item => item.uri && (item.status === "complete" || (shouldIncludeLossyOutput() && item.status === "lossy")))
    .map(item => item.uri as string));

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

  const hasOutput = outputUris.length > 0;
  dom.output.value = outputUris.join("\n");
  dom.outputSize.textContent = `${outputUris.length} 条 · ${formatBytes(new Blob([dom.output.value]).size)}`;
  dom.outputArea.hidden = !hasOutput;
  dom.emptyState.hidden = hasOutput;
  if (!hasOutput) dom.emptyStateTitle.textContent = sourceResults.length > 0 ? "没有可用节点" : "等待输出";
  if (logDiagnostics) appendConversionDiagnostics(result);
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

  closeSettings(false);
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
  dom.processingEmpty.hidden = true;
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
  duplicateCount = 0;
  completedSources = sourceResults.filter(source => source.state === "error").length;

  dom.nodeCount.textContent = "0";
  dom.sourceCount.textContent = "0";
  dom.duplicateCount.textContent = "0";
  dom.outputArea.hidden = true;
  dom.emptyState.hidden = false;
  dom.emptyStateTitle.textContent = "正在转换";
  setBusy(true);
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
  dom.convertButton.addEventListener("click", () => {
    if (running) cancelConversion();
    else void startConversion();
  });
  dom.clearLogButton.addEventListener("click", clearLog);
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
  dom.includeLossyOutput.addEventListener("click", toggleLossyOutput);
  dom.allowLocalNetwork.addEventListener("click", () => {
    const enabled = !shouldAllowLocalNetwork();
    dom.allowLocalNetwork.setAttribute("aria-pressed", String(enabled));
  });

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
