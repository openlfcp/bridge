// The Apple Reminders adapter (D-010 §4.4–4.5, §5.4, §5.5, §6.1): projections,
// matching, the filter and the plan of a pass. Pure: no I/O, no host.

export {
  type FilterMode,
  inFilter,
  isFilterMode,
  needsMe,
  projectable,
} from "./filter.js";
export { instance8, markerUrl, parseTaskLink, type TaskLink, taskLink } from "./link.js";
export {
  type ItemOutcome,
  type LinkMatch,
  type LinkRow,
  type LinkState,
  type MatchContext,
  type MatchResult,
  match,
} from "./matching.js";
export {
  type Decision,
  type FieldBase,
  type FieldDecision,
  type ItemNote,
  type PassBinding,
  type PassView,
  type Plan,
  type PlannedConflict,
  type PlannedIntent,
  plan,
  type Transition,
  type TransitionKind,
  type Waiting,
} from "./plan.js";
export {
  type AppleWrite,
  appleWrite,
  BUCKET_TO_APPLE,
  equivalent,
  FIELDS,
  type Field,
  type LfcpShadow,
  type LfcpTask,
  localDateIn,
  type PriorityBucket,
  type Projection,
  type Projections,
  priorityBucket,
  projectApple,
  projectLfcp,
  type StatusProjection,
  sameProjection,
  shadowOf,
} from "./projection.js";
