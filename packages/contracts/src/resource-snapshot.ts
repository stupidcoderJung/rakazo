import { z } from "zod";

const nonnegative = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).finite();
const count = z.number().int().nonnegative().safe();

/** CPU is in millicores; memory is in bytes. Null means not configured or unavailable. */
export const ResourceAmountsSchema = z.strictObject({
  cpuMillis: nonnegative.nullable(),
  memoryBytes: nonnegative.safe().nullable(),
});

const WorkloadSnapshotSchema = z.strictObject({
  desired: count,
  ready: count,
  requests: ResourceAmountsSchema,
  limits: ResourceAmountsSchema,
  observations: z
    .strictObject({
      restarts: count,
      instancesWithOomTermination: count,
      usage: ResourceAmountsSchema.nullable(),
    })
    .nullable(),
});

const QuotaAmountSchema = z.strictObject({
  used: nonnegative.nullable(),
  limit: nonnegative.nullable(),
});

/** A deliberately small, provider-neutral report. No names, logs or identifiers belong here. */
export const ResourceSnapshotSchema = z.strictObject({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  api: WorkloadSnapshotSchema,
  worker: WorkloadSnapshotSchema,
  computers: z
    .strictObject({
      count: QuotaAmountSchema,
      cpuMillis: QuotaAmountSchema,
      memoryBytes: QuotaAmountSchema,
    })
    .nullable(),
});

export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;
export type ResourceAmounts = z.infer<typeof ResourceAmountsSchema>;
