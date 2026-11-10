// The one table of what an effect needs (D-010 §7.1, §6.5, §7.6; r3 P2-4):
// for every mode (normal / bootstrap / verification / unbind) and every kind
// of effect, the conditions checked before the effect and before each retry.
// No caller has its own list: the executor, bootstrap (PR 9), verification
// (PR 9) and unbind (PR 9) all ask `permits`.
//
// | condition                 | normal | verification | bootstrap      | unbind  |
// |---------------------------|--------|--------------|----------------|---------|
// | no STOP, no Safe Mode     | yes    | yes          | yes            | yes     |
// | installation active       | yes    | yes          | yes            | yes     |
// | binding state             | active | active       | bootstrapping  | active, pending_dry_run, bootstrapping |
// | no hold at all            | yes    | yes          | yes            | — (*)   |
// | transport ok (TCC)        | to_apple | to_apple   | yes            | yes     |
// | list by target_ref there  | to_apple | to_apple   | marker step    | yes     |
// | ownership_checked         | to_apple | to_apple   | — (**)         | yes     |
// | no foreign marker         | (in ownership) | (in ownership) | yes  | —       |
// | access_checked_now        | to_apple; to_lfcp or offline rule | same | — | —   |
// | writesVerified            | to_apple | — (the verification binding) | — | —  |
// | verification binding      | —      | yes          | —              | —       |
// | which effects             | to_apple update/create/restore_url, to_lfcp | same | list_create, marker_create | marker_retire |
//
// (*) unbind is the person's own command to stop syncing a section: a hold
//     (which only stops synchronisation) does not keep it from retiring the
//     bridge's own marker; STOP and Safe Mode do.
// (**) bootstrap establishes ownership: it requires that no foreign marker
//     exists for the Resource (§6.5 scan) instead.
// to_lfcp: access_checked_now, or (offline_commit_allowed and no connection).

export type Mode = "normal" | "verification" | "bootstrap" | "unbind";

export type EffectKind =
  | "apple_create"
  | "apple_update"
  | "apple_restore_url"
  | "lfcp_commit"
  | "list_create"
  | "marker_create"
  | "marker_retire";

/** Everything the table reads, gathered fresh before each effect. */
export interface EffectContext {
  readonly mode: Mode;
  readonly effect: EffectKind;
  readonly stopped: boolean;
  readonly safeMode: boolean;
  readonly installationActive: boolean;
  readonly bindingState: "bootstrapping" | "pending_dry_run" | "active" | "removed";
  readonly verificationBinding: boolean;
  readonly holds: readonly string[];
  readonly transportOk: boolean;
  /** The binding's list (target_ref) exists; undefined when not known (no list yet). */
  readonly listPresent: boolean | undefined;
  readonly ownershipChecked: boolean;
  readonly foreignMarker: boolean;
  readonly accessCheckedNow: boolean;
  readonly offlineCommitAllowed: boolean;
  readonly connected: boolean;
  readonly writesVerified: boolean;
}

export type Denial =
  | "stopped"
  | "safe_mode"
  | "installation_not_active"
  | "binding_state"
  | "hold"
  | "transport_not_ok"
  | "list_missing"
  | "ownership_not_checked"
  | "foreign_marker"
  | "access_not_checked"
  | "writes_not_verified"
  | "not_verification_binding"
  | "effect_not_allowed_in_mode";

const EFFECTS_OF: Readonly<Record<Mode, readonly EffectKind[]>> = {
  normal: ["apple_create", "apple_update", "apple_restore_url", "lfcp_commit"],
  verification: ["apple_create", "apple_update", "apple_restore_url", "lfcp_commit"],
  bootstrap: ["list_create", "marker_create"],
  unbind: ["marker_retire"],
};

const STATES_OF: Readonly<Record<Mode, readonly EffectContext["bindingState"][]>> = {
  normal: ["active"],
  verification: ["active"],
  bootstrap: ["bootstrapping"],
  unbind: ["active", "pending_dry_run", "bootstrapping"],
};

const toApple = (e: EffectKind) =>
  e === "apple_create" || e === "apple_update" || e === "apple_restore_url";

/** The denials of an effect in its context; empty when it may run. */
export function permits(c: EffectContext): readonly Denial[] {
  const d: Denial[] = [];
  const { mode, effect } = c;
  if (!EFFECTS_OF[mode].includes(effect)) d.push("effect_not_allowed_in_mode");
  if (c.stopped) d.push("stopped");
  if (c.safeMode) d.push("safe_mode");
  if (!c.installationActive) d.push("installation_not_active");
  if (!STATES_OF[mode].includes(c.bindingState)) d.push("binding_state");
  if (mode !== "unbind" && c.holds.length > 0) d.push("hold");
  if (mode === "verification" && !c.verificationBinding) d.push("not_verification_binding");
  if (mode === "normal" && c.verificationBinding) d.push("not_verification_binding");
  const apple = toApple(effect);
  if ((apple || mode === "bootstrap" || mode === "unbind") && !c.transportOk)
    d.push("transport_not_ok");
  if ((apple || mode === "unbind" || effect === "marker_create") && c.listPresent !== true)
    d.push("list_missing");
  if ((apple || mode === "unbind") && !c.ownershipChecked) d.push("ownership_not_checked");
  if (mode === "bootstrap" && c.foreignMarker) d.push("foreign_marker");
  if (apple && !c.accessCheckedNow) d.push("access_not_checked");
  if (effect === "lfcp_commit" && !(c.accessCheckedNow || (c.offlineCommitAllowed && !c.connected)))
    d.push("access_not_checked");
  if (mode === "normal" && apple && !c.writesVerified) d.push("writes_not_verified");
  return d;
}
