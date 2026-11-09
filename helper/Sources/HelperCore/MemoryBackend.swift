import Foundation

/// In-memory Reminders store with EventKit-like behaviour where it matters to the bridge:
/// ids, revisions (`rev`), change notifications on own writes, transient -3002 failures,
/// and "the person edits in Reminders" through `debug.*` hooks.
/// Used by `--backend memory` (CI, contract tests) and by HelperCore tests.
public final class MemoryBackend: Backend {
    public let name = "memory"
    public let cas = "strong"
    public var onChange: (() -> Void)?
    public private(set) var authorization: Authorization

    private var listsById: [String: ListInfo] = [:]
    private var listOrder: [String] = []
    private var itemsById: [String: ItemState] = [:]
    private var lastStampMs: Int64 = 0
    private var transientFailures: [String: Int] = [:]   // "create"|"update"|"restoreUrl"|"marker"|"any" -> count
    private let retry: RetryPolicy
    private let zone: TimeZone
    private let clock: () -> Date
    private let notifyQueue = DispatchQueue(label: "memory.notify")
    private var counter = 0

    public init(authorization: Authorization = .fullAccess, retry: RetryPolicy = .standard,
                zone: TimeZone = .current, seedDefaultList: Bool = true, clock: @escaping () -> Date = Date.init) {
        self.authorization = authorization
        self.clock = clock
        self.retry = retry
        self.zone = zone
        if seedDefaultList { addList(title: "Reminders", isDefault: true) }
    }

    // MARK: helpers

    private func nextId(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)-\(counter)-\(UUID().uuidString.prefix(8))"
    }

    /// Strictly increasing revisions at millisecond resolution (the resolution of `rev`). Whole
    /// milliseconds plus half a millisecond, so formatting never rounds two revisions together.
    private func stamp() -> Date {
        let nowMs = Int64((clock().timeIntervalSince1970 * 1000).rounded(.down))
        lastStampMs = max(nowMs, lastStampMs + 1)
        return Date(timeIntervalSince1970: (Double(lastStampMs) + 0.5) / 1000)
    }

    private func notify() {
        let cb = onChange
        notifyQueue.asyncAfter(deadline: .now() + 0.01) { cb?() }
    }

    @discardableResult
    private func addList(title: String, isDefault: Bool = false, readOnly: Bool = false) -> ListInfo {
        let l = ListInfo(id: nextId("L"), title: title, sourceTitle: "Memory", sourceType: "local",
                         allowsContentModifications: !readOnly, isDefault: isDefault)
        listsById[l.id] = l
        listOrder.append(l.id)
        return l
    }

    private func maybeFail(_ op: String) throws {
        for key in [op, "any"] {
            if let n = transientFailures[key], n > 0 {
                transientFailures[key] = n - 1
                throw NSError(domain: "com.apple.reminderkit", code: -3002,
                              userInfo: [NSLocalizedDescriptionKey: "simulated database conflict"])
            }
        }
    }

    private func resolve(_ ref: ItemRef) throws -> ItemState {
        if let id = ref.id, let it = itemsById[id] { return it }
        if let ext = ref.externalId {
            let hits = itemsById.values.filter { $0.externalId == ext }
            if hits.count == 1 { return hits[0] }
            if hits.count > 1 {
                throw HelperError(.ambiguous, "externalId matches \(hits.count) reminders", ["items": .array(sorted(hits).map(\.json))])
            }
        }
        throw HelperError(.notFound, "no reminder for ref", ["ref": ref.json])
    }

    private func sorted(_ xs: [ItemState]) -> [ItemState] {
        xs.sorted { ($0.lastModified ?? .distantPast, $0.id) < ($1.lastModified ?? .distantPast, $1.id) }
    }

    private func store(_ item: ItemState) -> ItemState {
        var it = item
        it.lastModified = stamp()
        itemsById[it.id] = it
        return it
    }

    // MARK: Backend

    public func requestAccess(timeout: TimeInterval) throws -> (granted: Bool, api: String) {
        if authorization == .notDetermined { authorization = .fullAccess; notify() }
        return (authorization == .fullAccess, "memory")
    }

    public func lists() throws -> [ListInfo] { listOrder.compactMap { listsById[$0] } }

    public func list(id: String) throws -> ListInfo {
        guard let l = listsById[id] else { throw HelperError(.listNotFound, "no reminder list \(id)", ["list": .string(id)]) }
        return l
    }

    public func createList(title: String) throws -> ListInfo {
        if try lists().contains(where: { $0.title == title }) {
            throw HelperError(.listExists, "a reminder list titled \"\(title)\" already exists", ["title": .string(title)])
        }
        let l = addList(title: title)
        notify()
        return l
    }

    public func snapshot(list: String) throws -> [ItemState] {
        _ = try self.list(id: list)
        return sorted(itemsById.values.filter { $0.listId == list })
    }

    public func find(_ query: FindQuery, lists: [String]?) throws -> [ItemState] {
        if let ls = lists { for l in ls { _ = try list(id: l) } }
        let scope = lists.map(Set.init)
        return sorted(itemsById.values.filter { it in
            if let s = scope, !s.contains(it.listId) { return false }
            switch query {
            case .url(let u): return it.linkUrl == u
            case .urlPrefix(let p): return it.linkUrl?.hasPrefix(p) ?? false
            case .externalId(let e): return it.externalId == e
            case .id(let i): return it.id == i
            }
        })
    }

    public func get(_ ref: ItemRef) throws -> ItemState { try resolve(ref) }

    public func create(list: String, linkUrl: String, set: WritableSet,
                       writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let l = try self.list(id: list)
        try writeGuard(l)
        if let it = try find(.url(linkUrl), lists: [list]).first {
            return WriteResult(item: it, written: ["linkUrl": .string(linkUrl), "title": .string(it.title)], existing: true)
        }
        let (item, retries) = try retry.run(isTransient: isReminderKitConflict, reset: {}) { () -> ItemState in
            try maybeFail("create")
            var blank = ItemState(id: nextId("R"), externalId: nextId("X"), listId: list, title: "")
            blank.linkUrl = linkUrl
            return store(try FieldApplier.apply(set, to: blank, now: Date(), zone: zone).item)
        }
        notify()
        var written = FieldApplier.written(set, item)
        if case .object(var o) = written { o["linkUrl"] = .string(linkUrl); written = .object(o) }
        return WriteResult(item: item, written: written, retries: retries)
    }

    public func update(_ ref: ItemRef, set: WritableSet, expect: String,
                       writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let ((item, warnings), retries) = try retry.run(isTransient: isReminderKitConflict, reset: {}) { () -> (ItemState, [String]) in
            let cur = try resolve(ref)               // "refresh": always the current state
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(try list(id: cur.listId))
            try maybeFail("update")
            let out = try FieldApplier.apply(set, to: cur, now: Date(), zone: zone)
            if out.item.due == nil && out.item.hasRecurrence {
                // Same rule as EventKit (EKErrorRecurringReminderRequiresDueDate = 14).
                throw HelperError(.eventkitError, "a recurring reminder requires a due date",
                                  ["native": [["domain": "EKErrorDomain", "code": 14, "description": "simulated"]]])
            }
            return (store(out.item), out.warnings)
        }
        notify()
        return WriteResult(item: item, written: FieldApplier.written(set, item), warnings: warnings, retries: retries)
    }

    public func restoreUrl(_ ref: ItemRef, linkUrl: String, expect: String,
                           writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let (item, retries) = try retry.run(isTransient: isReminderKitConflict, reset: {}) { () -> ItemState in
            let cur = try resolve(ref)
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(try list(id: cur.listId))
            guard let changed = try FieldApplier.restoreUrl(cur, linkUrl) else { return cur }
            try maybeFail("restoreUrl")
            return store(changed)
        }
        notify()
        return WriteResult(item: item, written: ["linkUrl": .string(linkUrl)], retries: retries)
    }

    public func createMarker(list: String, markerUrl: String,
                             writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let l = try self.list(id: list)
        try writeGuard(l)
        if let it = try find(.url(markerUrl), lists: [list]).first {
            return WriteResult(item: it, written: ["linkUrl": .string(markerUrl)], existing: true)
        }
        let (item, retries) = try retry.run(isTransient: isReminderKitConflict, reset: {}) { () -> ItemState in
            try maybeFail("marker")
            var it = ItemState(id: nextId("R"), externalId: nextId("X"), listId: list, title: Marker.title)
            it.linkUrl = markerUrl
            it.completed = true
            it.completionDate = Date()
            return store(it)
        }
        notify()
        return WriteResult(item: item, written: ["linkUrl": .string(markerUrl), "title": .string(Marker.title)], retries: retries)
    }

    public func retireMarker(_ ref: ItemRef, markerUrl: String, expect: String,
                             writeGuard: (ListInfo) throws -> Void) throws -> Int {
        let (_, retries) = try retry.run(isTransient: isReminderKitConflict, reset: {}) { () -> Void in
            let cur = try resolve(ref)
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(try list(id: cur.listId))
            guard cur.linkUrl == markerUrl, markerUrl.hasPrefix(Links.marker) else {
                throw HelperError(.forbiddenList, "only the exact bridge marker can be retired", ["ref": ref.json])
            }
            try maybeFail("marker")
            itemsById[cur.id] = nil
        }
        notify()
        return retries
    }

    // MARK: Debug hooks (memory only)

    public func debug(_ name: String, _ body: [String: JSON]) throws -> JSON {
        switch name {
        case "setAuthorization":
            guard let s = body["authorization"]?.stringValue, let a = Authorization(rawValue: s) else {
                throw invalid("authorization must be one of notDetermined, restricted, denied, fullAccess, writeOnly")
            }
            authorization = a
            notify()
            return ["authorization": .string(a.rawValue)]

        case "failNext":
            let op = body["target"]?.stringValue ?? "any"   // "op" is the request's own name
            let n = body["transient"]?.intValue ?? 1
            transientFailures[op] = n
            return ["target": .string(op), "transient": .int(n)]

        case "addList":
            // A list outside the bridge's allowlist (a "real" list), optionally read-only.
            let title = try Request.string(body, "title")
            let l = addList(title: title, readOnly: body["readOnly"]?.boolValue ?? false)
            notify()
            return ["list": l.json]

        case "deleteList":
            let id = try Request.string(body, "list")
            _ = try list(id: id)
            listsById[id] = nil
            listOrder.removeAll { $0 == id }
            itemsById = itemsById.filter { $0.value.listId != id }
            notify()
            return ["deleted": .string(id)]

        case "userCreate":
            // A reminder the person adds in Reminders (no bridge link, any list).
            let l = try list(id: try Request.string(body, "list"))
            var it = ItemState(id: nextId("R"), externalId: nextId("X"), listId: l.id, title: try Request.string(body, "title"))
            if let u = body["url"]?.stringValue { it.linkUrl = u }
            it = store(it)
            notify()
            return ["item": it.json]

        case "userEdit":
            // An edit made in Reminders by the person: anything, including personal fields.
            var it = try resolve(try ItemRef.parse(body["ref"]))
            if let t = body["title"]?.stringValue { it.title = t }
            if let c = body["completed"]?.boolValue { it.completed = c; it.completionDate = c ? Date() : nil }
            if let p = body["priority"]?.intValue { it.priority = p }
            if let d = body["dueDate"] {
                if d.isNull { it.due = nil } else if let ld = d.stringValue.flatMap(LocalDate.init) {
                    it.due = Due(date: ld, time: it.due?.time, timeZone: it.due?.timeZone)
                }
            }
            if let t = body["dueTime"] {
                if t.isNull {
                    it.due?.time = nil; it.due?.timeZone = nil
                } else {
                    let hm = (t.stringValue ?? "").split(separator: ":").compactMap { Int($0) }
                    guard hm.count == 2, let tod = TimeOfDay(hour: hm[0], minute: hm[1]), it.due != nil else {
                        throw invalid("dueTime needs HH:MM and an existing due date")
                    }
                    it.due!.time = tod
                    it.due!.timeZone = body["tz"]?.isNull == true ? nil : (body["tz"]?.stringValue ?? zone.identifier)
                }
            }
            if body["clearAlarms"]?.boolValue == true { it.alarms = [] }
            if let a = body["addAlarmAt"]?.stringValue {
                guard let d = Timestamps.parse(a) else { throw invalid("addAlarmAt must be ISO 8601") }
                it.alarms.append(Alarm(kind: .absolute(d), slot: it.alarms.count))
            }
            if let s = body["addRelativeAlarmSec"]?.numberValue {
                it.alarms.append(Alarm(kind: .relative(seconds: s), slot: it.alarms.count))
            }
            if body["addLocationAlarm"]?.boolValue == true {
                it.alarms.append(Alarm(kind: .location(title: "Office", proximity: "enter"), slot: it.alarms.count))
            }
            if let r = body["recurrence"]?.boolValue { it.hasRecurrence = r }
            if let n = body["notes"]?.boolValue { it.hasNotes = n }
            if body.keys.contains("url") { it.linkUrl = body["url"]?.stringValue }
            if let l = body["moveToList"]?.stringValue { _ = try list(id: l); it.listId = l }
            if body["delete"]?.boolValue == true {
                itemsById[it.id] = nil
                notify()
                return ["deleted": .string(it.id)]
            }
            if body["changeId"]?.boolValue == true {
                // calendarItemIdentifier churn (obssync): same reminder, new local id.
                itemsById[it.id] = nil
                it.id = nextId("R")
            }
            it = store(it)
            notify()
            return ["item": it.json]

        case "dump":
            return ["lists": .array(try lists().map(\.json)), "items": .array(sorted(Array(itemsById.values)).map(\.json))]

        default:
            throw invalid("unknown debug op \(name)")
        }
    }
}
