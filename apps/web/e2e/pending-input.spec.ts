import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers/helpers";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`pending input stays above the composer at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/pending-input.html");
    const pending = page.getByTestId("pending-input-requests");
    await expect(pending).toBeVisible();
    await expect(page.getByTestId("secret-ask-card")).toHaveCount(1);
    await expect(page.getByTestId("tool-activity")).toHaveCount(0);
    const composer = page.getByRole("combobox", {
      name: "Message Shopping assistant",
      exact: true,
    });
    await composer.fill("What are you waiting for?");
    const before = await composer.boundingBox();
    const card = await pending.boundingBox();
    expect(card!.y + card!.height).toBeLessThanOrEqual(before!.y);
    await expect(page.getByTestId("vault-editor")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "pending-input");
    await pending.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByTestId("vault-editor")).toBeVisible();
    await captureScreenshot(page, testInfo, "pending-input-form");
    await page.keyboard.press("Escape");
    await expect(composer).toHaveValue("What are you waiting for?");
    await page.reload();
    await expect(pending).toBeVisible();
    await expect(page.getByTestId("tool-activity")).toHaveCount(0);
    await pending.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByTestId("vault-editor")
      .getByRole("button", { name: "Dismiss request", exact: true })
      .click();
    await expect(pending).toHaveCount(0);
    await page.reload();
    await pending.getByRole("button", { name: "Continue", exact: true }).click();
    const form = page.getByTestId("vault-editor");
    await form.getByLabel("Full name", { exact: true }).fill("Example Recipient");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect(form).toHaveCount(0);
  });
}
