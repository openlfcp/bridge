import EventKit
import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

/// The EventKit backend (D-010 r4 §8). Every write: resolve → refresh() → expect.rev → write guard →
/// FieldApplier on a snapshot → write back only changed fields → save, with the -3002 retry around the
/// whole body. Alarms are never written (B15); notes, time of day and zone are never written (B2).
/// Called on the server's serial queue, never on the main thread.
final class EventKitBackend: Backend {
    let name = "eventkit"
    let cas = "best-effort"
    let requiresWriteGate = true
    var onChange: (() -> Void)?

    private(set) var store = EKEventStore()
    private let retry: RetryPolicy
    private let zone = TimeZone.current
    private var observer: NSObjectProtocol?
    private static let gregorian = Calendar(identifier: .gregorian)

    init(retry: RetryPolicy = .standard) {
        self.retry = retry
        // object: nil — the store is replaced after access is granted.
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: nil) { [weak self] _ in
            self?.onChange?()
        }
    }

    deinit { if let o = observer { NotificationCenter.default.removeObserver(o) } }

    // MARK: Access

    var authorization: Authorization { Authorization(raw: EKEventStore.authorizationStatus(for: .reminder).rawValue) }

    func requestAccess(timeout: TimeInterval) throws -> (granted: Bool, api: String) {
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        var api = ""
        let done: (Bool, Error?) -> Void = { g, _ in granted = g; sem.signal() }
        #if compiler(>=5.9)
        if #available(macOS 14.0, *) {
            api = "requestFullAccessToReminders"
            store.requestFullAccessToReminders(completion: done)
        } else {
            api = "requestAccess(to: .reminder)"
            store.requestAccess(to: .reminder, completion: done)
        }
        #else
        // Built with an SDK older than macOS 14: call the macOS 14 API by selector when present.
        let sel = NSSelectorFromString("requestFullAccessToRemindersWithCompletion:")
        if store.responds(to: sel) {
            api = "requestFullAccessToReminders (selector)"
            typealias Block = @convention(block) (Bool, Error?) -> Void
            let block: Block = { g, e in done(g, e) }
            _ = store.perform(sel, with: unsafeBitCast(block, to: AnyObject.self))
        } else {
            api = "requestAccess(to: .reminder)"
            store.requestAccess(to: .reminder, completion: done)
        }
        #endif
        guard sem.wait(timeout: .now() + timeout) == .success else {
            throw HelperError(.tccTimeout, "no answer to the access prompt within \(Int(timeout)) s", ["api": .string(api)])
        }
        if granted { store = EKEventStore() }   // a fresh store sees the new access
        return (granted, api)
    }

    // MARK: Mapping

    private func sourceType(_ t: EKSourceType) -> String {
        switch t {
        case .local: return "local"
        case .exchange: return "exchange"
        case .calDAV: return "calDAV"
        case .mobileMe: return "mobileMe"
        case .subscribed: return "subscribed"
        case .birthdays: return "birthdays"
        @unknown default: return "unknown"
        }
    }

    private func info(_ c: EKCalendar) -> ListInfo {
        ListInfo(id: c.calendarIdentifier, title: c.title, sourceTitle: c.source?.title ?? "",
                 sourceType: c.source.map { sourceType($0.sourceType) } ?? "",
                 allowsContentModifications: c.allowsContentModifications,
                 isDefault: c.calendarIdentifier == store.defaultCalendarForNewReminders()?.calendarIdentifier)
    }

    private func state(_ r: EKReminder) -> ItemState {
        var due: Due?
        if let c = r.dueDateComponents, let y = c.year, let m = c.month, let d = c.day, let date = LocalDate(year: y, month: m, day: d) {
            let time = c.hour.flatMap { TimeOfDay(hour: $0, minute: c.minute ?? 0) }
            due = Due(date: date, time: time, timeZone: c.timeZone?.identifier)
        }
        let alarms: [Alarm] = (r.alarms ?? []).enumerated().map { i, a in
            if let loc = a.structuredLocation {
                let prox: String
                switch a.proximity {
                case .enter: prox = "enter"
                case .leave: prox = "leave"
                default: prox = "none"
                }
                return Alarm(kind: .location(title: loc.title, proximity: prox), slot: i)
            }
            if let abs = a.absoluteDate { return Alarm(kind: .absolute(abs), slot: i) }
            return Alarm(kind: .relative(seconds: a.relativeOffset), slot: i)
        }
        return ItemState(id: r.calendarItemIdentifier, externalId: r.calendarItemExternalIdentifier,
                         listId: r.calendar?.calendarIdentifier ?? "", linkUrl: r.url?.absoluteString, title: r.title ?? "",
                         completed: r.isCompleted, completionDate: r.completionDate, priority: r.priority, due: due,
                         timeZone: r.timeZone?.identifier, hasRecurrence: r.hasRecurrenceRules, alarms: alarms,
                         hasNotes: !(r.notes ?? "").isEmpty, lastModified: r.lastModifiedDate)
    }

    /// Writes back only what FieldApplier changed. Alarms, notes, time of day and zone are never written.
    private func writeBack(_ new: ItemState, old: ItemState, to r: EKReminder) throws {
        guard new.alarms == old.alarms, new.hasNotes == old.hasNotes else {
            throw HelperError(.internalError, "refusing to change personal data (alarms or notes)")
        }
        if new.title != old.title { r.title = new.title }
        if new.priority != old.priority { r.priority = new.priority }
        if new.linkUrl != old.linkUrl { r.url = new.linkUrl.flatMap(URL.init(string:)) }
        if new.completed != old.completed { r.isCompleted = new.completed }
        if new.completionDate != old.completionDate, new.completed { r.completionDate = new.completionDate }
        if new.due != old.due {
            guard let d = new.due else {
                r.dueDateComponents = nil
                return
            }
            guard d.time == old.due?.time, d.timeZone == old.due?.timeZone || old.due == nil else {
                throw HelperError(.internalError, "refusing to change the time of day or zone of a due")
            }
            var c = r.dueDateComponents ?? DateComponents()
            if c.calendar == nil { c.calendar = EventKitBackend.gregorian }
            c.year = d.date.year; c.month = d.date.month; c.day = d.date.day
            r.dueDateComponents = c
        }
    }

    // MARK: Lookup

    private func calendar(_ id: String) throws -> EKCalendar {
        guard let c = store.calendar(withIdentifier: id), c.allowedEntityTypes.contains(.reminder) else {
            throw HelperError(.listNotFound, "no reminder list \(id)", ["list": .string(id)])
        }
        return c
    }

    private func reminder(_ ref: ItemRef) throws -> EKReminder {
        if let id = ref.id, let r = store.calendarItem(withIdentifier: id) as? EKReminder { return r }
        if let ext = ref.externalId {
            let hits = store.calendarItems(withExternalIdentifier: ext).compactMap { $0 as? EKReminder }
            if hits.count == 1 { return hits[0] }
            if hits.count > 1 {
                throw HelperError(.ambiguous, "externalId matches \(hits.count) reminders", ["items": .array(hits.map { state($0).json })])
            }
        }
        throw HelperError(.notFound, "no reminder for ref", ["ref": ["id": .str(ref.id), "externalId": .str(ref.externalId)]])
    }

    /// The current state of a reminder: refresh() false means it is gone.
    private func fresh(_ ref: ItemRef) throws -> EKReminder {
        let r = try reminder(ref)
        guard r.refresh() else { throw HelperError(.notFound, "the reminder was deleted", ["ref": ["id": .str(ref.id)]]) }
        return r
    }

    private func fetch(_ cals: [EKCalendar]?) throws -> [EKReminder] {
        let sem = DispatchSemaphore(value: 0)
        var out: [EKReminder] = []
        store.fetchReminders(matching: store.predicateForReminders(in: cals)) { r in out = r ?? []; sem.signal() }
        guard sem.wait(timeout: .now() + 60) == .success else { throw HelperError(.timeout, "fetchReminders did not answer in 60 s") }
        return out
    }

    /// Runs a write with the -3002 retry; maps EventKit errors to protocol codes.
    private func write<T>(_ body: () throws -> T) throws -> (T, Int) {
        do {
            return try retry.run(isTransient: isReminderKitConflict, reset: { self.store.reset() }, body)
        } catch let e as HelperError {
            throw e
        } catch {
            let ns = error as NSError
            let code: ErrorCode = ns.domain == EKErrorDomain ? .eventkitError : .internalError
            throw HelperError(code, ns.localizedDescription, ["native": nativeJSON(error)])
        }
    }

    // MARK: Backend reads

    func lists() throws -> [ListInfo] { store.calendars(for: .reminder).map(info) }

    func list(id: String) throws -> ListInfo { info(try calendar(id)) }

    func snapshot(list: String) throws -> [ItemState] { try fetch([try calendar(list)]).map(state) }

    func find(_ query: FindQuery, lists: [String]?) throws -> [ItemState] {
        let cals = try lists.map { try $0.map(calendar) }
        if case .id(let id) = query {
            guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else { return [] }
            if let c = cals, !c.contains(where: { $0.calendarIdentifier == r.calendar?.calendarIdentifier }) { return [] }
            return [state(r)]
        }
        return try fetch(cals).map(state).filter { it in
            switch query {
            case .url(let u): return it.linkUrl == u
            case .urlPrefix(let p): return it.linkUrl?.hasPrefix(p) ?? false
            case .externalId(let e): return it.externalId == e
            case .id(let i): return it.id == i
            }
        }
    }

    func get(_ ref: ItemRef) throws -> ItemState { state(try fresh(ref)) }

    // MARK: Backend writes

    func createList(title: String) throws -> ListInfo {
        // Every attempt re-checks the title: after -3002 and reset() the list may exist already.
        let (cal, _) = try write { () -> EKCalendar in
            if store.calendars(for: .reminder).contains(where: { $0.title == title }) {
                throw HelperError(.listExists, "a reminder list titled \"\(title)\" already exists", ["title": .string(title)])
            }
            let c = EKCalendar(for: .reminder, eventStore: store)
            c.title = title
            guard let src = store.defaultCalendarForNewReminders()?.source
                ?? store.sources.first(where: { $0.sourceType == .calDAV })
                ?? store.sources.first(where: { $0.sourceType == .local }) else {
                throw HelperError(.eventkitError, "no account to create a reminder list in")
            }
            c.source = src
            try store.saveCalendar(c, commit: true)
            return c
        }
        return info(cal)
    }

    /// The reminder with this url in the list, read fresh (inside a write attempt).
    private func existing(url: String, in cal: EKCalendar) throws -> EKReminder? {
        try fetch([cal]).first { $0.url?.absoluteString == url }
    }

    func create(list: String, linkUrl: String, set: WritableSet, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        // List, guard and the search for an existing record belong to every attempt: during the
        // pause after -3002 the list may be renamed out of scope or the record may appear.
        let ((item, existed), retries) = try write { () -> (ItemState, Bool) in
            let cal = try calendar(list)
            try writeGuard(info(cal))
            if let r = try existing(url: linkUrl, in: cal) { return (state(r), true) }
            let r = EKReminder(eventStore: store)
            r.calendar = cal
            let blank = ItemState(id: "", listId: list, title: "")
            var target = try FieldApplier.apply(set, to: blank, now: Date(), zone: zone).item
            target.linkUrl = linkUrl
            try writeBack(target, old: blank, to: r)
            try store.save(r, commit: true)
            return (state(r), false)
        }
        if existed {
            return WriteResult(item: item, written: ["linkUrl": .string(linkUrl), "title": .string(item.title)], existing: true,
                               retries: retries)
        }
        var written = FieldApplier.written(set, item)
        if case .object(var o) = written { o["linkUrl"] = .string(linkUrl); written = .object(o) }
        return WriteResult(item: item, written: written, retries: retries)
    }

    func update(_ ref: ItemRef, set: WritableSet, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let ((item, warnings), retries) = try write { () -> (ItemState, [String]) in
            let r = try fresh(ref)
            let cur = state(r)
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(info(try calendar(cur.listId)))
            let out = try FieldApplier.apply(set, to: cur, now: Date(), zone: zone)
            try writeBack(out.item, old: cur, to: r)
            try store.save(r, commit: true)
            return (state(r), out.warnings)
        }
        return WriteResult(item: item, written: FieldApplier.written(set, item), warnings: warnings, retries: retries)
    }

    func restoreUrl(_ ref: ItemRef, linkUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let (item, retries) = try write { () -> ItemState in
            let r = try fresh(ref)
            let cur = state(r)
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(info(try calendar(cur.listId)))
            guard let changed = try FieldApplier.restoreUrl(cur, linkUrl) else { return cur }
            try writeBack(changed, old: cur, to: r)
            try store.save(r, commit: true)
            return state(r)
        }
        return WriteResult(item: item, written: ["linkUrl": .string(linkUrl)], retries: retries)
    }

    func createMarker(list: String, markerUrl: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
        let ((item, existed), retries) = try write { () -> (ItemState, Bool) in
            let cal = try calendar(list)
            try writeGuard(info(cal))
            if let r = try existing(url: markerUrl, in: cal) { return (state(r), true) }
            let r = EKReminder(eventStore: store)
            r.calendar = cal
            r.title = Marker.title
            r.url = URL(string: markerUrl)
            r.isCompleted = true
            try store.save(r, commit: true)
            return (state(r), false)
        }
        if existed { return WriteResult(item: item, written: ["linkUrl": .string(markerUrl)], existing: true, retries: retries) }
        return WriteResult(item: item, written: ["linkUrl": .string(markerUrl), "title": .string(Marker.title)], retries: retries)
    }

    func retireMarker(_ ref: ItemRef, markerUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> Int {
        let (_, retries) = try write { () -> Void in
            let r = try fresh(ref)
            let cur = state(r)
            try FieldApplier.checkExpect(cur, expect)
            try writeGuard(info(try calendar(cur.listId)))
            guard cur.linkUrl == markerUrl, markerUrl.hasPrefix(Links.marker) else {
                throw HelperError(.forbiddenList, "only the exact bridge marker can be retired")
            }
            try store.remove(r, commit: true)
        }
        return retries
    }

    func debug(_ name: String, _ body: [String: JSON]) throws -> JSON {
        throw HelperError(.invalid, "debug ops exist only with --backend memory")
    }
}
