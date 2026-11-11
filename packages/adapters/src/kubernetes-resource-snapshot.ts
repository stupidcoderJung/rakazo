import type { ResourceAmounts, ResourceSnapshot } from "@rakazo/contracts";
import { ResourceSnapshotSchema } from "@rakazo/contracts";
import { z } from "zod";

const quantity = z.union([z.string(), z.number()]).transform(String);
const amounts = z.object({ cpu: quantity.optional(), memory: quantity.optional() }).optional();
const owner = z.object({ uid: z.string(), kind: z.string(), controller: z.boolean().optional() });
const metadata = z.object({
  name: z.string().optional(),
  uid: z.string(),
  ownerReferences: z.array(owner).optional(),
});
const deployment = z.object({
  metadata,
  spec: z.object({
    replicas: z.number().int().nonnegative().optional(),
    selector: z.object({
      matchLabels: z.record(z.string(), z.string()).optional(),
      matchExpressions: z.array(z.unknown()).optional(),
    }),
    template: z.object({
      spec: z.object({
        containers: z.array(
          z.object({
            name: z.string(),
            resources: z.object({ requests: amounts, limits: amounts }).optional(),
          }),
        ),
      }),
    }),
  }),
  status: z.object({ readyReplicas: z.number().int().nonnegative().optional() }).optional(),
});
const replicaList = z.object({ items: z.array(z.object({ metadata })) });
const podList = z.object({
  items: z.array(
    z.object({
      metadata,
      status: z
        .object({
          containerStatuses: z
            .array(
              z.object({
                name: z.string(),
                restartCount: z.number().int().nonnegative(),
                state: z
                  .object({ terminated: z.object({ reason: z.string().optional() }).optional() })
                  .optional(),
                lastState: z
                  .object({ terminated: z.object({ reason: z.string().optional() }).optional() })
                  .optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
});
const quota = z.object({
  spec: z.object({ hard: z.record(z.string(), quantity).optional() }).optional(),
  status: z
    .object({
      hard: z.record(z.string(), quantity).optional(),
      used: z.record(z.string(), quantity).optional(),
    })
    .optional(),
});

type RunKubectl = (args: string[]) => Promise<string>;
type Deployment = z.infer<typeof deployment>;
type Pod = z.infer<typeof podList>["items"][number];

const multipliers: Record<string, number> = {
  "": 1,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** Resource names are passed as arguments, but must not be interpreted as kubectl flags. */
export function isResourceName(value: string): boolean {
  return value.length <= 253 && /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value);
}

/** Parse a Kubernetes quantity without retaining its original untrusted text. */
export function parseResourceQuantity(value: string | undefined, factor = 1): number | null {
  if (value === undefined) return null;
  const match =
    /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(
      value,
    );
  if (!match) throw new Error("Invalid resource quantity");
  const multiplier = multipliers[match[2] ?? ""];
  if (multiplier === undefined) throw new Error("Invalid resource quantity");
  const result = Number(match[1]) * multiplier * factor;
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) {
    throw new Error("Resource quantity out of range");
  }
  return result;
}

function resourceAmounts(value: z.infer<typeof amounts>): ResourceAmounts {
  const memory = parseResourceQuantity(value?.memory);
  return {
    cpuMillis: parseResourceQuantity(value?.cpu, 1000),
    memoryBytes: memory === null ? null : Math.ceil(memory),
  };
}

function listArgs(namespace: string, kind: string, selector: string) {
  return ["-n", namespace, "get", kind, "-l", selector, "-o", "json"];
}

function isOwnedBy(
  references: z.infer<typeof owner>[] | undefined,
  kind: string,
  ids: Set<string>,
) {
  return (
    references?.some(
      (reference) =>
        reference.kind === kind && reference.controller === true && ids.has(reference.uid),
    ) ?? false
  );
}

async function observations(
  run: RunKubectl,
  namespace: string,
  app: Deployment,
  containerName: string,
) {
  const labels = app.spec.selector.matchLabels ?? {};
  if (!Object.keys(labels).length || app.spec.selector.matchExpressions?.length) return null;
  const selector = Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  try {
    const [replicas, pods] = await Promise.all([
      run(listArgs(namespace, "replicasets", selector)).then((text) =>
        replicaList.parse(JSON.parse(text)),
      ),
      run(listArgs(namespace, "pods", selector)).then((text) => podList.parse(JSON.parse(text))),
    ]);
    const deploymentIds = new Set([app.metadata.uid]);
    const replicaIds = new Set(
      replicas.items
        .filter((replica) =>
          isOwnedBy(replica.metadata.ownerReferences, "Deployment", deploymentIds),
        )
        .map((replica) => replica.metadata.uid),
    );
    const ownPods = pods.items.filter((pod) =>
      isOwnedBy(pod.metadata.ownerReferences, "ReplicaSet", replicaIds),
    );
    if (!ownPods.length) return null;
    const statuses = ownPods.flatMap(
      (pod) =>
        pod.status?.containerStatuses?.filter((status) => status.name === containerName) ?? [],
    );
    if (statuses.length !== ownPods.length) return null;
    const restarts = statuses.reduce((sum, status) => sum + status.restartCount, 0);
    const instancesWithOomTermination = statuses.filter(
      (status) =>
        status.state?.terminated?.reason === "OOMKilled" ||
        status.lastState?.terminated?.reason === "OOMKilled",
    ).length;
    // Limit subprocess fan-out; the rest of the observation remains useful at larger scale.
    const usage =
      ownPods.length <= 32 ? await usageForPods(run, namespace, ownPods, containerName) : null;
    return { restarts, instancesWithOomTermination, usage };
  } catch {
    // Optional status permissions and metrics are not required to read the deployment.
    return null;
  }
}

async function usageForPods(
  run: RunKubectl,
  namespace: string,
  pods: Pod[],
  containerName: string,
): Promise<ResourceAmounts | null> {
  try {
    const samples = await Promise.all(
      pods.map(async (pod) => {
        const name = pod.metadata.name;
        if (!name || !isResourceName(name)) throw new Error("Invalid pod name");
        const output = await run([
          "-n",
          namespace,
          "top",
          "pod",
          name,
          "--containers",
          "--no-headers",
        ]);
        const fields = output
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .find((row) => row.length === 4 && row[0] === name && row[1] === containerName);
        if (!fields) throw new Error("Metric unavailable");
        const cpuMillis = parseResourceQuantity(fields[2], 1000);
        const memoryBytes = parseResourceQuantity(fields[3]);
        if (cpuMillis === null || memoryBytes === null) throw new Error("Metric unavailable");
        return { cpuMillis, memoryBytes };
      }),
    );
    return {
      cpuMillis: samples.reduce((sum, item) => sum + item.cpuMillis, 0),
      memoryBytes: Math.ceil(samples.reduce((sum, item) => sum + item.memoryBytes, 0)),
    };
  } catch {
    return null;
  }
}

async function workload(run: RunKubectl, namespace: string, name: string, containerName: string) {
  const app = deployment.parse(
    JSON.parse(await run(["-n", namespace, "get", "deployment", name, "-o", "json"])),
  );
  const container = app.spec.template.spec.containers.find((item) => item.name === containerName);
  if (!container) throw new Error("Configured container not found");
  return {
    desired: app.spec.replicas ?? 1,
    ready: app.status?.readyReplicas ?? 0,
    requests: resourceAmounts(container.resources?.requests),
    limits: resourceAmounts(container.resources?.limits),
    observations: await observations(run, namespace, app, containerName),
  };
}

async function computerQuota(run: RunKubectl, namespace: string, name: string) {
  try {
    const object = quota.parse(
      JSON.parse(await run(["-n", namespace, "get", "resourcequota", name, "-o", "json"])),
    );
    const hard = object.status?.hard ?? object.spec?.hard;
    const used = object.status?.used;
    const read = (key: string, factor = 1) => ({
      used: parseResourceQuantity(used?.[key], factor),
      limit: parseResourceQuantity(hard?.[key], factor),
    });
    return {
      count: read("pods"),
      cpuMillis: read("limits.cpu", 1000),
      memoryBytes: read("limits.memory"),
    };
  } catch {
    return null;
  }
}

export async function collectKubernetesResourceSnapshot(
  run: RunKubectl,
  options: {
    namespace: string;
    api: string;
    worker: string;
    apiContainer: string;
    workerContainer: string;
    computers?: { namespace: string; quota: string };
  },
  now = new Date(),
): Promise<ResourceSnapshot> {
  const [api, worker, computers] = await Promise.all([
    workload(run, options.namespace, options.api, options.apiContainer),
    workload(run, options.namespace, options.worker, options.workerContainer),
    options.computers
      ? computerQuota(run, options.computers.namespace, options.computers.quota)
      : null,
  ]);
  return ResourceSnapshotSchema.parse({
    version: 1,
    capturedAt: now.toISOString(),
    api,
    worker,
    computers,
  });
}
