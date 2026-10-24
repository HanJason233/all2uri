import { diagnostic } from "../diagnostics/index.ts";
import type { Diagnostic } from "../diagnostics/index.ts";
import { subscriptionFragmentsLimited } from "../subscription-import/text.ts";

export interface PreprocessLimits {
  maxInputBytes: number;
  maxDecodedBytes: number;
  maxFragments: number;
  maxNodes: number;
  maxRecursionDepth: number;
}

export const DEFAULT_PREPROCESS_LIMITS: PreprocessLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxFragments: 10000,
  maxNodes: 100000,
  maxRecursionDepth: 16,
};

export interface PreprocessResult {
  fragments: string[];
  diagnostics: Diagnostic[];
  truncated: boolean;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function preprocessInput(value: string, sourceId: string, limits: Partial<PreprocessLimits> = {}): PreprocessResult {
  // 解码前先限制原始字节，再统一限制递归深度、解码字节和片段数量。
  const effective = { ...DEFAULT_PREPROCESS_LIMITS, ...limits };
  const diagnostics: Diagnostic[] = [];
  const inputBytes = byteLength(value);
  if (inputBytes > effective.maxInputBytes) {
    diagnostics.push(diagnostic({ sourceId, stage: "preprocess" }, "input_too_large", "error", `Input exceeds ${effective.maxInputBytes} bytes.`));
    return { fragments: [], diagnostics, truncated: true };
  }
  const expanded = subscriptionFragmentsLimited(value, {
    maxDepth: effective.maxRecursionDepth,
    maxFragments: effective.maxFragments,
    maxDecodedBytes: effective.maxDecodedBytes,
  });
  for (let index = 0; index < expanded.decodedTooLarge; index++) {
    diagnostics.push(diagnostic({ sourceId, stage: "preprocess" }, "decoded_fragment_too_large", "warning", `Decoded fragment exceeds ${effective.maxDecodedBytes} bytes.`));
  }
  if (expanded.depthLimited) {
    diagnostics.push(diagnostic({ sourceId, stage: "preprocess" }, "recursion_limit", "warning", `Base64 expansion stopped at depth ${effective.maxRecursionDepth}.`));
  }
  if (expanded.truncated) {
    diagnostics.push(diagnostic({ sourceId, stage: "preprocess" }, "fragment_limit", "warning", `Input was truncated at ${effective.maxFragments} fragments.`));
  }
  return { fragments: expanded.fragments, diagnostics, truncated: expanded.truncated || expanded.decodedTooLarge > 0 || expanded.depthLimited };
}
