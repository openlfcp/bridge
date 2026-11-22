// The person of L3 (T§2): what someone does in Reminders that the bridge itself never does —
// complete, reopen or delete a reminder — on the real EventKit store, as its own app with its own
// Reminders access (a TCC row for its bundle, launched through `open`: it is its own responsible
// process, as in spike S-3). One command per launch, one JSON line on stdout, exit 0 when ok.
// It never asks for access (no dialog on a runner) and touches only "LFCP Verify · " lists.
//
//   status                     {"authorization": "fullAccess" | …}
//   complete <id>              completes the reminder (completion date: now)
//   reopen <id>                reopens it
//   delete <id>                deletes it
//   delete-list <calendar id>  deletes the list
//   cleanup                    deletes every list titled "LFCP Verify · …"

import EventKit
import Foundation

let prefix = "LFCP Verify · "
let store = EKEventStore()

func emit(_ o: [String: Any], _ code: Int32 = 0) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(code)
}
func fail(_ message: String) -> Never { emit(["ok": false, "error": message], 1) }

func authorization() -> String {
  switch EKEventStore.authorizationStatus(for: .reminder).rawValue {
  case 0: return "notDetermined"
  case 1: return "restricted"
  case 2: return "denied"
  case 3: return "fullAccess"
  case 4: return "writeOnly"
  default: return "unknown"
  }
}

/** A reminder of a verification list, by its calendarItemIdentifier. */
func reminder(_ id: String) -> EKReminder {
  guard let r = store.calendarItem(withIdentifier: id) as? EKReminder, r.refresh() else {
    fail("no reminder \(id)")
  }
  guard r.calendar.title.hasPrefix(prefix) else { fail("not in a \(prefix)list: \(id)") }
  return r
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("no command") }
if cmd == "status" { emit(["ok": true, "authorization": authorization()]) }
guard authorization() == "fullAccess" else { fail("Reminders access: \(authorization())") }
let arg = args.count > 1 ? args[1] : ""

do {
  switch cmd {
  case "complete", "reopen":
    let r = reminder(arg)
    r.isCompleted = cmd == "complete"
    try store.save(r, commit: true)
    emit(["ok": true, "completed": r.isCompleted])
  case "delete":
    try store.remove(reminder(arg), commit: true)
    emit(["ok": true])
  case "delete-list":
    guard let c = store.calendar(withIdentifier: arg), c.title.hasPrefix(prefix) else {
      fail("no \(prefix)list \(arg)")
    }
    try store.removeCalendar(c, commit: true)
    emit(["ok": true])
  case "cleanup":
    var removed: [String] = []
    for c in store.calendars(for: .reminder) where c.title.hasPrefix(prefix) {
      try store.removeCalendar(c, commit: true)
      removed.append(c.title)
    }
    emit(["ok": true, "removed": removed])
  default:
    fail("unknown command \(cmd)")
  }
} catch {
  fail("\(cmd): \(error.localizedDescription)")
}
