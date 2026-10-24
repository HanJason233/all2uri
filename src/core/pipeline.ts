import { diagnostic } from "./diagnostics/index.ts";
import type { Diagnostic } from "./diagnostics/index.ts";
import { deduplicateProxyNodes } from "./deduplication/index.ts";
import { encodeProxyNode } from "./encoders/uri-encoder.ts";
import type { EncodedProxyNode } from "./encoders/uri-encoder.ts";
import { preprocessInput, DEFAULT_PREPROCESS_LIMITS } from "./input/preprocessor.ts";
import type { PreprocessLimits } from "./input/preprocessor.ts";
import type { NodeSource, ProxyNode } from "./model/proxy-node.ts";
import { parseContent } from "./parsers/registry.ts";

export interface SourceDocument {
  sourceId: string;
  sourceName?: string;
  content: string;
  format?: string;
  diagnostics?: Diagnostic[];
}

export interface ConversionOptions {
  includeLossy?: boolean;
  deduplicate?: boolean;
  limits?: Partial<PreprocessLimits>;
  signal?: AbortSignal;
}

export interface SourceStats {
  sourceId: string;
  fragmentCount: number;
  parsedNodes: number;
  outputNodes: number;
  warnings: number;
  errors: number;
}

export interface ConversionStats {
  sourceCount: number;
  fragmentCount: number;
  parsedNodes: number;
  validNodes: number;
  outputNodes: number;
  complete: number;
  lossy: number;
  invalid: number;
  unsupported: number;
  duplicates: number;
}

export interface ConversionResult {
  uris: string[];
  nodes: ProxyNode[];
  encoded: EncodedProxyNode[];
  diagnostics: Diagnostic[];
  sourceStats: SourceStats[];
  stats: ConversionStats;
  cancelled: boolean;
}

// 每个来源独立预处理和解析；节点总数仍受整批输入的统一上限约束。
function sourceContext(source: SourceDocument): NodeSource {
  return {
    sourceId: source.sourceId,
    ...(source.sourceName ? { sourceName: source.sourceName } : {}),
    format: source.format ?? "auto",
  };
}

function createSourceStat(sourceId: string, fragmentCount: number, parsedNodes: number): SourceStats {
  return { sourceId, fragmentCount, parsedNodes, outputNodes: 0, warnings: 0, errors: 0 };
}

function finishConversion(
  sources: SourceDocument[],
  options: ConversionOptions,
  diagnostics: Diagnostic[],
  sourceStats: SourceStats[],
  parsed: ProxyNode[],
  cancelled: boolean,
): ConversionResult {
  const deduped = deduplicateProxyNodes(parsed, options.deduplicate !== false);
  diagnostics.push(...deduped.diagnostics);
  const encoded = deduped.nodes.map(encodeProxyNode);
  for (const item of encoded) diagnostics.push(...item.diagnostics);
  const includeLossy = options.includeLossy ?? false;
  const output = encoded.filter(item => item.uri && (item.status === "complete" || (includeLossy && item.status === "lossy")));
  const outputNodes = output.map(item => item.node);
  const uris = output.map(item => item.uri as string);

  for (const stat of sourceStats) {
    stat.outputNodes = outputNodes.filter(node => node.sources.some(source => source.sourceId === stat.sourceId)).length;
    stat.warnings = diagnostics.filter(item => item.sourceId === stat.sourceId && item.severity === "warning").length;
    stat.errors = diagnostics.filter(item => item.sourceId === stat.sourceId && item.severity === "error").length;
  }

  return {
    uris,
    nodes: outputNodes,
    encoded,
    diagnostics,
    sourceStats,
    cancelled,
    stats: {
      sourceCount: sources.length,
      fragmentCount: sourceStats.reduce((sum, item) => sum + item.fragmentCount, 0),
      parsedNodes: parsed.length,
      validNodes: encoded.filter(item => item.status !== "invalid" && item.status !== "unsupported").length,
      outputNodes: outputNodes.length,
      complete: encoded.filter(item => item.status === "complete").length,
      lossy: encoded.filter(item => item.status === "lossy").length,
      invalid: encoded.filter(item => item.status === "invalid").length,
      unsupported: encoded.filter(item => item.status === "unsupported").length,
      duplicates: deduped.duplicateCount,
    },
  };
}

function recordCancellation(diagnostics: Diagnostic[], sourceId: string): void {
  diagnostics.push(diagnostic({ sourceId, stage: "pipeline" }, "cancelled", "warning", "Conversion was cancelled."));
}

export function convertSources(sources: SourceDocument[], options: ConversionOptions = {}): ConversionResult {
  const limits = { ...DEFAULT_PREPROCESS_LIMITS, ...(options.limits ?? {}) };
  const diagnostics: Diagnostic[] = [];
  const sourceStats: SourceStats[] = [];
  const parsed: ProxyNode[] = [];
  let cancelled = false;
  let nodeLimitReported = false;

  for (const source of sources) {
    if (source.diagnostics?.length) diagnostics.push(...source.diagnostics);
    if (options.signal?.aborted) {
      cancelled = true;
      recordCancellation(diagnostics, source.sourceId);
      sourceStats.push(createSourceStat(source.sourceId, 0, 0));
      continue;
    }
    if (parsed.length >= limits.maxNodes) {
      if (!nodeLimitReported) {
        diagnostics.push(diagnostic({ sourceId: source.sourceId, stage: "pipeline" }, "node_limit", "warning", `Node count was capped at ${limits.maxNodes}.`));
        nodeLimitReported = true;
      }
      sourceStats.push(createSourceStat(source.sourceId, 0, 0));
      continue;
    }

    const preprocessed = preprocessInput(source.content, source.sourceId, limits);
    diagnostics.push(...preprocessed.diagnostics);
    const nodeSource = sourceContext(source);
    let parsedForSource = 0;
    for (const [fragmentIndex, fragment] of preprocessed.fragments.entries()) {
      if (options.signal?.aborted) {
        cancelled = true;
        recordCancellation(diagnostics, source.sourceId);
        break;
      }
      const available = Math.max(0, limits.maxNodes - parsed.length);
      const result = parseContent(fragment, { ...nodeSource, location: `fragment[${fragmentIndex}]` }, available);
      diagnostics.push(...result.diagnostics);
      const accepted = result.nodes.slice(0, available);
      parsedForSource += accepted.length;
      parsed.push(...accepted);
      if (accepted.length < result.nodes.length) {
        diagnostics.push(diagnostic({ sourceId: source.sourceId, stage: "pipeline" }, "node_limit", "warning", `Node count was capped at ${limits.maxNodes}.`));
        nodeLimitReported = true;
        break;
      }
    }
    sourceStats.push(createSourceStat(source.sourceId, preprocessed.fragments.length, parsedForSource));
  }

  return finishConversion(sources, options, diagnostics, sourceStats, parsed, cancelled);
}

export async function convertSourcesAsync(sources: SourceDocument[], options: ConversionOptions = {}): Promise<ConversionResult> {
  const limits = { ...DEFAULT_PREPROCESS_LIMITS, ...(options.limits ?? {}) };
  const diagnostics: Diagnostic[] = [];
  const sourceStats: SourceStats[] = [];
  const parsed: ProxyNode[] = [];
  let cancelled = false;
  let nodeLimitReported = false;

  for (const source of sources) {
    if (source.diagnostics?.length) diagnostics.push(...source.diagnostics);
    if (options.signal?.aborted) {
      cancelled = true;
      recordCancellation(diagnostics, source.sourceId);
      sourceStats.push(createSourceStat(source.sourceId, 0, 0));
      continue;
    }
    if (parsed.length >= limits.maxNodes) {
      if (!nodeLimitReported) {
        diagnostics.push(diagnostic({ sourceId: source.sourceId, stage: "pipeline" }, "node_limit", "warning", `Node count was capped at ${limits.maxNodes}.`));
        nodeLimitReported = true;
      }
      sourceStats.push(createSourceStat(source.sourceId, 0, 0));
      continue;
    }

    const preprocessed = preprocessInput(source.content, source.sourceId, limits);
    diagnostics.push(...preprocessed.diagnostics);
    const nodeSource = sourceContext(source);
    let parsedForSource = 0;
    for (const [fragmentIndex, fragment] of preprocessed.fragments.entries()) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (options.signal?.aborted) {
        cancelled = true;
        recordCancellation(diagnostics, source.sourceId);
        break;
      }
      const available = Math.max(0, limits.maxNodes - parsed.length);
      const result = parseContent(fragment, { ...nodeSource, location: `fragment[${fragmentIndex}]` }, available);
      diagnostics.push(...result.diagnostics);
      const accepted = result.nodes.slice(0, available);
      parsedForSource += accepted.length;
      parsed.push(...accepted);
      if (accepted.length < result.nodes.length) {
        diagnostics.push(diagnostic({ sourceId: source.sourceId, stage: "pipeline" }, "node_limit", "warning", `Node count was capped at ${limits.maxNodes}.`));
        nodeLimitReported = true;
        break;
      }
    }
    sourceStats.push(createSourceStat(source.sourceId, preprocessed.fragments.length, parsedForSource));
  }

  return finishConversion(sources, options, diagnostics, sourceStats, parsed, cancelled);
}

export function convertSource(source: SourceDocument, options: ConversionOptions = {}): ConversionResult {
  return convertSources([source], options);
}

export function convertText(content: string, sourceId = "local", options: ConversionOptions = {}): ConversionResult {
  return convertSource({ sourceId, sourceName: sourceId, content }, options);
}
