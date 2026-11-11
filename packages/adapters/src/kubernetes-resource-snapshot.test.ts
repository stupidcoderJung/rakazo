import { describe, expect, it, vi } from "vitest";
import {
  collectKubernetesResourceSnapshot,
  isResourceName,
  parseResourceQuantity,
} from "./kubernetes-resource-snapshot.js";

const owner = (kind: string, uid: string) => ({ kind, uid, controller: true });
const app = (name: string) => ({
  metadata: { uid: `deployment-${name}` },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: name } },
    template: {
      spec: {
        containers: [
          {
            name,
            resources: {
              requests: { cpu: "1", memory: "1Gi" },
              limits: { cpu: "4", memory: "8Gi" },
            },
            env: [{ name: "SECRET", value: "never-export-this" }],
          },
        ],
      },
    },
  },
  status: { readyReplicas: 1 },
});
const options = {
  namespace: "app-space",
  api: "api",
  worker: "worker",
  apiContainer: "api",
  workerContainer: "worker",
  computers: { namespace: "computer-space", quota: "computers" },
};

it("rejects option-like and malformed resource names before calling kubectl", () => {
  expect(isResourceName("rakazo-api")).toBe(true);
  expect(isResourceName("--all-namespaces")).toBe(false);
  expect(isResourceName("api;command")).toBe(false);
  expect(isResourceName("x".repeat(254))).toBe(false);
});

describe("resource quantities", () => {
  it("normalizes common CPU and memory quantities and rejects invalid or unsafe values", () => {
    expect(parseResourceQuantity("125m", 1000)).toBe(125);
    expect(parseResourceQuantity("2", 1000)).toBe(2000);
    expect(parseResourceQuantity("1.5Gi")).toBe(1610612736);
    expect(parseResourceQuantity(undefined)).toBeNull();
    expect(() => parseResourceQuantity("not-a-quantity")).toThrow();
    expect(() => parseResourceQuantity("9Ei")).toThrow();
  });
});

describe("computer deployment snapshot", () => {
  it("exports only normalized status for owned pods and the selected quota", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("deployment"))
        return JSON.stringify(app(args[args.indexOf("deployment") + 1]!));
      if (args.includes("resourcequota"))
        return JSON.stringify({
          status: {
            hard: { pods: "2", "limits.cpu": "8", "limits.memory": "16Gi" },
            used: { pods: "1", "limits.cpu": "4", "limits.memory": "8Gi" },
          },
        });
      const selector = args.find((arg) => arg.startsWith("app="));
      const name = selector?.slice(4);
      if (args.includes("replicasets"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                uid: `replica-${name}`,
                ownerReferences: [owner("Deployment", `deployment-${name}`)],
              },
            },
          ],
        });
      if (args.includes("pods"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                uid: `pod-${name}`,
                name: `${name}-pod`,
                ownerReferences: [owner("ReplicaSet", `replica-${name}`)],
              },
              status: {
                containerStatuses: [
                  { name, restartCount: 1, lastState: { terminated: { reason: "OOMKilled" } } },
                ],
              },
            },
            {
              metadata: {
                uid: "unrelated-id",
                name: "another-tenant",
                ownerReferences: [owner("ReplicaSet", "unrelated")],
              },
              status: { containerStatuses: [{ name, restartCount: 99 }] },
            },
          ],
        });
      if (args.includes("top")) {
        const pod = args[args.indexOf("pod") + 1]!;
        const container = pod.slice(0, -4);
        return `${pod} ${container} 125m 512Mi\n`;
      }
      throw new Error("Unexpected call");
    });
    const report = await collectKubernetesResourceSnapshot(
      run,
      options,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(report.api).toEqual({
      desired: 1,
      ready: 1,
      requests: { cpuMillis: 1000, memoryBytes: 1073741824 },
      limits: { cpuMillis: 4000, memoryBytes: 8589934592 },
      observations: {
        restarts: 1,
        instancesWithOomTermination: 1,
        usage: { cpuMillis: 125, memoryBytes: 536870912 },
      },
    });
    expect(report.computers).toEqual({
      count: { used: 1, limit: 2 },
      cpuMillis: { used: 4000, limit: 8000 },
      memoryBytes: { used: 8589934592, limit: 17179869184 },
    });
    const serialized = JSON.stringify(report);
    for (const privateValue of [
      "never-export-this",
      "another-tenant",
      "app-space",
      "api-pod",
      "deployment-api",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(run.mock.calls.filter(([args]) => args.includes("top"))).toHaveLength(2);
  });

  it("keeps unknown metrics distinct from zero and works without optional permissions", async () => {
    const run = async (args: string[]) => {
      if (args.includes("deployment"))
        return JSON.stringify(app(args[args.indexOf("deployment") + 1]!));
      throw new Error("Permission denied or unavailable");
    };
    const report = await collectKubernetesResourceSnapshot(run, options);
    expect(report.api.observations).toBeNull();
    expect(report.worker.observations).toBeNull();
    expect(report.computers).toBeNull();
    expect(report.api.limits.memoryBytes).toBe(8589934592);
  });

  it("reports OOM observations even when the metrics service is unavailable", async () => {
    const run = async (args: string[]) => {
      if (args.includes("deployment"))
        return JSON.stringify(app(args[args.indexOf("deployment") + 1]!));
      const name = args.find((arg) => arg.startsWith("app="))?.slice(4);
      if (args.includes("replicasets"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                uid: `rs-${name}`,
                ownerReferences: [owner("Deployment", `deployment-${name}`)],
              },
            },
          ],
        });
      if (args.includes("pods"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                uid: `pod-${name}`,
                name: `${name}-pod`,
                ownerReferences: [owner("ReplicaSet", `rs-${name}`)],
              },
              status: {
                containerStatuses: [
                  { name, restartCount: 1, lastState: { terminated: { reason: "OOMKilled" } } },
                ],
              },
            },
          ],
        });
      throw new Error("Metrics not available");
    };
    const report = await collectKubernetesResourceSnapshot(run, {
      ...options,
      computers: undefined,
    });
    expect(report.api.observations).toEqual({
      restarts: 1,
      instancesWithOomTermination: 1,
      usage: null,
    });
  });

  it("retains restart observations without starting dozens of metrics processes", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("deployment"))
        return JSON.stringify(app(args[args.indexOf("deployment") + 1]!));
      const name = args.find((arg) => arg.startsWith("app="))?.slice(4);
      if (args.includes("replicasets"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                uid: `rs-${name}`,
                ownerReferences: [owner("Deployment", `deployment-${name}`)],
              },
            },
          ],
        });
      if (args.includes("pods"))
        return JSON.stringify({
          items: Array.from({ length: 33 }, (_, index) => ({
            metadata: {
              uid: `pod-${name}-${index}`,
              name: `${name}-${index}`,
              ownerReferences: [owner("ReplicaSet", `rs-${name}`)],
            },
            status: { containerStatuses: [{ name, restartCount: 1 }] },
          })),
        });
      throw new Error("Unexpected metrics request");
    });
    const report = await collectKubernetesResourceSnapshot(run, {
      ...options,
      computers: undefined,
    });
    expect(report.api.observations).toEqual({
      restarts: 33,
      instancesWithOomTermination: 0,
      usage: null,
    });
    expect(run.mock.calls.some(([args]) => args.includes("top"))).toBe(false);
  });
});
