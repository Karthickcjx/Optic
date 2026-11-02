# Optic MCP server

Optic includes a standalone, read-only [Model Context Protocol](https://modelcontextprotocol.io) server. MCP-compatible AI clients, such as Claude Code, can use it to inspect the Kubernetes clusters you approve. It runs without the Optic window.

- Start command: `optic --mcp`
- Transport: stdio only, with no network listener.
- Access: read-only. The server sends `GET` requests to the Kubernetes API and nothing else.
- Clusters: only the kubeconfig contexts you approve in **Optic › Cluster settings › AI access** are available.
- Kubernetes RBAC applies: the server can read only what your kubeconfig identity is allowed to read.
- Secret values are never returned.

## Architecture

```
MCP client (Claude Code, …)
   │  stdio (JSON-RPC; protocol version negotiated by the official TypeScript SDK v2)
   ▼
optic --mcp ──spawn (same executable, ELECTRON_RUN_AS_NODE=1, inherited stdio)──► out/main/mcp.js
                                                                                   │
            ApprovedClusters ── ClusterManager (same kubeconfig discovery as the app)
                  │                └── ~/.kube/config, $KUBECONFIG, kubeconfigs imported into Optic
                  │── mcp-access.json (approvals in the Optic profile, no credentials)
                  ▼
            17 read-only tools ── kubeJson / kubeText (GET, 20 s timeout, Kubernetes Status messages)
                  │                └── redaction (Secrets stripped, sensitive values masked)
                  ▼
            Kubernetes API server (your RBAC)
```

### Process lifecycle

1. **Launch.** The client starts `optic --mcp`.
   - The Electron process does not open a window, register renderer IPC or take the single-instance lock, so it runs next to an open Optic window or on its own.
   - On Windows, a GUI-subsystem process gets a stdin that ends immediately. So the process starts a second copy of the same executable in Node mode (`ELECTRON_RUN_AS_NODE=1`) running `out/main/mcp.js`, passing the original stdio handles through.
   - It also passes the app's profile directory as `OPTIC_DATA_DIR`.
   - The parent exits with the child's exit code.
2. **Serving.** The server speaks MCP over stdio.
   - Diagnostics go to stderr; stdout carries protocol messages only.
   - Every tool call re-reads the kubeconfig sources and the approval file, so edits and revocations apply immediately, with no restart.
3. **Shutdown.** When the client disconnects (stdin closes), the server closes and the process exits.

`node out/main/mcp.js` runs the same server directly and is used for development and tests. Set `OPTIC_DATA_DIR` to choose the profile.

### Authentication and kubeconfig handling

- Clusters are discovered exactly as the desktop app discovers them (`ClusterManager`), so cluster IDs match Optic's.
- Credentials stay in your kubeconfig files. Optic stores no cloud or cluster credentials for MCP.
- Credential commands from the kubeconfig run only if they were part of the approval:
  - Exec credential plugins (for example `aws eks get-token`, `kubelogin` or `gke-gcloud-auth-plugin`) and legacy `auth-provider` commands are shown at approval time.
  - The approval is bound to a fingerprint of the context. If the command or its arguments change, the context is suspended until you approve it again, and the new command is never run (tested).
- Kubeconfig contents are never sent to the AI client. Tool output contains no server URLs, users, tokens or certificate paths.
- A malformed kubeconfig file is skipped. Other files still load.

### Approvals

- **Where they're stored:** `mcp-access.json` in the Optic profile, written with mode 0600.
- **What an approval records:** the cluster ID, context name, kubeconfig path, approval time and a fingerprint.
- **What the fingerprint covers:** the context name, server URL, certificate authority (a hash of the data, or the file path), TLS verification setting and authentication method (type, plus the exact command, arguments and environment variable *names* for exec plugins).
  - Tokens and client certificates are excluded, so routine credential rotation keeps the approval.
  - A different server, CA or credential command suspends it.
- **Missing or corrupt file:** a missing or corrupt approval file grants nothing.
- **Unapproved contexts** are never named to the client. `list_clusters` reports only how many exist.
- **No fallback:** a request for an unapproved, suspended or missing context fails. The server never substitutes another cluster.

## Tools

All tools are annotated `readOnlyHint: true` and `destructiveHint: false`. The arguments are validated by Zod schemas and then validated again before any request:

- Kubernetes names must be single path segments.
- Namespaces must be DNS labels.
- Selectors may not contain control characters.
- API versions and resource names must match Kubernetes syntax.

| Tool | Purpose | Key arguments |
|---|---|---|
| `list_clusters` | Approved contexts and their status | — |
| `get_cluster_info` | Kubernetes version, default namespace, authentication type | `cluster` |
| `list_namespaces` | Namespaces (paginated) | `cluster`, `labelSelector`, `limit`, `continue` |
| `get_namespace_details` | Namespace with its resource quotas and limit ranges | `cluster`, `name` |
| `list_pods` | Phase, readiness, restarts, waiting reason, node | `cluster`, `namespace?`, selectors, paging |
| `get_pod_details` | Full pod (redacted) | `cluster`, `namespace`, `name` |
| `get_pod_logs` | Log lines (`tailLines` ≤ 5000, ≤ 1 MB, `previous`, `sinceSeconds`) | `cluster`, `namespace`, `name`, `container?` |
| `list_deployments` | Replicas, readiness, images, conditions | `cluster`, `namespace?`, selectors, paging |
| `get_deployment_details` | Full deployment (redacted) | `cluster`, `namespace`, `name` |
| `list_services` | Type, cluster IP, ports, selector | `cluster`, `namespace?`, selectors, paging |
| `get_service_details` | Full service | `cluster`, `namespace`, `name` |
| `list_events` | Events, optionally only `Warning` | `cluster`, `namespace?`, `type?`, paging |
| `get_resource_events` | Events for one object, newest first (≤ 100) | `cluster`, `kind`, `name`, `namespace?` |
| `list_nodes` | Readiness, roles, kubelet, capacity, taints | `cluster`, `labelSelector`, paging |
| `get_node_details` | Full node | `cluster`, `name` |
| `discover_api_resources` | Served resource types (preferred versions) and their read verbs | `cluster`, `group?` |
| `get_resource_yaml` | Any readable object (redacted) | `cluster`, `apiVersion`, `resource`, `namespace?`, `name` |

**Paging:**
- Lists use Kubernetes paging (`limit`, default 50 and at most 500, plus a `continue` token). The response carries `continue` and `remainingItemCount`.
- The order of items is the API server's order.

**Limits:**
- Every Kubernetes request times out after 20 seconds.
- Tool output is capped at 200,000 characters and marked when truncated.
- Logs are capped server-side with `limitBytes`, and again while reading.

**`get_resource_yaml`:** reads only resources that the API server advertises with the `get` verb. Subresources such as `pods/exec`, `pods/portforward` and `*/proxy` can't be expressed.

**Errors** are returned as MCP tool errors in the form `CODE: message`. For example:
- `FORBIDDEN: Kubernetes API: nodes is forbidden: User "…" cannot list resource "nodes"…`
- `NOT_APPROVED`, `APPROVAL_STALE`, `TIMEOUT`, `UNREACHABLE`, `MALFORMED_RESPONSE`, `INVALID_INPUT`.

Transport error text, which can contain URLs, is never forwarded.

## Security decisions

| Requirement | How it is met |
|---|---|
| Read-only | No write tools exist. All requests are `GET`. Tests assert that the fake API server only ever received `GET` requests. |
| No exec, port-forward or proxy | There are no such tools, and `get_resource_yaml` rejects any resource name containing `/`. |
| RBAC respected | Requests use your kubeconfig identity. Denials are returned with the API server's explanation (verified on a real cluster with a restricted ServiceAccount). |
| No Secret data | `v1` Secrets are reduced to metadata, `type` and `dataKeys`, with their annotations removed (where `last-applied-configuration` can contain the whole Secret). |
| Sensitive values redacted | <ul><li>Fields and name/value pairs whose names look like credentials (`password`, `secret`, `token`, `credential`, `api key`, `private key`, `access key`) are masked.</li><li>References such as `secretName` are kept.</li><li>`managedFields` and `last-applied-configuration` are dropped.</li><li>Bearer and Basic headers, JWTs, PEM private keys and `password=`/`token:`-style text are masked in logs, events and all strings.</li></ul> |
| Explicit per-cluster opt-in | Approvals are made only in the Optic window, or with `optic --mcp --allow <context>` in an **interactive** terminal where you type the context name. An agent running shell commands cannot approve clusters for itself. |
| No arbitrary commands | Credential commands run only when they match the approved fingerprint. |
| No kubeconfig exposure | Tool output never includes server URLs, users or credentials. |
| No path traversal or file access | Names are validated path segments and URL-encoded. The server reads only kubeconfig sources and its approval file, never paths taken from tool arguments. |
| Safe transport | stdio only. Nothing listens on a network port. |
| No silent fallback | An unknown, unapproved or ambiguous `cluster` value fails with an explicit error. |
| No credential logging | The server logs one line to stderr when it's ready. It never logs tool arguments, responses or credentials. |

Redaction of values that are not Secrets is best effort. A ConfigMap value whose key looks harmless is returned as-is, the same as `kubectl get`.

## Setup

### 1. Approve a cluster

In Optic, open **Cluster settings › AI access** for the cluster and choose **Approve AI access…**. The dialog shows any credential command the server will run. **Revoke access** removes the approval immediately.

From a terminal (macOS, Linux, or a development build):

```bash
optic --mcp --list               # contexts, approval state, auth type
optic --mcp --allow my-context   # interactive confirmation
optic --mcp --revoke my-context
optic --mcp --revoke-all
```

On Windows, the packaged app is a GUI program and has no console for these commands, so use the AI access page.

### 2. Configure the client

The AI access page shows the exact command for your installation.

**Claude Code** (tested: `claude mcp get` reports **Connected**):

```bash
claude mcp add optic-kubernetes -- "C:\Program Files\Optic\Optic.exe" --mcp
```

**Any MCP client** that takes a JSON configuration:

```json
{
  "mcpServers": {
    "optic-kubernetes": { "command": "/Applications/Optic.app/Contents/MacOS/Optic", "args": ["--mcp"] }
  }
}
```

**Development build:** use `electron.exe <repo> --mcp`, or `node <repo>/out/main/mcp.js` with `OPTIC_DATA_DIR` pointing at your Optic profile.

### 3. Use it

Ask the client to call `list_clusters` first. Then pass a cluster's `id` or context name as `cluster` to the other tools.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `list_clusters` is empty | No context is approved. Approve one in Cluster settings › AI access. |
| `NOT_APPROVED` | The `cluster` value isn't an approved context. Use an `id` from `list_clusters`. |
| `APPROVAL_STALE` / "needs re-approval" | The context's server, CA or credential command changed. Review it, then approve again. |
| `AMBIGUOUS_CLUSTER` | Two approved contexts share a name. Use the `id`. |
| `FORBIDDEN: Kubernetes API: …` | Your Kubernetes identity lacks that permission. The server cannot bypass RBAC. |
| `TIMEOUT` / `UNREACHABLE` | The API server didn't answer within 20 s, or couldn't be reached. Check your VPN or network and the kubeconfig server address. |
| The client shows the server as failed | Run the command from the AI access page in a terminal. "Optic MCP server ready" on stderr means it started. Check that the executable path in the client configuration exists. |
| Exec credential errors | The credential command (for example `aws`) must be on `PATH` for the process the MCP client starts. |

## Tests

| Suite | Coverage |
|---|---|
| `tests/mcp-tools.test.ts` (19) | <ul><li>A real MCP client with the in-memory transport against a fake API server over HTTP.</li><li>Covers every tool, paging, approval-only visibility, revocation, a stale approval whose new credential command is not run, Secret and ConfigMap redaction, and log redaction and limits.</li><li>Error cases: subresource rejection, oversized output, RBAC denial, invalid arguments sending no requests, malformed responses, an unreachable cluster, timeout, and a malformed kubeconfig.</li><li>The fake server receives only `GET` requests.</li></ul> |
| `tests/mcp-access.test.ts` (9) | Fingerprint behavior (rotation versus changes), authentication description, redaction rules, CLI `--list`, `--allow` (needs a TTY and the typed name), `--revoke`, `--revoke-all`, unknown options, corrupt approval files. |
| `tests/mcp-smoke.mjs` (in `npm run test:smoke`) | Real stdio processes, both `node out/main/mcp.js` and Electron `--mcp`: handshake, 17 read-only tools, approved-only clusters, tool calls, `GET`-only traffic, exit on disconnect. |
| `tests/smoke.mjs` | The Cluster settings › AI access UI: approve, check the approval file (no credentials), revoke. |
| Live (manual, Kubernetes v1.36.6) | All 17 tools against a real cluster, paging in `kube-system`, Secret and log redaction, and RBAC denials for a restricted ServiceAccount. Used an isolated profile, so your real approvals were not changed. |

## Client compatibility

| Client | Status |
|---|---|
| Official MCP TypeScript SDK client 2.3.1 (stdio and in-memory) | Tested: all tools |
| Claude Code 2.1.314 (`claude mcp add` / `claude mcp get`) | Tested: connects and initializes; tool calls were not driven through a model |
| Other clients (Claude Desktop, Cursor, …) | Not tested. Expected to work with any stdio MCP client, but not confirmed. |

## Known limitations

- Windows: the `--list`, `--allow` and `--revoke` terminal commands need a console, which the packaged GUI executable doesn't have. Use the AI access page instead.
- MCP mode relies on Electron's `RunAsNode` fuse being enabled (the default). If a future build disables that fuse, it needs a dedicated Node entry point instead.
- On macOS and Linux, a development build and a packaged build may use different profile folder names. In that case, approvals made in one aren't seen by the other.
- `list_events` returns the API server's order. Only `get_resource_events` sorts newest first.
- Redaction of non-Secret objects is pattern-based and can miss credentials stored under harmless-looking names.
- On the AI access page, the shared **Save settings** bar is visible, although AI access changes take effect immediately.
- There's no audit log of MCP tool calls yet.

## Remaining work

- A local audit log of MCP calls, which credential command ran, and approval changes.
- Optional per-cluster namespace limits for MCP, narrower than RBAC.
- Metrics tools (`top`) through metrics-server or Prometheus.
- Testing with more clients.
