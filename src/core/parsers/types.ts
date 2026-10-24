import type { Diagnostic } from "../diagnostics/index.ts";
import type { NodeSource, ProxyNode } from "../model/proxy-node.ts";

export interface ParserResult {
  recognized: boolean;
  nodes: ProxyNode[];
  diagnostics: Diagnostic[];
}

export interface ContentParser {
  id: string;
  detect(content: string): boolean;
  parse(content: string, source: NodeSource, maxNodes?: number): ParserResult;
}

export function childLocation(source: NodeSource, child: string): string {
  return source.location ? `${source.location}/${child}` : child;
}

export function parserResult(nodes: ProxyNode[] = [], diagnostics: Diagnostic[] = [], recognized = true): ParserResult {
  return { recognized, nodes, diagnostics };
}
