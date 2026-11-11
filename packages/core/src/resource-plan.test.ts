import type { ResourceSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resourcePlan } from "./resource-plan.js";

const workload = {
  desired: 1,
  ready: 1,
  requests: { cpuMillis: 1000, memoryBytes: 1073741824 },
  limits: { cpuMillis: 4000, memoryBytes: 8589934592 },
  observations: null,
};
const snapshot: ResourceSnapshot = {
  version: 1,
  capturedAt: "2026-01-01T00:00:00Z",
  api: workload,
  worker: workload,
  computers: null,
};

describe("resourcePlan", () => {
  it("calculates total computer capacity and carries over only the configured app values", () => {
    expect(resourcePlan(snapshot, 2, 4, 8)).toEqual({
      version: 1,
      sourceCapturedAt: snapshot.capturedAt,
      api: { requests: workload.requests, limits: workload.limits },
      worker: { requests: workload.requests, limits: workload.limits },
      computers: {
        count: 2,
        each: { cpuMillis: 4000, memoryBytes: 8589934592 },
        total: { cpuMillis: 8000, memoryBytes: 17179869184 },
      },
    });
  });
  it("rejects zero, fractional counts, unrepresentable values and overflow", () => {
    expect(resourcePlan(snapshot, 0, 4, 8)).toBeNull();
    expect(resourcePlan(snapshot, 1.5, 4, 8)).toBeNull();
    expect(resourcePlan(snapshot, 2, 0, 8)).toBeNull();
    expect(resourcePlan(snapshot, 2, 0.0001, 8)).toBeNull();
    expect(resourcePlan(snapshot, 1000, 4, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
