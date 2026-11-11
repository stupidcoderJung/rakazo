import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const workload = {
  desired: 1,
  ready: 1,
  requests: { cpuMillis: 1000, memoryBytes: 1073741824 },
  limits: { cpuMillis: 4000, memoryBytes: 8589934592 },
  observations: {
    restarts: 1,
    instancesWithOomTermination: 1,
    usage: { cpuMillis: 125, memoryBytes: 536870912 },
  },
};
const snapshot = {
  version: 1,
  capturedAt: "2026-01-01T00:00:00.000Z",
  api: workload,
  worker: workload,
  computers: {
    count: { used: 1, limit: 2 },
    cpuMillis: { used: 4000, limit: 8000 },
    memoryBytes: { used: 8589934592, limit: 17179869184 },
  },
};

test("opens a local snapshot and downloads a capacity plan", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `resources-${stamp}@rakazo.test`, "password12", "Resource Operator");
  await completeOnboarding(page);
  await page.goto("/operator/resources");
  await expect(page.getByRole("heading", { name: "Resources" })).toBeVisible();

  const input = page.getByLabel("Choose snapshot");
  await input.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version": 1}'),
  });
  await expect(page.getByRole("alert")).toContainText("Could not open this snapshot");
  const requestsWithSnapshot: string[] = [];
  page.on("request", (request) => {
    if (request.postData()?.includes(snapshot.capturedAt)) requestsWithSnapshot.push(request.url());
  });
  await input.setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await expect(page.getByRole("heading", { name: "API" })).toBeVisible();
  await expect(page.getByText("1 GiB / 8 GiB").first()).toBeVisible();
  await expect(page.getByText("Instances with an OOM termination").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "resource-snapshot");

  await page.getByRole("button", { name: "Plan capacity" }).click();
  await page.getByLabel("Computers", { exact: true }).fill("2");
  await page.getByLabel("CPU per computer").fill("4");
  await page.getByLabel("Memory per computer (GiB)").fill("8");
  await expect(page.getByText("8 CPU · 16 GiB")).toBeVisible();
  await captureScreenshot(page, testInfo, "resource-capacity-plan");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download plan" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const plan = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(plan.computers.total).toEqual({ cpuMillis: 8000, memoryBytes: 17179869184 });
  expect(plan.sourceCapturedAt).toBe(snapshot.capturedAt);
  expect(requestsWithSnapshot).toEqual([]);
});
