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
- stdin closing (the shell is gone) makes the host shut down as for `shutdown`.

## Commands (shell → host stdin)

`{"v":1,"id":"<string>","cmd":"<name>", …}`; the shell numbers them, the reply echoes `id`.
The host runs them one at a time, in order.

| `cmd` | Fields | Host, MVP 0.6 |
|---|---|---|
| `pause` | — | writes STOP (`db/stop.ts`): no effect runs until `resume`. Permanent, survives restarts |
| `resume` | — | removes STOP; a run process that failed to start is tried again |
| `answer` | `questionId`, `choice` | `not_implemented` until E-042 |
| `export` | `path` | `not_implemented` until E-045 |
| `remove` | `bindingId`, `ack?` (bool) | `not_implemented` until E-034 |
| `shutdown` | `reason`: `update` \| `quit` \| `logout` | nothing new starts, in-flight work finishes (≤ 60 s), exit 0. **Never writes STOP**: syncing continues at the next start |
| `openURL` | `url` (`lfcp-bridge:` only) | acknowledged (`result.handled: false`) until the handoff of E-031 |

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
- `lfcp-bridge://` URLs that arrive while no host runs wait (at most 8) and are sent after its `hello`.
