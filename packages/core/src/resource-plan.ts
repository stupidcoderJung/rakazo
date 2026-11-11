import type { ResourceSnapshot } from "@rakazo/contracts";

/** A plan is an offline proposal; it does not change a deployment. */
export function resourcePlan(
  snapshot: ResourceSnapshot,
  computerCount: number,
  cpuCores: number,
  memoryGiB: number,
) {
  const rawCpuMillis = cpuCores * 1000;
  const cpuMillis = Math.round(rawCpuMillis);
  const memoryBytes = memoryGiB * 1024 ** 3;
  if (
    !Number.isSafeInteger(computerCount) ||
    computerCount < 1 ||
    computerCount > 1000 ||
    !Number.isFinite(rawCpuMillis) ||
    Math.abs(rawCpuMillis - cpuMillis) > 1e-8 ||
    !Number.isSafeInteger(cpuMillis) ||
    cpuMillis < 1 ||
    !Number.isSafeInteger(memoryBytes) ||
    memoryBytes < 1 ||
    !Number.isSafeInteger(cpuMillis * computerCount) ||
    !Number.isSafeInteger(memoryBytes * computerCount)
  )
    return null;
  return {
    version: 1 as const,
    sourceCapturedAt: snapshot.capturedAt,
    api: { requests: snapshot.api.requests, limits: snapshot.api.limits },
    worker: { requests: snapshot.worker.requests, limits: snapshot.worker.limits },
    computers: {
      count: computerCount,
      each: { cpuMillis, memoryBytes },
      total: { cpuMillis: cpuMillis * computerCount, memoryBytes: memoryBytes * computerCount },
    },
  };
}
