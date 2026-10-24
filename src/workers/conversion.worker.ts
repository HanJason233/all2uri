import { convertSourcesAsync } from "../core/pipeline.ts";
import type { ConversionOptions, SourceDocument } from "../core/pipeline.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
}

type WorkerRequest =
  | { type: "convert"; id: string; sources: SourceDocument[]; options: Omit<ConversionOptions, "signal"> }
  | { type: "cancel"; id: string };

const scope = self as unknown as WorkerScope;
const controllers = new Map<string, AbortController>();

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    controllers.get(request.id)?.abort();
    return;
  }

  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const result = await convertSourcesAsync(request.sources, { ...request.options, signal: controller.signal });
    scope.postMessage({ id: request.id, result });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(request.id);
  }
};
