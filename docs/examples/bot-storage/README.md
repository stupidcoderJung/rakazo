# Give bots a shared file shelf

A bot has produced a large report. You want another bot to read it tomorrow, but attaching it to a chat hits the size limit. Store the file once and give the next bot its relative path, such as `outputs/research/report.pdf`.

This optional example connects the bot's shell to an existing HDFS installation. A Skill explains the commands; a Vault Command variable supplies the credential. No MCP server or changes to the Rakazo application are needed. Web, desktop and mobile users can ask their bots to run the same server-side commands.

The bot does not receive general HDFS access. An internal HTTPS gateway accepts only uploads, downloads and directory listings inside one administrator-owned directory. It rejects overwrites, deletion requests and paths outside that directory. All bots sharing the credential can read each other's files; this is **not isolation between bots or tenants**.

## What you need

- An existing WebHDFS deployment using `simple` authentication on a trusted, isolated network. This adapter does **not** implement Kerberos, delegation tokens or SPNEGO.
- Kubernetes with enforced NetworkPolicy, an existing Rakazo sandbox namespace, and Python 3 in the bot computer image.
- An operator with permission to create the storage directory, a gateway workload and narrowly scoped network rules.

In simple mode, WebHDFS trusts a requested username. Consequently the security boundary here is the gateway **and network isolation**, not the HDFS username. Never expose WebHDFS to the bots or the Internet. Protect its other access paths separately. Do not let other untrusted writers change the gateway's root or its ancestors; path validation cannot prevent an outside administrator from changing them during a transfer.

## 1. Prepare a directory

As an HDFS administrator, create a fresh directory for the shared bot account:

```bash
hdfs dfs -mkdir -p /bots/rakazo/.uploads
hdfs dfs -chown -R botfiles:supergroup /bots/rakazo
hdfs dfs -chmod 750 /bots/rakazo
hdfs dfs -chmod 700 /bots/rakazo/.uploads
```

Use your cluster's group name if different. `.uploads` holds incomplete files. Bots cannot address hidden paths. Successful uploads publish a complete file with a rename; a crash may leave staging files that an operator can remove after stopping transfers. Set an HDFS space quota appropriate to your replication factor; the per-file limit does not cap accumulated storage.

## 2. Create a private connection

Run from this example directory. Keep the private directory outside the repository. Replace the example DNS name if your gateway namespace differs. The certificate must match the hostname the bots use.

```bash
umask 077
private_dir="$(mktemp -d)"
openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout "$private_dir/tls.key" -out "$private_dir/tls.crt" -days 365 \
  -subj '/CN=bot-storage.rakazo.svc.cluster.local' \
  -addext 'subjectAltName=DNS:bot-storage.rakazo.svc.cluster.local'
python3 - "$private_dir" <<'PY'
import hashlib, json, secrets, sys
from pathlib import Path
p = Path(sys.argv[1])
token = secrets.token_urlsafe(48)
(p / 'token.sha256').write_text(hashlib.sha256(token.encode()).hexdigest())
(p / 'client.json').write_text(json.dumps({
    'url': 'https://bot-storage.rakazo.svc.cluster.local:8443',
    'token': token,
    'ca_pem': (p / 'tls.crt').read_text(),
}))
PY
kubectl -n rakazo create secret generic bot-storage-tls \
  --from-file="$private_dir/tls.key" --from-file="$private_dir/tls.crt" \
  --from-file="$private_dir/token.sha256"
kubectl -n rakazo create configmap bot-storage-code \
  --from-file=gateway.py --from-file=bot_storage.py
```

The gateway receives only the token's hash. The full token belongs in the client's Vault entry. Keep the TLS private key in a protected operator secret store. Rotate the token by replacing its digest, updating the Vault value and restarting the gateway. The old token then stops working. Renew the certificate before expiry and update the Vault certificate too.

## 3. Deploy the internal gateway

Review `deploy.example.yaml` before applying it:

- Set `WEBHDFS_ORIGIN` to your NameNode HTTP origin and `WEBHDFS_DATA_ORIGINS` to the exact comma-separated DataNode origins returned by WebHDFS redirects. Include every intended DataNode; do not use wildcards or a whole private subnet. Prefer stable DNS and recheck after topology changes.
- Match the storage namespace and pod selectors to your cluster. The gateway may reach DNS, the NameNode and DataNodes only. Sandboxes may reach its TLS port only.
- Retain your existing sandbox DNS and public egress policies. This example adds access; Kubernetes policies are additive and cannot narrow a pre-existing allow-all policy. Verify that direct sandbox access to WebHDFS is blocked.
- Keep one gateway replica with `Recreate`: its publication lock is local to that process. Do not scale it horizontally without a shared publication protocol.

```bash
kubectl apply -f deploy.example.yaml
kubectl -n rakazo rollout status deployment/bot-storage
```

Do not add an Internet ingress. The example allows four concurrent transfers, up to 512 MiB each, with 512 MiB memory and a 3 GiB temporary volume. Uploads are streamed to temporary disk before HDFS publication; downloads stream directly. Raise the disk allowance together with the file/concurrency limits. Transfer timeouts are 120 seconds per socket operation. A readiness TCP check only verifies the listener; the round-trip below verifies storage.

## 4. Register the credential and Skill

In Rakazo Vault, create a **Command** credential named `bot-storage-config`. Securely paste the contents of the private `client.json` into its value. Do not paste it into a conversation or commit it. Its command environment variable is `BOT_STORAGE_CONFIG`.

Use the account Vault for bots sharing that account. A Space with its own Vault needs its own entry. Command credentials are available to shell processes: Vault keeps them out of Skill text, but cannot make a credential unreadable to a bot allowed to execute code. Limit this credential to the intended bots' shared storage.

Import `SKILL.md` into the applicable Skill catalog for each Space. The Skill bootstraps the small Python client from the authenticated gateway, checking its pinned SHA-256 before installing it. Importing a Skill alone does not execute scripts. If you modify the client, update both checksum occurrences in the Skill and the deployed ConfigMap.

After registering the Vault value, securely remove temporary plaintext credential copies according to your operator policy. Back up credentials using your normal encrypted secret backup process.

## 5. Try a real file

Ask a bot:

> Use the bot-storage Skill. Upload the report you created to `outputs/research/report-v1.pdf`, download it to a new local filename, and confirm that the SHA-256 hashes match. Tell me its storage path and size, without showing credentials.

Then ask another bot to download that same path. A path is a reference inside the shared storage, not a public download link. The transfer bypasses the chat attachment limit; it does not make an entire large document fit into a model's context. Download it to the bot computer, then extract or read the relevant pages.

The CLI never overwrites existing remote files or local downloads. Pick a new filename for revisions. If a transfer fails after publication, list the destination and verify it before retrying; the gateway may have completed the write before the connection broke.

## Diagnose a failure

| Symptom | Check |
| --- | --- |
| Missing `BOT_STORAGE_CONFIG` | Command credential name and the Space's effective Vault |
| Certificate error | Hostname, certificate expiry and the `ca_pem` in Vault; never disable verification |
| HTTP 401 | Vault token matches the deployed digest; restart after rotating |
| HTTP 400 / 403 | Relative path, hidden segments and filesystem permissions |
| HTTP 409 | Existing destination; use a new name |
| HTTP 413 | Per-file size limit |
| HTTP 502 | NameNode/DataNode connectivity, redirect allowlist, HDFS permissions and quota |
| HTTP 503 | All four transfer slots occupied; retry later |
| Computer will not boot | Repair the existing computer/workspace problem before testing storage |

The client intentionally prints generic errors instead of potentially sensitive exception text. The gateway does not log request headers, bodies or paths. Diagnose with synthetic files and a private operator session. Check gateway restarts, temporary disk pressure and HDFS capacity before increasing memory.

Run the deterministic boundary tests locally:

```bash
python3 -m unittest discover -s docs/examples/bot-storage -p 'test_*.py'
```

Run that command from the repository root. Offline tests do not establish that your network policy, Vault selection or HDFS deployment is correct; verify the real round-trip, wrong-token rejection, path traversal rejection and blocked direct HDFS access in your own sandbox.
