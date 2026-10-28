import { invoke } from "@tauri-apps/api/core";
import type { ProxyNode, ProxyProtocol } from "./core/model/proxy-node.ts";
import { buildSingBoxTestProfile } from "./core/testing/sing-box.ts";

export interface NodeTestEntry {
  id: string;
  name: string;
  server: string;
  port: number;
  protocol: ProxyProtocol;
  node: ProxyNode;
}

type NodeTestKind = "tcping" | "url204" | "bandwidth" | "linkType" | "unlock";

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

interface TestRow {
  entry: NodeTestEntry;
  state: "pending" | "running" | "done" | "error";
  result?: NodeTestResponse;
  error?: string;
}

interface NodeTestUiOptions {
  getEntries: () => NodeTestEntry[];
}

const DEFAULT_204_URL = "https://www.google.com/generate_204";
const DEFAULT_BANDWIDTH_URL = "https://speed.cloudflare.com/__down?bytes=25000000";

let nodeTestButton: HTMLButtonElement | null = null;

export function refreshNodeTestButton(enabled: boolean): void {
  if (nodeTestButton) nodeTestButton.disabled = !enabled || nodeTestRunning;
}

let nodeTestRunning = false;

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

function kindLabel(kind: NodeTestKind): string {
  switch (kind) {
    case "tcping": return "TCPing";
    case "url204": return "204 URL";
    case "bandwidth": return "\u5e26\u5bbd\u6d4b\u901f";
    case "linkType": return "\u94fe\u8def\u7c7b\u578b";
    case "unlock": return "\u6d41\u5a92\u4f53\u4e0e AI \u89e3\u9501";
  }
}

function kindDescription(kind: NodeTestKind): string {
  switch (kind) {
    case "tcping": return "\u76f4\u63a5\u8fde\u63a5\u8282\u70b9\u5165\u53e3 server:port\uff0c\u4e0d\u542f\u52a8\u5185\u6838\u3002";
    case "url204": return "\u901a\u8fc7\u4e34\u65f6 sing-box \u4ee3\u7406\u8bf7\u6c42 204 \u5730\u5740\uff0c\u9a8c\u8bc1\u534f\u8bae\u4e0e\u51fa\u53e3\u8fde\u901a\u6027\u3002";
    case "bandwidth": return "\u901a\u8fc7\u4e34\u65f6 sing-box \u4ee3\u7406\u6301\u7eed\u4e0b\u8f7d\u6307\u5b9a\u5730\u5740\uff0c\u8ba1\u7b97\u5e73\u5747\u4e0b\u8f7d\u5e26\u5bbd\u3002";
    case "linkType": return "\u89e3\u6790\u8282\u70b9\u5165\u53e3 IP\uff0c\u5e76\u901a\u8fc7\u4ee3\u7406\u67e5\u8be2\u51fa\u53e3 IP\uff0c\u5224\u65ad\u76f4\u8fde\u3001\u666e\u901a\u4e2d\u8f6c\u6216 CDN \u4e2d\u8f6c\u3002";
    case "unlock": return "\u901a\u8fc7\u4e34\u65f6 sing-box \u4ee3\u7406\u68c0\u6d4b 12 \u4e2a\u6d41\u5a92\u4f53\u4e0e AI \u670d\u52a1\u3002";
  }
}

function linkTypeLabel(value: string | undefined): string {
  switch (value) {
    case "direct": return "\u76f4\u8fde";
    case "relay": return "\u666e\u901a\u4e2d\u8f6c";
    case "cdn-relay": return "CDN \u4e2d\u8f6c";
    default: return "\u672a\u77e5";
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

function formatResult(kind: NodeTestKind, result: NodeTestResponse | undefined, error: string | undefined): string {
  if (error) return error;
  if (!result) return "\u7b49\u5f85\u6d4b\u8bd5";
  if (!result.success) return result.error ?? "\u6d4b\u8bd5\u5931\u8d25";
  switch (kind) {
    case "tcping":
      return result.latencyMs === undefined ? "\u8fde\u63a5\u6210\u529f" : `${result.latencyMs} ms`;
    case "url204":
      return `HTTP ${result.statusCode ?? "?"} \u00b7 ${result.latencyMs ?? "?"} ms`;
    case "bandwidth":
      return result.downloadMbps === undefined ? "\u5e26\u5bbd\u672a\u77e5" : `${result.downloadMbps.toFixed(2)} Mbps`;
    case "linkType": {
      const label = linkTypeLabel(result.linkType);
      const provider = result.cdnProvider ? ` \u00b7 ${result.cdnProvider}` : "";
      const entry = result.entryIps?.length ? `\u5165\u53e3 ${result.entryIps.join(", ")}` : "";
      const exit = result.exitIp ? `\u51fa\u53e3 ${result.exitIp}` : "";
      return [label + provider, entry, exit].filter(Boolean).join(" \u00b7 ");
    }
    case "unlock": {
      const services = result.unlock ?? [];
      const unlocked = services.filter(item => item.state === "unlocked").length;
      return `${unlocked}/${services.length} \u4e2a\u670d\u52a1\u652f\u6301`;
    }
  }
}

export function initNodeTestUi(options: NodeTestUiOptions): void {
  nodeTestButton = byId<HTMLButtonElement>("node-test-button");
  const dialog = byId<HTMLDialogElement>("node-test-dialog");
  const closeButton = byId<HTMLButtonElement>("node-test-close");
  const kindSelect = byId<HTMLSelectElement>("node-test-kind");
  const concurrencyInput = byId<HTMLInputElement>("node-test-concurrency");
  const timeoutInput = byId<HTMLInputElement>("node-test-timeout");
  const urlInput = byId<HTMLInputElement>("node-test-url");
  const durationInput = byId<HTMLInputElement>("node-test-duration");
  const urlControl = byId<HTMLElement>("node-test-url-control");
  const durationControl = byId<HTMLElement>("node-test-duration-control");
  const description = byId<HTMLParagraphElement>("node-test-description");
  const scope = byId<HTMLSpanElement>("node-test-scope");
  const startButton = byId<HTMLButtonElement>("node-test-start");
  const cancelButton = byId<HTMLButtonElement>("node-test-cancel");
  const status = byId<HTMLSpanElement>("node-test-status");
  const progress = byId<HTMLElement>("node-test-progress");
  const progressBar = byId<HTMLElement>("node-test-progress-bar");
  const resultsBody = byId<HTMLTableSectionElement>("node-test-results-body");

  let rows: TestRow[] = [];
  let cancelRequested = false;
  let currentKind: NodeTestKind = "tcping";

  const setControlsDisabled = (disabled: boolean) => {
    kindSelect.disabled = disabled;
    concurrencyInput.disabled = disabled;
    timeoutInput.disabled = disabled;
    urlInput.disabled = disabled;
    durationInput.disabled = disabled;
    startButton.disabled = disabled;
    closeButton.disabled = disabled;
    cancelButton.disabled = !disabled;
    refreshNodeTestButton(options.getEntries().length > 0);
  };

  const updateKindControls = () => {
    currentKind = kindSelect.value as NodeTestKind;
    const needsUrl = currentKind === "url204" || currentKind === "bandwidth";
    urlControl.hidden = !needsUrl;
    durationControl.hidden = currentKind !== "bandwidth";
    if (currentKind === "url204" && (!urlInput.value || urlInput.value === DEFAULT_BANDWIDTH_URL)) {
      urlInput.value = DEFAULT_204_URL;
    } else if (currentKind === "bandwidth" && (!urlInput.value || urlInput.value === DEFAULT_204_URL)) {
      urlInput.value = DEFAULT_BANDWIDTH_URL;
    }
    description.textContent = kindDescription(currentKind);
    if (!nodeTestRunning) status.textContent = "";
  };

  const renderRows = () => {
    resultsBody.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.state = row.state;
      const nameCell = document.createElement("td");
      const name = document.createElement("strong");
      name.textContent = row.entry.name;
      const protocol = document.createElement("small");
      protocol.textContent = row.entry.protocol;
      nameCell.append(name, protocol);

      const protocolCell = document.createElement("td");
      protocolCell.textContent = `${row.entry.server}:${row.entry.port}`;

      const resultCell = document.createElement("td");
      const resultText = document.createElement("span");
      resultText.className = "node-test-result";
      resultText.textContent = formatResult(currentKind, row.result, row.error);
      resultCell.append(resultText);
      if (currentKind === "unlock" && row.result?.unlock?.length) {
        const badges = document.createElement("div");
        badges.className = "node-test-service-badges";
        for (const service of row.result.unlock) {
          const badge = document.createElement("span");
          badge.className = `node-test-service-badge state-${service.state}`;
          badge.textContent = `${service.name} \u00b7 ${unlockStateLabel(service.state)}`;
          badge.title = service.detail;
          badges.append(badge);
        }
        resultCell.append(badges);
      }
      tr.append(nameCell, protocolCell, resultCell);
      resultsBody.append(tr);
    }
  };

  const setProgress = (completed: number, total: number) => {
    const percent = total > 0 ? Math.round(completed / total * 100) : 0;
    progress.hidden = false;
    progressBar.style.width = `${percent}%`;
    progressBar.parentElement?.setAttribute("aria-valuenow", String(percent));
  };

  const openDialog = () => {
    const entries = options.getEntries();
    if (entries.length === 0) return;
    rows = entries.map(entry => ({ entry, state: "pending" }));
    cancelRequested = false;
    status.textContent = "";
    scope.textContent = `\u5f53\u524d\u7b5b\u9009\u7ed3\u679c\uff1a${entries.length} \u4e2a\u8282\u70b9`;
    progress.hidden = true;
    progressBar.style.width = "0%";
    updateKindControls();
    renderRows();
    if (!dialog.open) dialog.showModal();
  };

  const runTests = async () => {
    if (nodeTestRunning) return;
    const entries = options.getEntries();
    if (entries.length === 0) return;
    const kind = kindSelect.value as NodeTestKind;
    const concurrency = clampNumber(concurrencyInput.value, 3, 1, 8);
    const timeoutMs = clampNumber(timeoutInput.value, 10_000, 1_000, 120_000);
    const durationMs = clampNumber(durationInput.value, 3_000, 1_000, 60_000);
    const testUrl = urlInput.value.trim();
    if ((kind === "url204" || kind === "bandwidth") && !testUrl) {
      status.textContent = "\u8bf7\u586b\u5199\u6d4b\u8bd5\u5730\u5740";
      return;
    }

    rows = entries.map(entry => ({ entry, state: "pending" }));
    nodeTestRunning = true;
    cancelRequested = false;
    setControlsDisabled(true);
    setProgress(0, rows.length);
    status.textContent = `\u6b63\u5728\u6d4b\u8bd5 ${kindLabel(kind)}`;
    renderRows();

    let nextIndex = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const worker = async () => {
      while (!cancelRequested) {
        const index = nextIndex++;
        if (index >= rows.length) return;
        const row = rows[index];
        row.state = "running";
        renderRows();
        try {
          const profile = kind === "tcping" ? undefined : buildSingBoxTestProfile(row.entry.node);
          if (kind !== "tcping" && !profile?.profile) {
            throw new Error(profile?.error ?? "\u65e0\u6cd5\u751f\u6210 sing-box \u914d\u7f6e");
          }
          const result = await invoke<NodeTestResponse>("run_node_test", {
            request: {
              server: row.entry.server,
              port: row.entry.port,
              kind,
              outbound: profile?.profile?.outbound ?? null,
              endpoint: profile?.profile?.endpoint ?? null,
              url: kind === "url204" || kind === "bandwidth" ? testUrl : null,
              timeoutMs,
              durationMs,
            },
          });
          row.result = result;
          row.state = result.success ? "done" : "error";
          if (!result.success) row.error = result.error ?? "\u6d4b\u8bd5\u5931\u8d25";
          if (result.success) succeeded++;
          else failed++;
        } catch (error) {
          row.state = "error";
          row.error = errorMessage(error);
          failed++;
        }
        completed++;
        setProgress(completed, rows.length);
        status.textContent = `\u5df2\u5b8c\u6210 ${completed}/${rows.length}`;
        renderRows();
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
    nodeTestRunning = false;
    setControlsDisabled(false);
    if (cancelRequested) {
      status.textContent = `\u5df2\u53d6\u6d88\uff0c\u5df2\u5b8c\u6210 ${completed}/${rows.length}`;
    } else {
      status.textContent = `\u6d4b\u8bd5\u5b8c\u6210\uff1a\u6210\u529f ${succeeded}\uff0c\u5931\u8d25 ${failed}`;
    }
    refreshNodeTestButton(options.getEntries().length > 0);
  };

  nodeTestButton.addEventListener("click", openDialog);
  closeButton.addEventListener("click", () => dialog.close());
  kindSelect.addEventListener("change", updateKindControls);
  startButton.addEventListener("click", () => void runTests());
  cancelButton.addEventListener("click", () => {
    cancelRequested = true;
    cancelButton.disabled = true;
    status.textContent = "\u6b63\u5728\u53d6\u6d88\uff0c\u7b49\u5f85\u5f53\u524d\u6d4b\u8bd5\u7ed3\u675f\u2026";
  });
  dialog.addEventListener("cancel", event => {
    if (nodeTestRunning) event.preventDefault();
  });
  dialog.addEventListener("click", event => {
    if (event.target === dialog && !nodeTestRunning) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (!nodeTestRunning) status.textContent = "";
  });
  updateKindControls();
  refreshNodeTestButton(options.getEntries().length > 0);
}
