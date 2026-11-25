import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { answerRunInput, pauseRunForInput } from "./thread-ask.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("pending protected input (PostgreSQL)", () => {
  let system: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let scope: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `pending-input-${randomUUID()}`;
  const ask: Extract<MessageBlock, { kind: "ask" }> = {
    kind: "ask",
    input: "secret",
    text: "Delivery information",
    status: "pending",
    credential: { name: "delivery", origin: "", auth: { type: "contact" } },
  };
  beforeAll(async () => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    const identity = await runAsSystem("pending input test fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "sendblue", address }),
    );
    const { userId, spaceId, botId, threadId } = identity;
    scope = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (scope) {
      await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await system.organization.deleteMany({ where: { id: scope.spaceId } });
      await system.user.deleteMany({ where: { id: scope.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  async function running() {
    const task = await system.task.create({
      data: { ...scope, prompt: "Compare parts", status: "running" },
    });
    const run = await system.run.create({
      data: {
        ...scope,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    await system.externalEffect.create({
      data: {
        spaceId: scope.spaceId,
        runId: run.id,
        kind: "request_secret",
        status: "intended",
        idempotencyKey: randomUUID(),
        request: {},
      },
    });
    return { ...scope, runId: run.id, attemptId: attempt.id, leaseOwner: "worker", leaseFence: 1 };
  }
  it("creates one request for simultaneous calls and resumes only its owner on dismissal", async () => {
    const first = await running();
    const second = await running();
    const results = await Promise.all(
      [first, second].map((input) => pauseRunForInput(system, { ...input, blocks: [ask] })),
    );
    const reused = results.flatMap((result) =>
      result === false || !result.existingRequest ? [] : [result.existingRequest],
    );
    expect(reused).toHaveLength(1);
    const original = reused[0];
    if (!original) throw new Error("Expected a reused request");
    expect(await system.message.count({ where: { threadId: scope.threadId, role: "bot" } })).toBe(
      1,
    );
    expect(
      await system.run.count({ where: { threadId: scope.threadId, status: "waiting_input" } }),
    ).toBe(1);
    expect(await system.run.count({ where: { threadId: scope.threadId, status: "running" } })).toBe(
      1,
    );
    const answer = {
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      ...original,
      answer: "",
      dismiss: true,
    };
    expect(await answerRunInput(system, { ...answer, answeredByUserId: "another-user" })).toBe(
      false,
    );
    expect(await answerRunInput(system, { ...answer, answeredByUserId: scope.userId })).toBe(true);
    expect(await system.run.findUnique({ where: { id: original.runId } })).toMatchObject({
      status: "queued",
    });
  });
  it("keeps different credential destinations as independent requests", async () => {
    const first = await running();
    const second = await running();
    const results = await Promise.all([
      pauseRunForInput(system, { ...first, blocks: [ask] }),
      pauseRunForInput(system, {
        ...second,
        blocks: [{ ...ask, credential: { ...ask.credential!, name: "billing" } }],
      }),
    ]);
    expect(results).toEqual([{ continuationRunId: null }, { continuationRunId: null }]);
  });
});
