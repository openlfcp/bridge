# Shell ↔ host channel, version 1

The contract between `LFCP Bridge.app` (the shell, `app/`) and the host it runs (`node
Resources/host/bridge.mjs run --app`, `packages/host/src/app/`). MVP 0.6 architecture §1, §2.3, §6.3.
Implementations: `packages/host/src/app/ipc.ts` (host), `app/Sources/BridgeShellCore/IPC.swift` (shell).

## Transport

- The shell starts the host with stdin and stdout as pipes; stderr goes to
  `~/Library/Logs/org.openlfcp.bridge/host.log`.
- One JSON object per line, UTF-8, `\n` at the end, at most 65 536 bytes. Blank lines are ignored;
  a longer line is dropped up to its `\n` (the host answers it with a `bad_line` reply).
- Every object has `"v": 1`. A side that gets another version, or a type it does not know, ignores
  it (the shell) or answers `bad_line` / `unknown_command` (the host).
- In `run --app` nothing but events and replies goes to stdout.
- stdin closing (the shell is gone), SIGTERM and SIGINT make the host shut down as for `shutdown`.

## Commands (shell → host stdin)

`{"v":1,"id":"<string>","cmd":"<name>", …}`; the shell numbers them, the reply echoes `id`.
The host runs them one at a time, in order.

| `cmd` | Fields | Host, MVP 0.6 |
|---|---|---|
| `pause` | — | writes STOP (`db/stop.ts`): no effect runs until `resume`. Permanent, survives restarts |
| `resume` | — | removes STOP; a run process that failed to start is tried again |
| `answer` | `questionId`, `choice` | `not_implemented` until E-042 |
| `export` | `path` (absolute, `.zip`) | writes the diagnostics zip (`diag-schema v1`, A§11) there; `result.path`. A relative path or another extension: `bad_arguments`. The path is never logged |
| `remove` | `bindingId`, `ack?` (bool) | `not_implemented` until E-034 |
| `shutdown` | `reason`: `update` \| `quit` \| `logout` | at once, also while the run process starts: no new effect or retry starts (not even inside the pass in flight), what is in flight finishes, exit 0. **Never writes STOP**: syncing continues at the next start |
| `openURL` | `url` (`lfcp-bridge:` only) | acknowledged (`result.handled: false`) until the handoff of E-031 |
| `codeIdentity` | `requestId` (a `codeCheck` id); `arch` (`arm64` \| `x86_64`), `valid` (bool), `detail?`, `shell` (cdhash), `nested: [{path, cdhash}]` — or `error` alone | the answer to `codeCheck`: taken at once, never behind the queue (a start waits for it). Cdhashes are 40 lowercase hex (`kSecCodeInfoUnique`) |

No command waits for the run process to start. A command that fails while it runs (for example
STOP cannot be written) gets `reply{ok:false, error:{code:"failed", detail:<error code>}}`; the
next command runs as usual.

**Deadline.** 60 s from the shutdown cover a start in progress and the stop. Past them the host
exits at once with code 1, without releasing `run.lock` or closing `bridge.sqlite` under work that
still runs: committed rows are durable, an effect in flight stays `effecting` for the next start's
recovery, and the next host takes over the lock of the dead pid.

`openURL` carries the base link's secret in its fragment: neither side logs it, and no error reply
repeats a field's value.

## Events (host stdout → shell)

| `type` | Fields | When |
|---|---|---|
| `hello` | `version`, `pid` | first line, once |
| `status` | `state`, `reason?`, `sections: [{bindingId, title, state}]` | after hello, and on every change of state |
| `question` | `questionId`, `bindingId`, `kind`, `resolved?` | a question opens or goes away (E-042) |
| `needsAttention` | `bindingId`, `code` (architecture §7.3) or `null` | a binding starts or stops needing attention (E-043) |
| `reply` | `id` (or `null` for an unreadable line), `ok`, `result?` / `error: {code, detail?}` | one per command line |
| `codeCheck` | `id`, `paths` (bundle-relative Mach-O files of the host's slice) | the write gate (A§9.1 (3)–(5)): before the first start of the helper and before every restart. The shell answers with `codeIdentity`: `SecStaticCodeCheckValidity` (strict, nested code) of its bundle, its running cdhash, and the cdhash of each path for its arch (`app/Sources/BridgeShellCore/CodeCheck.swift`). No answer in 60 s → preview |

`status.state`: `starting` (before the run process), `running`, `paused` (STOP is set),
`unavailable` (the run process could not start; `reason: start_failed`), `stopping` (after
`shutdown`, `reason` is the shutdown reason).

`error.code`: `bad_line`, `unknown_command`, `bad_arguments`, `not_implemented`,
`shutting_down`, `failed`.

## Shell side

- The host is restarted after an unexpected exit with a back-off of 1, 2, 4 … 60 s; a host that ran
  for 60 s starts the count again. Nothing is restarted after `shutdown`.
- `shutdown`: the shell waits 70 s for the exit, then SIGTERM, then SIGKILL after 5 s.
- Quit → `shutdown{quit}`; logout or power off → `shutdown{logout}`; installing an update (Sparkle,
  E-056) → `shutdown{update}`.
- `lfcp-bridge://` URLs go only to a host that said `hello` and has not exited since; until then they
  wait (at most 8). A host that exits before its `hello`, or whose stdin refuses the line, does not
  take them: the next host gets them after its `hello`.
- The shell drops any host line longer than 65 536 bytes, however the pipe split it.
