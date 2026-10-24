import type { ConversionOptions, ConversionResult, SourceDocument } from "./pipeline.ts";

export function convertSourcesInWorker(
  sources: SourceDocument[],
  options: ConversionOptions = {},
): Promise<ConversionResult> {
  const worker = new Worker(new URL("../workers/conversion.worker.ts", import.meta.url), { type: "module" });
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const signal = options.signal;
  const { signal: _signal, ...serializableOptions } = options;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
    };
    const cancel = () => worker.postMessage({ type: "cancel", id });

    worker.onmessage = (event: MessageEvent<{ id: string; result?: ConversionResult; error?: string }>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error("Conversion worker returned an empty result."));
    };
    worker.onerror = event => {
      cleanup();
      reject(new Error(event.message || "Conversion worker failed."));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    worker.postMessage({ type: "convert", id, sources, options: serializableOptions });
    if (signal?.aborted) cancel();
  });
}
