import Foundation

/// Pure field application shared by every backend: the backend snapshots its native object
/// into `ItemState`, applies the set here, then writes back only what changed.
/// Rules (D-010 r4 §4.5): B2 (time of day is personal), B12 (no clearing over personal data),
/// B15 (the bridge never moves or removes alarms).
public enum FieldApplier {
    public struct Outcome: Equatable {
        public var item: ItemState
        /// Non-fatal notes for the host's journal, e.g. "alarm_on_old_date".
        public var warnings: [String]
    }

    public static func apply(_ set: WritableSet, to item: ItemState, now: Date, zone: TimeZone) throws -> Outcome {
        var r = item
        var warnings: [String] = []
        if let t = set.title { r.title = t }
        if let p = set.priority { r.priority = p }
        if let c = set.completed {
            if c.value {
                r.completed = true
                let today = LocalDate.today(in: zone)
                if let d = c.date, d != today {
                    r.completionDate = noon(of: d, in: zone)
                } else if c.date != nil {
                    // An explicit "today" replaces an older completion date (done(cd1) → done(today)).
                    if r.completionDate.flatMap({ localDate(of: $0, in: zone) }) != today { r.completionDate = now }
                } else if !item.completed || r.completionDate == nil {
                    r.completionDate = now
                }
            } else {
                r.completed = false
                r.completionDate = nil
            }
        }
        if let d = set.dueDate { try applyDueDate(d, to: &r, zone: zone, warnings: &warnings) }
        return Outcome(item: r, warnings: warnings)
    }

    static func applyDueDate(_ op: WritableSet.DueDateOp, to r: inout ItemState, zone: TimeZone,
                             warnings: inout [String]) throws {
        switch op {
        case .clear:
            guard let due = r.due else { return }
            // B12: removing the date would destroy the person's time of day and alarms.
            if due.time != nil || !r.alarms.isEmpty {
                throw HelperError(.personalConflict, "due has a time of day or alarms; clearing it would remove personal data",
                                  ["hasTime": .bool(due.time != nil), "alarms": .int(r.alarms.count)])
            }
            r.due = nil
        case .set(let date):
            guard var due = r.due else {
                r.due = Due(date: date)            // date-only: no time, no zone, no alarm
                return
            }
            let oldDate = due.date
            if oldDate == date { return }
            due.date = date                        // keep time of day and zone (B2); alarms stay (B15)
            r.due = due
            let dayZone = due.timeZone.flatMap(TimeZone.init(identifier:))
                ?? r.timeZone.flatMap(TimeZone.init(identifier:)) ?? zone
            let onOldDay = r.alarms.contains { a in
                if case .absolute(let at) = a.kind { return localDate(of: at, in: dayZone) == oldDate }
                return false
            }
            if onOldDay { warnings.append("alarm_on_old_date") }
        }
    }

    /// The stored values of exactly the fields `set` wrote (D-010 r4 §4.2 `written`).
    public static func written(_ set: WritableSet, _ item: ItemState) -> JSON {
        var o: [String: JSON] = [:]
        if set.title != nil { o["title"] = .string(item.title) }
        if set.priority != nil { o["priority"] = .int(item.priority) }
        if set.completed != nil {
            var c: [String: JSON] = ["value": .bool(item.completed)]
            if let d = item.completionDate { c["completionDate"] = .string(Timestamps.format(d)) }
            o["completed"] = .object(c)
        }
        if set.dueDate != nil { o["dueDate"] = item.due.map { .string($0.date.description) } ?? .null }
        return .object(o)
    }

    static func localDate(of d: Date, in zone: TimeZone) -> LocalDate? {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = zone
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return LocalDate(year: c.year!, month: c.month!, day: c.day!)
    }

    static func noon(of d: LocalDate, in zone: TimeZone) -> Date {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = zone
        return cal.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: 12))!
    }

    /// Optimistic check: the reminder must still be what the bridge based its plan on.
    public static func checkExpect(_ current: ItemState, _ expect: String) throws {
        guard current.rev == expect else {
            throw HelperError(.conflictChanged, "reminder changed since the bridge read it",
                              ["fresh": current.json, "expected": .string(expect)])
        }
    }

    /// The bridge's link may be restored only where it is missing; a URL the person set is kept.
    public static func restoreUrl(_ item: ItemState, _ url: String) throws -> ItemState? {
        if item.linkUrl == url { return nil }   // nothing to do
        if let cur = item.linkUrl, !cur.isEmpty {
            throw HelperError(.personalConflict, "the reminder has another URL; not overwriting it", ["current": .string(cur)])
        }
        var r = item
        r.linkUrl = url
        return r
    }
}

/// Retry with pause + store reset between attempts (com.apple.reminderkit -3002, P11).
public struct RetryPolicy {
    public var delays: [TimeInterval]
    public var sleep: (TimeInterval) -> Void

    public static let standard = RetryPolicy(delays: [0.25, 0.5, 1.0, 2.0], sleep: { Thread.sleep(forTimeInterval: $0) })

    public init(delays: [TimeInterval], sleep: @escaping (TimeInterval) -> Void) { self.delays = delays; self.sleep = sleep }

    /// `body` must redo the whole operation (re-fetch, re-check expect, re-apply).
    /// Returns the value and the number of retries made.
    public func run<T>(isTransient: (Error) -> Bool, reset: () -> Void, _ body: () throws -> T) throws -> (T, Int) {
        var attempt = 0
        while true {
            do {
                return (try body(), attempt)
            } catch {
                if error is HelperError || !isTransient(error) { throw error }
                guard attempt < delays.count else {
                    // The last refused attempt is reverted too, like every one before it.
                    reset()
                    throw HelperError(.storeConflict, "Reminders database stayed busy (reminderkit -3002) after \(attempt) retries",
                                      ["retries": .int(attempt), "native": nativeJSON(error)])
                }
                sleep(delays[attempt])
                reset()
                attempt += 1
            }
        }
    }
}

/// Domain/code/description of an NSError and its underlying chain.
public func nativeJSON(_ error: Error) -> JSON {
    var chain: [JSON] = []
    var cur: NSError? = error as NSError
    while let e = cur, chain.count < 6 {
        chain.append(["domain": .string(e.domain), "code": .int(e.code), "description": .string(e.localizedDescription)])
        cur = e.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return .array(chain)
}

public func isReminderKitConflict(_ error: Error) -> Bool {
    var cur: NSError? = error as NSError
    var depth = 0
    while let e = cur, depth < 6 {
        if e.domain == "com.apple.reminderkit" && e.code == -3002 { return true }
        cur = e.userInfo[NSUnderlyingErrorKey] as? NSError
        depth += 1
    }
    return false
}
