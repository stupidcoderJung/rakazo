import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import {
  collectKubernetesResourceSnapshot,
  isResourceName,
} from "../kubernetes-resource-snapshot.js";

const execFileAsync = promisify(execFile);

async function main() {
  const { values } = parseArgs({
    options: {
      namespace: { type: "string" },
      api: { type: "string" },
      worker: { type: "string" },
      "api-container": { type: "string", default: "api" },
      "worker-container": { type: "string", default: "worker" },
      "computer-namespace": { type: "string" },
      quota: { type: "string" },
    },
  });
  if (
    !values.namespace ||
    !values.api ||
    !values.worker ||
    Boolean(values["computer-namespace"]) !== Boolean(values.quota)
  ) {
    throw new Error(
      "Specify --namespace, --api and --worker; supply --computer-namespace and --quota together.",
    );
  }
  const names = [
    values.namespace,
    values.api,
    values.worker,
    values["api-container"],
    values["worker-container"],
    values["computer-namespace"],
    values.quota,
  ];
  if (names.some((name) => name !== undefined && !isResourceName(name))) {
    throw new Error("Invalid resource name");
  }
  // Names are arguments, never shell text. kubectl stderr and raw objects are not included in the report.
  const run = async (args: string[]) => {
    const { stdout } = await execFileAsync("kubectl", ["--request-timeout=10s", ...args], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };
  const computers =
    values["computer-namespace"] && values.quota
      ? { namespace: values["computer-namespace"], quota: values.quota }
      : undefined;
  const report = await collectKubernetesResourceSnapshot(run, {
    namespace: values.namespace,
    api: values.api,
    worker: values.worker,
    apiContainer: values["api-container"],
    workerContainer: values["worker-container"],
    computers,
  });
  if (computers && !report.computers) process.stderr.write("Computer quota is unavailable.\n");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(() => {
  process.stderr.write(
    "Could not collect the deployment report. Check names, access and cluster connectivity.\n",
  );
  process.exitCode = 1;
});
