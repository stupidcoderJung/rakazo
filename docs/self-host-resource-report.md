# Inspect resource limits with a local snapshot

English | [한국어](./ko-KR/self-host-resource-report.md)

An API can restart even when its server still has free memory. The app and its
computers have separate limits. This tool collects a small, read-only snapshot
on the operator's machine, then opens it in a web browser. It does not
give any Rakazo account or app process cluster privileges.

The first collector supports Kubernetes deployments. It reads the API and worker
Deployment templates, their owned Pods and optional computer namespace quota. It
never exports Pod or node names, URLs, environment variables, credentials, logs,
or individual computers. Kubernetes still returns full Deployment and Pod objects
to the **local collector**, so run it only as a trusted operator. The resulting
snapshot and its resource figures are still operational information: protect them
and delete them when no longer needed. The app reads the file locally and does not
upload it. Any signed-in account can open this local-only tool; no account can use
it to read the server without an operator supplying a snapshot.

## Collect and open

Use a source checkout with the repository's Node and pnpm prerequisites installed,
`kubectl` configured for the intended cluster, and the permissions below. Supply
your actual names; these are examples. The optional quota must cover a dedicated
computer namespace that the operator is allowed to inspect in its entirety. Omit
both `--computer-namespace` and `--quota` if that is not true.

```sh
umask 077
REPORT_DIR=$(mktemp -d)
pnpm exec tsx packages/adapters/src/cli/resource-snapshot.ts \
  --namespace rakazo --api rakazo-api --worker rakazo-worker \
  --computer-namespace rakazo-sandboxes --quota rakazo-computers \
  > "$REPORT_DIR/resource-snapshot.json"
printf 'Snapshot directory: %s\n' "$REPORT_DIR"
```

The container names default to `api` and `worker`; supply `--api-container` and
`--worker-container` if yours differ. Open `/operator/resources` on your Rakazo web
origin, then choose **Open snapshot**. The page also works in a mobile browser.
Electron and the native mobile app do not have a navigation entry for this local-file
tool; open the web page instead. Move the
file through a trusted channel if collecting on a different machine.

Choose **Plan capacity** to enter the intended number of computers and limits for
each. The total is the sum for all computers, not a reservation of capacity.
**Download plan** saves the proposed computer values along with API and worker
requests and limits from the snapshot, in CPU millicores and memory bytes. The plan
is a review aid, not a manifest and not an action: it does not alter the server.
Apply changes through your deployment configuration after reviewing quota, node
allocatable capacity and room for the database, web, system and other workloads.
If computer requests are not specified, Kubernetes normally copies the limits into
requests. A namespace quota applies across all its Pods; a per-user computer limit
is a different control. Allow running work to finish and save computer homes before
replacing Pods. Do not reduce a running computer's memory limit in place.

## Interpret the snapshot

- API and worker requests and limits come from the **Deployment template per
  instance**, not necessarily from every currently running Pod during a rollout.
  Ready counts come from Deployment status.
- Usage sums the current owned Pods' container samples. It requires metrics-server;
  an unavailable sample is shown as `—`, never as zero. It is not a peak or history.
- Restarts and OOM terminations cover only currently owned Pods and their current or
  last termination. A replaced Pod's history may have disappeared. Selectors with
  match expressions are not collected yet; their observations are unavailable.
  Usage is unavailable above 32 owned Pods per workload to bound local subprocesses. `OOMKilled` is
  evidence of an OOM, but exit code 137 alone is not; distinguishing a container
  limit from node-wide pressure may require matching node/kernel records.
- Computer quota usage is the sum charged against the quota, such as configured
  container limits, **not current CPU or RAM consumption**. It may include other
  Pods if the namespace is shared, which is why this tool requires a dedicated
  computer namespace or omitting the quota.
- A snapshot becomes stale. It contains neither node headroom nor the reason a task
  is slow. Compare queue, first response, tool, storage, database and external
  network/model waits before changing limits. Increasing a limit does not explain
  memory growth or guarantee faster work.

## Operator permissions

The collector uses the caller's kubeconfig, never the app's service account. The
minimum resources read for the example are shown below. Bind the roles only to a
trusted, separately authenticated operator principal; no RoleBinding to the Rakazo
service account is needed. Names and namespaces must match your installation.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: resource-snapshot
  namespace: rakazo
rules:
- apiGroups: [apps]
  resources: [deployments]
  resourceNames: [rakazo-api, rakazo-worker]
  verbs: [get]
- apiGroups: [apps]
  resources: [replicasets]
  verbs: [list]
- apiGroups: ['']
  resources: [pods]
  verbs: [list]
- apiGroups: [metrics.k8s.io]
  resources: [pods]
  verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: resource-snapshot-quota
  namespace: rakazo-sandboxes
rules:
- apiGroups: ['']
  resources: [resourcequotas]
  resourceNames: [rakazo-computers]
  verbs: [get]
```

`list` permissions can expose **all** Pod and ReplicaSet specifications in the
namespace: a label selector is not an RBAC boundary. Use a dedicated application
namespace and a trusted operator; do not grant them in a shared namespace merely
for this tool. Without list access, the report still shows Deployment template
values and readiness, but restart/OOM/usage observations are unavailable. Without
metrics access or metrics-server, usage alone is unavailable. Without quota access,
the computer quota is unavailable. No node, Secret, log, exec, write or cluster-wide
permission is needed.
