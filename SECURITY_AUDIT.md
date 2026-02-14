# NanoClaw Security Audit

**Date:** 2026-02-13
**Scope:** Full source code review (~5,155 lines across 13 source files + container agent runner)
**Auditor:** Automated analysis via Claude Opus 4.6

---

## Executive Summary

NanoClaw demonstrates a **strong security-first architecture** for a personal AI assistant. The primary security boundary — OS-level container isolation via Apple Container — is well-chosen and properly implemented. Per-group filesystem and IPC isolation, an external tamper-proof mount allowlist, and credential filtering via stdin are all solid design decisions.

However, the audit identified **2 high-severity issues** (shell injection vectors), **4 medium-severity issues** (credential exposure patterns, missing input validation), and **several low-severity items** that represent defense-in-depth improvements.

**Overall risk posture: Moderate.** The container boundary provides strong isolation, but host-side injection vectors and the main group's elevated privileges create attack surface that should be hardened.

---

## Findings

### CRITICAL / HIGH SEVERITY

#### H1: Shell Injection via `osascript` Notification

**Location:** [whatsapp.ts:76-78](src/channels/whatsapp.ts#L76-L78)

```typescript
exec(
  `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
);
```

**Risk:** The `msg` variable is interpolated directly into a shell command within single-quoted osascript containing a double-quoted string. Although `msg` is currently a hardcoded string on L73-74, this pattern is dangerous because:
- Any future change to make `msg` dynamic (e.g., including error details) would immediately create an RCE vector
- The pattern itself violates secure coding principles and invites copy-paste bugs

**Impact:** Remote Code Execution on the host if the message ever incorporates external data.

**Recommendation:** Use `execFile` with argument array to avoid shell interpretation entirely:
```typescript
import { execFile } from 'child_process';
execFile('osascript', ['-e',
  `display notification "${msg}" with title "NanoClaw" sound name "Basso"`
]);
```

---

#### H2: Shell Injection via `container stop` Command

**Location:** [container-runner.ts:385](src/container-runner.ts#L385) and [index.ts:445](src/index.ts#L445)

```typescript
// container-runner.ts:385
exec(`container stop ${containerName}`, { timeout: 15000 }, (err) => { ... });

// index.ts:445
execSync(`container stop ${name}`, { stdio: 'pipe' });
```

**Risk:** Both call sites use string interpolation in `exec`/`execSync`, which passes the command through a shell.

- In `container-runner.ts:385`, `containerName` is constructed as `nanoclaw-${safeName}-${Date.now()}` where `safeName` is sanitized via `replace(/[^a-zA-Z0-9-]/g, '-')` — so injection risk is **mitigated but fragile**.
- In `index.ts:445`, `name` comes from parsing `container ls --format json` output. If the container runtime ever returns unexpected data, or if the JSON is malformed, this could be exploitable.

**Impact:** Host-level code execution if sanitization is bypassed or source data is tampered with.

**Recommendation:** Replace both with `spawn` or `execFile`:
```typescript
import { execFileSync } from 'child_process';
execFileSync('container', ['stop', name], { stdio: 'pipe' });
```

---

### MEDIUM SEVERITY

#### M1: Credential Exposure Inside Container

**Location:** [agent-runner/src/index.ts:510-515](container/agent-runner/src/index.ts#L510-L515)

```typescript
const sdkEnv: Record<string, string | undefined> = { ...process.env };
for (const [key, value] of Object.entries(containerInput.secrets || {})) {
  sdkEnv[key] = value;
}
```

**Risk:** API credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are placed in the `sdkEnv` object which is passed to the Claude Agent SDK. While a `PreToolUse` hook strips these from Bash subprocess environments (L192-209), the credentials remain discoverable:
- Via `/proc/self/environ` if the SDK sets them on the Node process
- Via any SDK-internal logging or error dumps
- Via MCP servers spawned by the SDK (which inherit env)

**Mitigation in place:** The `createSanitizeBashHook` prepends `unset` commands to all Bash tool invocations. This is a good defense layer but relies on the hook executing correctly for every Bash call.

**Impact:** If an agent is manipulated via prompt injection, it could exfiltrate the API key.

**Note:** This is an acknowledged limitation in [SECURITY.md:79](docs/SECURITY.md#L79) — the project correctly identifies this as an architectural constraint of the Claude Agent SDK.

---

#### M2: Unvalidated Group Folder Name in Registration

**Location:** [ipc.ts:363-367](src/ipc.ts#L363-L367)

```typescript
if (data.jid && data.name && data.folder && data.trigger) {
  deps.registerGroup(data.jid, {
    name: data.name,
    folder: data.folder,  // From IPC JSON — not validated
    ...
  });
}
```

**Risk:** The `folder` field from IPC data is used directly in path construction throughout the codebase:
```typescript
// container-runner.ts:77
hostPath: path.join(GROUPS_DIR, group.folder)

// container-runner.ts:151
const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
```

A malicious folder value like `../../../etc` or `main` (impersonating the admin group) could cause path traversal or privilege escalation.

**Mitigation in place:** Only the main group can call `register_group` (L356 authorization check). However, the main group agent operates with full permissions and could be manipulated via prompt injection.

**Impact:** Path traversal leading to arbitrary directory mounting, or group impersonation.

**Recommendation:** Add strict folder name validation:
```typescript
const FOLDER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
if (!FOLDER_REGEX.test(data.folder)) {
  logger.warn({ folder: data.folder }, 'Invalid folder name rejected');
  break;
}
```

---

#### M3: Main Group Has Read-Write Access to Project Root

**Location:** [container-runner.ts:67-73](src/container-runner.ts#L67-L73)

```typescript
if (isMain) {
  mounts.push({
    hostPath: projectRoot,
    containerPath: '/workspace/project',
    readonly: false,
  });
}
```

**Risk:** The main group's container agent can modify:
- Application source code (`src/`)
- Container configuration (`container/Dockerfile`, `container/build.sh`)
- The `.env` file containing API credentials
- Database files (`store/messages.db`)
- Group memory files for any group

**Impact:** A compromised main agent could backdoor the application, exfiltrate credentials, or modify security checks. This effectively makes the main group a single point of compromise for the entire system.

**Recommendation:** Consider mounting project root as read-only and providing a dedicated writable directory for legitimate modifications (e.g., `groups/main/` only). If the main agent needs to modify code, require explicit user authorization.

---

#### M4: Temporary File Contains Secrets

**Location:** [container/Dockerfile entrypoint](container/Dockerfile) and [agent-runner/src/index.ts:498-499](container/agent-runner/src/index.ts#L498-L499)

The entrypoint writes stdin to `/tmp/input.json` before reading it:
```bash
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

The agent runner deletes it after reading:
```typescript
try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
```

**Risk:** Between writing and deletion, secrets are on the filesystem. While the container is ephemeral and single-tenant, this creates a window where:
- Another process in the container could read the file
- If the unlink fails, secrets persist until container destruction

**Impact:** Low in practice (container is ephemeral, single-user), but violates principle of least persistence for secrets.

**Recommendation:** Pipe stdin directly to the Node process without an intermediate file:
```bash
exec node /tmp/dist/index.js
```

---

### LOW SEVERITY

#### L1: Unencrypted WhatsApp Auth State at Rest

**Location:** `store/auth/` directory (created by [whatsapp.ts:54-57](src/channels/whatsapp.ts#L54-L57))

WhatsApp session credentials (encryption keys, identity) are stored as plaintext files on the host filesystem via Baileys' `useMultiFileAuthState`. If the host is compromised, an attacker can clone the WhatsApp session.

**Mitigation:** The `store/` directory is in `.gitignore` and never mounted into non-main containers.

---

#### L2: No Rate Limiting on IPC File Processing

**Location:** [ipc.ts:68-70](src/ipc.ts#L68-L70)

```typescript
const messageFiles = fs.readdirSync(messagesDir)
  .filter((f) => f.endsWith('.json'));
```

A malicious agent could flood its IPC directory with thousands of JSON files, causing the host process to spend excessive time in the IPC processing loop.

**Recommendation:** Add a per-poll limit:
```typescript
const messageFiles = fs.readdirSync(messagesDir)
  .filter((f) => f.endsWith('.json'))
  .slice(0, 100);
```

---

#### L3: No Upper Bound on Interval Schedule Values

**Location:** [ipc.ts:231-238](src/ipc.ts#L231-L238)

```typescript
const ms = parseInt(data.schedule_value, 10);
if (isNaN(ms) || ms <= 0) { ... }
```

Very large values or very small values (e.g., `1` ms) are accepted. A 1ms interval would create excessive container spawning.

**Recommendation:** Add bounds: `if (ms < 60000 || ms > 365 * 24 * 60 * 60 * 1000)`.

---

#### L4: Container Build Does Not Pin Dependency Versions

**Location:** [container/Dockerfile](container/Dockerfile)

`apt-get install -y chromium` and `npm install` (vs `npm ci`) do not pin exact versions, which could lead to supply chain attacks via dependency confusion or compromised packages.

---

#### L5: Allowlist Cached Without Reload Mechanism

**Location:** [mount-security.ts:22-23](src/mount-security.ts#L22-L23)

```typescript
let cachedAllowlist: MountAllowlist | null = null;
```

The mount allowlist is cached for the lifetime of the process. Changes to `~/.config/nanoclaw/mount-allowlist.json` require a process restart. This is a minor operational concern — if a mount is revoked, it remains allowed until restart.

---

## Architecture Strengths

The following security decisions are well-implemented and deserve recognition:

| Area | Implementation | Assessment |
|------|---------------|------------|
| **Container isolation** | Apple Container (lightweight Linux VMs) with `--rm` | Excellent primary boundary |
| **Mount allowlist** | External file at `~/.config/nanoclaw/`, never mounted into containers | Tamper-proof from agents |
| **Credential filtering** | Allowlist of 2 env vars, passed via stdin, deleted after use | Strong secret hygiene |
| **Bash secret sanitization** | `PreToolUse` hook prepends `unset` to all Bash commands | Good defense-in-depth |
| **Per-group IPC isolation** | Directory-based identity, authorization checks per operation | Robust access control |
| **Session isolation** | Separate `.claude/` per group, preventing cross-group disclosure | Proper data isolation |
| **SQL injection prevention** | Prepared statements with `?` placeholders throughout `db.ts` | No injection vectors found |
| **XML escaping** | Proper `escapeXml()` in `router.ts` for message formatting | Correct implementation |
| **Path traversal protection** | Symlink resolution, `..` rejection, relative path enforcement | Multi-layer validation |
| **Blocked mount patterns** | Default list covers `.ssh`, `.aws`, `.gnupg`, `.env`, etc. | Comprehensive defaults |
| **Non-root container execution** | `USER node` in Dockerfile | Reduced container privilege |
| **Ephemeral containers** | `--rm` flag ensures no persistent container state | Limits blast radius |

---

## Risk Matrix

| ID | Severity | Category | Exploitability | Impact | Status |
|----|----------|----------|---------------|--------|--------|
| H1 | High | Injection | Low (currently hardcoded msg) | RCE on host | Pattern risk |
| H2 | High | Injection | Low (sanitized input) | RCE on host | Fragile mitigation |
| M1 | Medium | Credential Exposure | Medium (prompt injection) | API key theft | Acknowledged |
| M2 | Medium | Path Traversal | Low (main-only) | Privilege escalation | No validation |
| M3 | Medium | Over-privilege | Medium (prompt injection) | Full system compromise | By design |
| M4 | Medium | Secret Persistence | Low (ephemeral container) | Credential exposure | Brief window |
| L1 | Low | Data at Rest | Requires host access | Session hijacking | Acceptable risk |
| L2 | Low | DoS | Low (self-harm only) | CPU exhaustion | No limit |
| L3 | Low | DoS | Low (self-harm only) | Resource exhaustion | No bounds |
| L4 | Low | Supply Chain | Unlikely | Compromised container | Unpinned deps |
| L5 | Low | Operational | N/A | Stale permissions | Cache design |

---

## Recommendations (Priority Order)

1. **Replace `exec`/`execSync` with `execFile`/`spawn`** for all shell commands that include variables (H1, H2). This is the highest-impact, lowest-effort fix.

2. **Add strict folder name validation** with a regex allowlist when registering groups via IPC (M2).

3. **Eliminate the temp file** in the container entrypoint by piping stdin directly to Node (M4).

4. **Add rate limits** to IPC file processing and bounds to schedule interval values (L2, L3).

5. **Consider read-only project root** for the main group, with a separate writable area for group-specific data (M3). This is a larger architectural change but would significantly reduce the blast radius of a compromised main agent.

6. **Pin container dependency versions** in the Dockerfile for reproducible, auditable builds (L4).

---

## Conclusion

NanoClaw's security model is fundamentally sound. The choice of OS-level container isolation as the primary boundary, combined with external allowlists and per-group namespacing, creates a robust defense-in-depth architecture. The identified vulnerabilities are primarily in host-side code paths that use shell interpolation — a common pattern that is straightforward to fix. The credential exposure inside containers is an acknowledged SDK limitation that the project handles as well as currently possible.

For a personal assistant project of this scope, the security posture is above average. Addressing the high-severity injection vectors (H1, H2) would bring the project to a strong security baseline.
