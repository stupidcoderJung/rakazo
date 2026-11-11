import { Trans, useLingui } from "@lingui/react/macro";
import type { ResourceAmounts, ResourceSnapshot } from "@rakazo/contracts";
import { ResourceSnapshotSchema } from "@rakazo/contracts";
import { resourcePlan } from "@rakazo/core";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  SectionHeading,
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function cpu(value: number | null) {
  return value === null
    ? "—"
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value / 1000)} CPU`;
}

function cpuPair(used: number | null, limit: number | null) {
  const number = (value: number | null) =>
    value === null
      ? "—"
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value / 1000);
  return `${number(used)} / ${number(limit)} CPU`;
}

function memory(value: number | null) {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(size)} ${units[unit]}`;
}

function amount(value: ResourceAmounts | null) {
  return value ? `${cpu(value.cpuMillis)} · ${memory(value.memoryBytes)}` : "—";
}

export function ResourceSnapshotPage() {
  const { t } = useLingui();
  const file = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [planning, setPlanning] = useState(false);

  async function openSnapshot(selected: File | undefined) {
    if (!selected) return;
    try {
      if (selected.size > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot too large");
      const data: unknown = JSON.parse(await selected.text());
      setSnapshot(ResourceSnapshotSchema.parse(data));
      setError(false);
    } catch {
      setSnapshot(null);
      setError(true);
    }
    if (file.current) file.current.value = "";
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Resources</Trans>
        </h1>
        <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
          <Trans>Open snapshot</Trans>
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label={t`Choose snapshot`}
          onChange={(event) => void openSnapshot(event.target.files?.[0])}
        />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          {error ? (
            <p role="alert" className="text-body-sm text-destructive">
              <Trans>Could not open this snapshot.</Trans>
            </p>
          ) : null}
          {!snapshot ? (
            <div className="space-y-3">
              <p className="text-body-sm text-muted-foreground">
                <Trans>Open a resource snapshot collected by the operator.</Trans>
              </p>
              <details className="text-body-sm">
                <summary className="cursor-pointer">
                  <Trans>How to collect a snapshot</Trans>
                </summary>
                <div className="space-y-3 pt-3 text-muted-foreground">
                  <p>
                    <Trans>In a source checkout with read-only access, run:</Trans>
                  </p>
                  <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-foreground">
                    <code>{String.raw`umask 077
REPORT_DIR=$(mktemp -d)
pnpm exec tsx packages/adapters/src/cli/resource-snapshot.ts \
  --namespace rakazo --api rakazo-api --worker rakazo-worker \
  > "$REPORT_DIR/resource-snapshot.json"
printf 'Snapshot directory: %s\n' "$REPORT_DIR"`}</code>
                  </pre>
                  <p>
                    <Trans>
                      Replace the example names. For permissions and computer quota, see
                      docs/self-host-resource-report.md in the checkout.
                    </Trans>
                  </p>
                </div>
              </details>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-body-sm text-muted-foreground">
                  <Trans>Snapshot:</Trans> {new Date(snapshot.capturedAt).toLocaleString()}
                </p>
                <Button variant="outline" size="sm" onClick={() => setPlanning(true)}>
                  <Trans>Plan capacity</Trans>
                </Button>
              </div>
              <Workload title="API" workload={snapshot.api} />
              <Workload title="Worker" workload={snapshot.worker} />
              <section className="space-y-3">
                <SectionHeading as="h2">
                  <Trans>Computers</Trans>
                </SectionHeading>
                {snapshot.computers ? (
                  <dl className="divide-y divide-border text-body-sm">
                    <Row
                      label={t`Count (used / limit)`}
                      value={`${snapshot.computers.count.used ?? "—"} / ${snapshot.computers.count.limit ?? "—"}`}
                    />
                    <Row
                      label={t`CPU quota (used / limit)`}
                      value={cpuPair(
                        snapshot.computers.cpuMillis.used,
                        snapshot.computers.cpuMillis.limit,
                      )}
                    />
                    <Row
                      label={t`Memory quota (used / limit)`}
                      value={`${memory(snapshot.computers.memoryBytes.used)} / ${memory(snapshot.computers.memoryBytes.limit)}`}
                    />
                  </dl>
                ) : (
                  <p className="text-body-sm text-muted-foreground">
                    <Trans>Computer capacity unavailable.</Trans>
                  </p>
                )}
              </section>
              <PlanDialog snapshot={snapshot} open={planning} onOpenChange={setPlanning} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function Workload({ title, workload }: { title: string; workload: ResourceSnapshot["api"] }) {
  const { t } = useLingui();
  return (
    <section className="space-y-3">
      <SectionHeading as="h2">{title}</SectionHeading>
      <dl className="divide-y divide-border text-body-sm">
        <Row label={t`Ready`} value={`${workload.ready} / ${workload.desired}`} />
        <Row
          label={t`CPU per template (request / limit)`}
          value={cpuPair(workload.requests.cpuMillis, workload.limits.cpuMillis)}
        />
        <Row
          label={t`Memory per template (request / limit)`}
          value={`${memory(workload.requests.memoryBytes)} / ${memory(workload.limits.memoryBytes)}`}
        />
        <Row
          label={t`Usage across instances`}
          value={amount(workload.observations?.usage ?? null)}
        />
        <Row
          label={t`Restarts`}
          value={workload.observations ? String(workload.observations.restarts) : "—"}
        />
        {workload.observations?.instancesWithOomTermination ? (
          <Row
            label={t`Instances with an OOM termination`}
            value={String(workload.observations.instancesWithOomTermination)}
          />
        ) : null}
      </dl>
    </section>
  );
}

function PlanDialog({
  snapshot,
  open,
  onOpenChange,
}: {
  snapshot: ResourceSnapshot;
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [count, setCount] = useState("");
  const [cores, setCores] = useState("");
  const [gib, setGib] = useState("");
  const plan =
    count && cores && gib
      ? resourcePlan(snapshot, Number(count), Number(cores), Number(gib))
      : null;
  function download() {
    if (!plan) return;
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(plan, null, 2)}\n`], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "resource-plan.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          <Trans>Plan computer capacity</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>A plan does not change the server.</Trans>
        </DialogDescription>
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="resource-plan-count">
              <Trans>Computers</Trans>
            </FieldLabel>
            <Input
              id="resource-plan-count"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resource-plan-cpu">
              <Trans>CPU per computer</Trans>
            </FieldLabel>
            <Input
              id="resource-plan-cpu"
              type="number"
              min={0.001}
              step={0.001}
              value={cores}
              onChange={(event) => setCores(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resource-plan-memory">
              <Trans>Memory per computer (GiB)</Trans>
            </FieldLabel>
            <Input
              id="resource-plan-memory"
              type="number"
              min={0.25}
              step={0.25}
              value={gib}
              onChange={(event) => setGib(event.target.value)}
            />
          </Field>
          {count && cores && gib && !plan ? (
            <p role="alert" className="text-body-sm text-destructive">
              <Trans>Check the computer count, CPU and memory values.</Trans>
            </p>
          ) : null}
          {plan ? (
            <p className="text-body-sm">
              <Trans>Total:</Trans> {amount(plan.computers.total)}
            </p>
          ) : null}
          <Button onClick={download} disabled={!plan}>
            <Trans>Download plan</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
