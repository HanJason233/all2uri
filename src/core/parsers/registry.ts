import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import type { NodeSource } from "../model/proxy-node.ts";
import { extractUris, isJsonContent, isYamlContent } from "../subscription-import/text.ts";
import { clashParser } from "./clash-parser.ts";
import { detectNativeFormat, nativeParser, parseNativeContent } from "./native-parser.ts";
import { parseUriNode } from "./uri-parser.ts";
import { childLocation, parserResult, type ContentParser, type ParserResult } from "./types.ts";

export const uriParser: ContentParser = {
  id: "uri",
  detect(content) { return extractUris(content, 1).length > 0; },
  parse(content, source, maxNodes = Number.POSITIVE_INFINITY) {
    const allUris = extractUris(content, maxNodes + 1);
    const wasTruncated = allUris.length > maxNodes;
    const results = allUris.slice(0, maxNodes).map((uri, index) =>
      parseUriNode(uri, { ...source, format: "uri", location: childLocation(source, `uri[${index}]`) }, index),
    );
    const diagnostics: Diagnostic[] = [];
    const nodes = [];
    let ignored = 0;
    for (const result of results) {
      diagnostics.push(...result.diagnostics);
      if (result.node) nodes.push(result.node);
      if (result.ignored) ignored++;
    }
    if (wasTruncated) {
      diagnostics.push(diagnostic({ sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "uri.parse" }, "node_limit", "warning", `URI node count was capped at ${results.length}.`));
    }
    if (!nodes.length && !ignored && !diagnostics.some(item => item.severity === "error" || item.code === "node_limit")) {
      diagnostics.push(diagnostic({ sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "uri.parse" }, "no_uri_nodes", "warning", "No supported proxy URI was found."));
    }
    return parserResult(nodes, diagnostics);
  },
};

function jsonNativeFormat(content: string): string | null {
  if (!isJsonContent(content.trim())) return null;
  try { return detectNativeFormat(JSON.parse(content)); }
  catch { return null; }
}

function nativeFormatParser(id: string, format: string): ContentParser {
  return {
    id,
    detect(content) { return jsonNativeFormat(content) === format; },
    parse(content, source, maxNodes) { return parseNativeContent(content, source, maxNodes); },
  };
}

export const xrayParser = nativeFormatParser("xray-json", "xray-json");
export const singBoxParser = nativeFormatParser("sing-box-json", "sing-box-json");
export const clashJsonParser = nativeFormatParser("clash-json", "clash-json");

const MIHOMO_MARKER = /(?:^|\n)\s*(?:proxy-providers|rule-providers|geodata-mode|geox-url|global-client-fingerprint)\s*:/i;
export const mihomoParser: ContentParser = {
  id: "mihomo-yaml",
  detect(content) { return isYamlContent(content) && MIHOMO_MARKER.test(content); },
  parse(content, source, maxNodes) { return clashParser.parse(content, { ...source, format: "mihomo-yaml" }, maxNodes); },
};

export class ParserRegistry {
  private readonly parsers: ContentParser[];

  constructor(parsers: ContentParser[]) {
    this.parsers = parsers;
  }

  register(parser: ContentParser): void {
    if (this.parsers.some(item => item.id === parser.id)) throw new Error(`Parser already registered: ${parser.id}`);
    this.parsers.push(parser);
  }

  getAll(): readonly ContentParser[] { return this.parsers; }

  parse(content: string, source: NodeSource, maxNodes = Number.POSITIVE_INFINITY): ParserResult {
    const trimmed = content.trim();
    if (!trimmed) {
      return parserResult([], [diagnostic({ sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "detect" }, "empty_content", "warning", "Input fragment is empty.")], false);
    }
    for (const parser of this.parsers) {
      if (!parser.detect(trimmed)) continue;
      try {
        return parser.parse(trimmed, source, maxNodes);
      } catch (error) {
        return parserResult([], [diagnostic(
          { sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: parser.id },
          "parser_exception",
          "error",
          error instanceof Error ? error.message : String(error),
        )], true);
      }
    }
    return parserResult([], [diagnostic(
      { sourceId: source.sourceId, ...(source.location ? { location: source.location } : {}), stage: "detect" },
      "unknown_format",
      "warning",
      "Input fragment was not recognized as JSON, YAML or a proxy URI.",
    )], false);
  }
}

export const parserRegistry = new ParserRegistry([
  xrayParser,
  singBoxParser,
  clashJsonParser,
  mihomoParser,
  nativeParser,
  clashParser,
  uriParser,
]);

export function detectContentFormat(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "empty";
  if (isJsonContent(trimmed)) return "json";
  if (isYamlContent(trimmed)) return "yaml";
  if (extractUris(trimmed, 1).length) return "uri";
  return "unknown";
}

export function parseContent(content: string, source: NodeSource, maxNodes = Number.POSITIVE_INFINITY): ParserResult {
  return parserRegistry.parse(content, source, maxNodes);
}
