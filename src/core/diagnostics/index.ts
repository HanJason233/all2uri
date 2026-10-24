export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  sourceId: string;
  location?: string;
  nodeId?: string;
  stage: string;
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  field?: string;
}

export interface DiagnosticContext {
  sourceId: string;
  location?: string;
  nodeId?: string;
  stage: string;
}

export function diagnostic(
  context: DiagnosticContext,
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  field?: string,
): Diagnostic {
  return {
    sourceId: context.sourceId,
    ...(context.location ? { location: context.location } : {}),
    ...(context.nodeId ? { nodeId: context.nodeId } : {}),
    stage: context.stage,
    code,
    severity,
    message,
    ...(field ? { field } : {}),
  };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some(item => item.severity === "error");
}

export function mergeDiagnostics(...groups: Diagnostic[][]): Diagnostic[] {
  return groups.flat();
}
