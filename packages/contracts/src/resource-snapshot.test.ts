import { expect, it } from "vitest";
import { ResourceSnapshotSchema } from "./resource-snapshot.js";

const workload = {
  desired: 1,
  ready: 1,
  requests: { cpuMillis: 1000, memoryBytes: 1073741824 },
  limits: { cpuMillis: 4000, memoryBytes: 8589934592 },
  observations: null,
};
const snapshot = {
  version: 1,
  capturedAt: "2026-01-01T00:00:00Z",
  api: workload,
  worker: workload,
  computers: null,
};

it("accepts a small normalized snapshot and rejects extra data and invalid values", () => {
  expect(ResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(ResourceSnapshotSchema.safeParse({ ...snapshot, logs: "private" }).success).toBe(false);
  expect(
    ResourceSnapshotSchema.safeParse({ ...snapshot, api: { ...workload, name: "private" } })
      .success,
  ).toBe(false);
  expect(
    ResourceSnapshotSchema.safeParse({ ...snapshot, api: { ...workload, ready: -1 } }).success,
  ).toBe(false);
  expect(
    ResourceSnapshotSchema.safeParse({
      ...snapshot,
      api: { ...workload, limits: { cpuMillis: Infinity, memoryBytes: 10 } },
    }).success,
  ).toBe(false);
});
