import Foundation

public enum HelperInfo {
    public static let protocolVersion = 2
    public static let version = "0.3.1"
}

/// Stable machine-readable error codes (D-010 r4 §8.1).
public enum ErrorCode: String {
    case invalid                     // malformed request, unknown op/field, bad value
    case unsupportedProtocol = "unsupported_protocol"
    case tccNotDetermined = "tcc_not_determined"
    case tccDenied = "tcc_denied"
    case tccRestricted = "tcc_restricted"
    case tccWriteOnly = "tcc_write_only"
    case tccUnknown = "tcc_unknown"
    case tccTimeout = "tcc_timeout"
    case notFound = "not_found"
    case listNotFound = "list_not_found"
    case listExists = "list_exists"               // lists.create: the title is taken (never adopt by title)
    case writesDisabled = "writes_disabled"       // EventKit writes not enabled by hello (D-010 r4 §7.6)
    case ambiguous                   // a ref matches several reminders
    case forbiddenList = "forbidden_list"
    case conflictChanged = "conflict_changed"     // expect.rev does not match
    case personalConflict = "personal_conflict"   // the write would touch personal data (B12, url)
    case storeConflict = "store_conflict"         // com.apple.reminderkit -3002 after retries
    case eventkitError = "eventkit_error"
    case timeout
    /// A store operation did not finish within the helper's deadline; for a write the outcome is
    /// unknown, so it is not retryable (R-001 live run 2: an EventKit fetch that never returned).
    case eventkitTimeout = "eventkit_timeout"
    case internalError = "internal"

    public var retryable: Bool {
        switch self {
        case .conflictChanged, .storeConflict, .timeout, .tccTimeout: return true
        default: return false
        }
    }
}

public struct HelperError: Error, Equatable {
    public let code: ErrorCode
    public let message: String
    public var extra: [String: JSON]

    public init(_ code: ErrorCode, _ message: String, _ extra: [String: JSON] = [:]) {
        self.code = code; self.message = message; self.extra = extra
    }

    public var json: JSON {
        var o = extra
        o["code"] = .string(code.rawValue)
        o["message"] = .string(message)
        o["retryable"] = .bool(code.retryable)
        return .object(o)
    }
}

func invalid(_ msg: String) -> HelperError { HelperError(.invalid, msg) }

// MARK: Request pieces

/// Reminder reference: `id` (calendarItemIdentifier, a cache) and/or `externalId`.
public struct ItemRef: Equatable {
    public var id: String?
    public var externalId: String?
    public init(id: String? = nil, externalId: String? = nil) { self.id = id; self.externalId = externalId }

    static func parse(_ j: JSON?) throws -> ItemRef {
        guard let o = j?.objectValue else { throw invalid("ref must be an object {id?, externalId?}") }
        let r = ItemRef(id: o["id"]?.stringValue, externalId: o["externalId"]?.stringValue)
        guard r.id != nil || r.externalId != nil else { throw invalid("ref needs id or externalId") }
        return r
    }

    var json: JSON { ["id": .str(id), "externalId": .str(externalId)] }
}

/// Fields the bridge may write (D-010 r4 §4.2). Personal data — notes, time of day, zone,
/// alarms, recurrence — is not writable; the bridge's own link is set only by create/restoreUrl.
/// A due date change keeps time, zone and alarms (B2, B15).
public struct WritableSet: Equatable {
    public enum DueDateOp: Equatable { case set(LocalDate), clear }

    public var title: String?
    public var completed: (value: Bool, date: LocalDate?)?
    public var dueDate: DueDateOp?
    public var priority: Int?

    public init() {}

    public static func == (a: WritableSet, b: WritableSet) -> Bool {
        a.title == b.title && a.completed?.value == b.completed?.value && a.completed?.date == b.completed?.date
            && a.dueDate == b.dueDate && a.priority == b.priority
    }

    public var isEmpty: Bool { title == nil && completed == nil && dueDate == nil && priority == nil }

    static let allowedKeys: Set<String> = ["title", "completed", "dueDate", "priority"]
    /// B13: the bridge writes priority buckets only (none, high, low).
    public static let allowedPriorities: Set<Int> = [0, 1, 9]

    static func parse(_ j: JSON?) throws -> WritableSet {
        guard let o = j?.objectValue else { throw invalid("set must be an object") }
        if let unknown = o.keys.sorted().first(where: { !allowedKeys.contains($0) }) {
            throw invalid("set.\(unknown) is not writable (allowed: \(allowedKeys.sorted().joined(separator: ", ")))")
        }
        var s = WritableSet()
        if let t = o["title"] {
            guard let v = t.stringValue, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw invalid("set.title must be a non-empty string")
            }
            s.title = v
        }
        if let c = o["completed"] {
            guard let v = c["value"]?.boolValue else { throw invalid("set.completed must be {value: bool, date?: YYYY-MM-DD}") }
            var date: LocalDate?
            if let d = c["date"], !d.isNull {
                guard let ds = d.stringValue, let ld = LocalDate(ds) else { throw invalid("set.completed.date must be YYYY-MM-DD") }
                guard v else { throw invalid("set.completed.date only with value true") }
                date = ld
            }
            s.completed = (v, date)
        }
        if let d = o["dueDate"] {
            if d.isNull { s.dueDate = .clear } else {
                guard let ds = d.stringValue, let ld = LocalDate(ds) else { throw invalid("set.dueDate must be YYYY-MM-DD or null") }
                s.dueDate = .set(ld)
            }
        }
        if let p = o["priority"] {
            guard let v = p.intValue, allowedPriorities.contains(v) else { throw invalid("set.priority must be 0, 1 or 9") }
            s.priority = v
        }
        return s
    }
}

public enum FindQuery: Equatable {
    case url(String), urlPrefix(String), externalId(String), id(String)
}

/// A parsed request. Unknown top-level keys are ignored (forward compatibility); unknown
/// keys inside `set` are rejected (a field the host believes written must not be dropped).
public enum Operation: Equatable {
    case hello(allowListIds: [String], allowListTitlePrefixes: [String], writes: WriteMode)
    case ping
    case shutdown
    case accessStatus
    case accessRequest(timeoutSec: Double)
    case listsList
    case listsCreate(title: String, opKey: String)
    case itemsSnapshot(list: String)
    case itemsGet(ItemRef)
    case itemsFind(FindQuery, lists: [String]?)
    case itemsCreate(list: String, linkUrl: String, opKey: String, set: WritableSet)
    case itemsUpdate(ItemRef, set: WritableSet, opKey: String, expect: String)
    case itemsRestoreUrl(ItemRef, linkUrl: String, opKey: String, expect: String)
    case markersCreate(list: String, markerUrl: String, opKey: String)
    case markersRetire(ItemRef, markerUrl: String, opKey: String, expect: String)
    case debug(name: String, body: [String: JSON])   // memory backend only
}

/// Write gate for backends that need it (EventKit, D-010 r4 §7.6). The host decides; the helper
/// enforces it as a second line of defence.
public enum WriteMode: String {
    /// No writes (default until hello says otherwise).
    case off
    /// Bootstrap of a binding (§6.5): only lists.create and the ownership markers, no reminder writes.
    case bootstrap
    /// Verification run: writes only to lists titled "LFCP Verify · …".
    case verification
    /// writesVerified is set on the host: writes to the allowed lists.
    case verified

    public static let verificationListPrefix = "LFCP Verify · "
}

/// URL prefixes the bridge owns (D-010 r4 §3).
public enum Links {
    public static let task = "lfcp://task/"
    public static let marker = "lfcp://bridge/"
}

public struct Request {
    public let id: JSON
    public let op: Operation

    public static func parse(_ j: JSON) throws -> Request {
        guard let o = j.objectValue else { throw invalid("request must be a JSON object") }
        let id = o["id"] ?? .null
        do {
            guard let v = o["v"]?.intValue else { throw invalid("missing protocol version \"v\"") }
            guard v == HelperInfo.protocolVersion else {
                throw HelperError(.unsupportedProtocol, "protocol \(v) not supported; helper speaks \(HelperInfo.protocolVersion)",
                                  ["supported": [.int(HelperInfo.protocolVersion)]])
            }
            guard let name = o["op"]?.stringValue else { throw invalid("missing op") }
            return Request(id: id, op: try parseOp(name, o))
        } catch var e as HelperError {
            e.extra["requestId"] = id
            throw e
        }
    }

    static func string(_ o: [String: JSON], _ k: String) throws -> String {
        guard let s = o[k]?.stringValue, !s.isEmpty else { throw invalid("\(k) must be a non-empty string") }
        return s
    }

    static func expectRev(_ o: [String: JSON]) throws -> String {
        guard let e = o["expect"]?["rev"]?.stringValue else {
            throw invalid("expect.rev is required (optimistic check against the bridge's base)")
        }
        return e
    }

    /// The bridge's own link to a Task: lfcp://task/… only.
    static func linkUrl(_ o: [String: JSON]) throws -> String {
        let v = try string(o, "linkUrl")
        guard v.hasPrefix(Links.task), URL(string: v) != nil else { throw invalid("linkUrl must be an lfcp://task/ URL") }
        return v
    }

    /// The bridge's ownership marker: lfcp://bridge/… only.
    static func markerUrl(_ o: [String: JSON]) throws -> String {
        let v = try string(o, "markerUrl")
        guard v.hasPrefix(Links.marker), URL(string: v) != nil else { throw invalid("markerUrl must be an lfcp://bridge/ URL") }
        return v
    }

    static func parseOp(_ name: String, _ o: [String: JSON]) throws -> Operation {
        switch name {
        case "hello":
            let ids = (o["allowListIds"]?.arrayValue ?? []).compactMap(\.stringValue)
            let prefixes = (o["allowListTitlePrefixes"]?.arrayValue ?? []).compactMap(\.stringValue).filter { !$0.isEmpty }
            var writes = WriteMode.off
            if let w = o["writes"] {
                guard let s = w.stringValue, let m = WriteMode(rawValue: s) else {
                    throw invalid("writes must be \"off\", \"bootstrap\", \"verification\" or \"verified\"")
                }
                writes = m
            }
            return .hello(allowListIds: ids, allowListTitlePrefixes: prefixes, writes: writes)
        case "ping": return .ping
        case "shutdown": return .shutdown
        case "access.status": return .accessStatus
        case "access.request":
            let t = o["timeoutSec"]?.numberValue ?? 300
            guard t > 0, t <= 3600 else { throw invalid("timeoutSec must be in (0, 3600]") }
            return .accessRequest(timeoutSec: t)
        case "lists.list": return .listsList
        case "lists.create":
            return .listsCreate(title: try string(o, "title"), opKey: try string(o, "opKey"))
        case "items.snapshot": return .itemsSnapshot(list: try string(o, "list"))
        case "items.get": return .itemsGet(try ItemRef.parse(o["ref"]))
        case "items.find":
            // "itemId", not "id": "id" is the request id.
            let keys = ["url", "urlPrefix", "externalId", "itemId"].filter { o[$0] != nil }
            guard keys.count == 1 else { throw invalid("items.find needs exactly one of url, urlPrefix, externalId, itemId") }
            let q: FindQuery
            switch keys[0] {
            case "url": q = .url(try string(o, "url"))
            case "urlPrefix": q = .urlPrefix(try string(o, "urlPrefix"))
            case "externalId": q = .externalId(try string(o, "externalId"))
            default: q = .id(try string(o, "itemId"))
            }
            var lists: [String]?
            if let l = o["lists"], !l.isNull {
                guard let arr = l.arrayValue, arr.allSatisfy({ $0.stringValue != nil }) else { throw invalid("lists must be an array of ids") }
                lists = arr.compactMap(\.stringValue)
            }
            return .itemsFind(q, lists: lists)
        case "items.create":
            let set = try WritableSet.parse(o["set"] ?? [:])
            guard set.title != nil else { throw invalid("items.create needs set.title") }
            return .itemsCreate(list: try string(o, "list"), linkUrl: try linkUrl(o), opKey: try string(o, "opKey"), set: set)
        case "items.update":
            let set = try WritableSet.parse(o["set"])
            guard !set.isEmpty else { throw invalid("items.update needs a non-empty set") }
            return .itemsUpdate(try ItemRef.parse(o["ref"]), set: set, opKey: try string(o, "opKey"), expect: try expectRev(o))
        case "items.restoreUrl":
            return .itemsRestoreUrl(try ItemRef.parse(o["ref"]), linkUrl: try linkUrl(o), opKey: try string(o, "opKey"),
                                    expect: try expectRev(o))
        case "markers.create":
            return .markersCreate(list: try string(o, "list"), markerUrl: try markerUrl(o), opKey: try string(o, "opKey"))
        case "markers.retire":
            return .markersRetire(try ItemRef.parse(o["ref"]), markerUrl: try markerUrl(o), opKey: try string(o, "opKey"),
                                  expect: try expectRev(o))
        default:
            if name.hasPrefix("debug.") { return .debug(name: String(name.dropFirst(6)), body: o) }
            throw invalid("unknown op \(name)")
        }
    }
}
