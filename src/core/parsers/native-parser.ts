import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import type { NodeSource } from "../model/proxy-node.ts";
import { isJsonContent } from "../subscription-import/text.ts";
import { normalizeNativeValue } from "./native-normalizer.ts";
import { parserResult, type ContentParser, type ParserResult } from "./types.ts";

export function detectNativeFormat(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("proxies" in record) return "clash-json";
    if ("protocol" in record) return "xray-json";
    if (Array.isArray(record.outbounds) && record.outbounds.some(item =>
      item !== null && typeof item === "object" && "protocol" in item,
    )) return "xray-json";
    if ("outbounds" in record || "endpoints" in record) return "sing-box-json";
    if ("type" in record && "server" in record) return "sing-box";
  }
  return "native-json";
}

export function parseNativeValue(
  value: unknown,
  source: NodeSource,
  maxNodes = Number.POSITIVE_INFINITY,
): ParserResult {
  // 原生配置直接规范化为 ProxyNode，避免经过 URI 编码和二次解析造成字段损失。
  const detectedFormat = detectNativeFormat(value);
  const format = source.format === "auto" ? detectedFormat
    : source.format.endsWith("-yaml") && detectedFormat === "xray-json" ? "xray-yaml"
      : source.format.endsWith("-yaml") && detectedFormat === "sing-box-json" ? "sing-box-yaml"
        : source.format;
  const formatSource = { ...source, format };
  let normalized: ReturnType<typeof normalizeNativeValue>;
  try {
    normalized = normalizeNativeValue(value, formatSource, maxNodes);
  } catch (error) {
    return parserResult([], [diagnostic(
      { sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "native.convert" },
      "native_conversion_failed",
      "error",
      error instanceof Error ? error.message : String(error),
    )]);
  }
  return parserResult(normalized.nodes, normalized.diagnostics);
}

export function parseNativeContent(content: string, source: NodeSource, maxNodes = Number.POSITIVE_INFINITY): ParserResult {
  const diagnostics: Diagnostic[] = [];
  let value: unknown;
  try { value = JSON.parse(content); }
  catch {
    diagnostics.push(diagnostic({ sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "native.parse" }, "invalid_json", "error", "Native configuration is not valid JSON."));
    return parserResult([], diagnostics);
  }
  return parseNativeValue(value, source, maxNodes);
}
export const nativeParser: ContentParser = {
  id: "native-json",
  detect(content) { return isJsonContent(content.trim()); },
  parse(content, source, maxNodes) { return parseNativeContent(content, source, maxNodes); },
};
