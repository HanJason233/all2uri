import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { mergeNodeSources } from "../model/proxy-node.ts";
import type { NodeMap, ProxyNode } from "../model/proxy-node.ts";

function canonical(value: unknown, seen = new Map<object, string>(), path = "$" ): unknown {
  if (value !== null && typeof value === "object") {
    const previousPath = seen.get(value);
    if (previousPath !== undefined) return { $circular: previousPath };
    seen.set(value, path);
  }
  if (Array.isArray(value)) {
    const result = value.map((child, index) => canonical(child, seen, `${path}[${index}]`));
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    const record = value as NodeMap;
    const result: NodeMap = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonical(record[key], seen, `${path}.${key}`);
    }
    seen.delete(value);
    return result;
  }
  return value;
}

export function semanticFingerprint(node: ProxyNode): string {
  // 名称和来源不参与指纹；扩展字段仍参与比较，避免把连接参数不同的节点合并。
  const settings = canonical(node.settings);
  const extensions = canonical(node.extensions);
  return JSON.stringify({
    protocol: node.protocol,
    server: node.server.trim().toLowerCase(),
    port: node.port,
    settings,
    extensions,
  });
}

export interface DeduplicationResult {
  nodes: ProxyNode[];
  diagnostics: Diagnostic[];
  duplicateCount: number;
}

export function deduplicateProxyNodes(nodes: ProxyNode[], enabled = true): DeduplicationResult {
  if (!enabled) return { nodes, diagnostics: [], duplicateCount: 0 };
  const kept = new Map<string, ProxyNode>();
  const diagnostics: Diagnostic[] = [];
  let duplicateCount = 0;
  for (const node of nodes) {
    const fingerprint = semanticFingerprint(node);
    const existing = kept.get(fingerprint);
    if (!existing) {
      kept.set(fingerprint, node);
      continue;
    }
    duplicateCount++;
    mergeNodeSources(existing, node.sources);
    const origin = node.sources[0];
    diagnostics.push(diagnostic(
      { sourceId: origin?.sourceId ?? "unknown", ...(origin?.location ? { location: origin.location } : {}), nodeId: node.id, stage: "deduplicate" },
      "duplicate_node",
      "info",
      `Semantic duplicate of node ${existing.id} was merged.`,
    ));
  }
  return { nodes: [...kept.values()], diagnostics, duplicateCount };
}
