import Foundation

/// Calendar date without time or zone ("YYYY-MM-DD"), like LFCP `LocalDate`.
public struct LocalDate: Equatable, Comparable, CustomStringConvertible {
    public let year: Int, month: Int, day: Int

    public init?(_ text: String) {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init?(year: Int, month: Int, day: Int) {
        var c = DateComponents()
        c.year = year; c.month = month; c.day = day
        // Reject impossible dates (2026-02-30).
        let cal = Calendar.gregorianUTC
        guard (1...9999).contains(year), let date = cal.date(from: c),
              cal.component(.day, from: date) == day, cal.component(.month, from: date) == month else { return nil }
        self.year = year; self.month = month; self.day = day
    }

    public var description: String { String(format: "%04d-%02d-%02d", year, month, day) }
    public static func < (a: LocalDate, b: LocalDate) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }

    /// Whole days from `self` to `other`.
    public func days(to other: LocalDate) -> Int {
        let cal = Calendar.gregorianUTC
        let a = cal.date(from: DateComponents(year: year, month: month, day: day))!
        let b = cal.date(from: DateComponents(year: other.year, month: other.month, day: other.day))!
        return cal.dateComponents([.day], from: a, to: b).day ?? 0
    }

    public static func today(in tz: TimeZone) -> LocalDate {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let c = cal.dateComponents([.year, .month, .day], from: Date())
        return LocalDate(year: c.year!, month: c.month!, day: c.day!)!
    }
}

public struct TimeOfDay: Equatable {
    public let hour: Int, minute: Int
    public init?(hour: Int, minute: Int) {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        self.hour = hour; self.minute = minute
    }
    public var text: String { String(format: "%02d:%02d", hour, minute) }
}

/// Due of a reminder: the date (synced with LFCP) plus personal time of day and zone (B2).
public struct Due: Equatable {
    public var date: LocalDate
    public var time: TimeOfDay?
    /// IANA zone of the due components; nil = floating (date-only, or time without zone).
    public var timeZone: String?

    public init(date: LocalDate, time: TimeOfDay? = nil, timeZone: String? = nil) {
        self.date = date; self.time = time; self.timeZone = timeZone
    }

    /// The instant the due time denotes, if it has a time of day.
    public func instant(fallbackZone: TimeZone) -> Date? {
        guard let t = time else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone.flatMap(TimeZone.init(identifier:)) ?? fallbackZone
        return cal.date(from: DateComponents(year: date.year, month: date.month, day: date.day, hour: t.hour, minute: t.minute))
    }

    public var json: JSON {
        var o: [String: JSON] = ["date": .string(date.description)]
        o["time"] = time.map { .string($0.text) } ?? .null
        o["tz"] = .str(timeZone)
        return .object(o)
    }
}

/// An alarm as the helper reports and edits it. `slot` is its position in the backend's alarm list,
/// so a backend can map an edited value back to its native object.
public struct Alarm: Equatable {
    public enum Kind: Equatable {
        case absolute(Date)
        case relative(seconds: Double)
        case location(title: String?, proximity: String)
    }
    public var kind: Kind
    public let slot: Int

    public init(kind: Kind, slot: Int) { self.kind = kind; self.slot = slot }

    public var json: JSON {
        switch kind {
        case .absolute(let d): return ["kind": "absolute", "at": .string(Timestamps.format(d))]
        case .relative(let s): return ["kind": "relative", "relativeSec": .number(s)]
        case .location(let title, let prox): return ["kind": "location", "title": .str(title), "proximity": .string(prox)]
        }
    }
}

/// Snapshot of one reminder: everything the bridge reads, plus what it must not lose.
public struct ItemState: Equatable {
    public var id: String
    public var externalId: String?
    public var listId: String
    public var linkUrl: String?
    public var title: String
    public var completed: Bool
    public var completionDate: Date?
    public var priority: Int
    public var due: Due?
    /// Zone of the reminder itself (EKCalendarItem.timeZone), fallback for due instants.
    public var timeZone: String?
    public var hasRecurrence: Bool
    public var alarms: [Alarm]
    public var hasNotes: Bool
    public var lastModified: Date?

    public init(id: String, externalId: String? = nil, listId: String, linkUrl: String? = nil, title: String,
                completed: Bool = false, completionDate: Date? = nil, priority: Int = 0, due: Due? = nil,
                timeZone: String? = nil, hasRecurrence: Bool = false, alarms: [Alarm] = [], hasNotes: Bool = false,
                lastModified: Date? = nil) {
        self.id = id; self.externalId = externalId; self.listId = listId; self.linkUrl = linkUrl; self.title = title
        self.completed = completed; self.completionDate = completionDate; self.priority = priority; self.due = due
        self.timeZone = timeZone; self.hasRecurrence = hasRecurrence; self.alarms = alarms; self.hasNotes = hasNotes
        self.lastModified = lastModified
    }

    /// Opaque revision token (`rev`), compared with `expect.rev` for equality only.
    /// EventKit: lastModifiedDate with milliseconds; empty when the store has none.
    public var rev: String { lastModified.map(Timestamps.format) ?? "" }

    public var json: JSON {
        [
            "ref": ["id": .string(id), "externalId": .str(externalId)],
            "list": .string(listId),
            "linkUrl": .str(linkUrl),
            "title": .string(title),
            "completed": .bool(completed),
            "completionDate": completionDate.map { .string(Timestamps.format($0)) } ?? .null,
            "priority": .int(priority),
            "due": due?.json ?? .null,
            "alarms": .array(alarms.map(\.json)),
            "hasNotes": .bool(hasNotes),
            "hasRecurrence": .bool(hasRecurrence),
            "rev": .string(rev),
        ]
    }
}

public struct ListInfo: Equatable {
    public var id: String
    public var title: String
    public var sourceTitle: String
    public var sourceType: String
    public var allowsContentModifications: Bool
    public var isDefault: Bool

    public init(id: String, title: String, sourceTitle: String, sourceType: String,
                allowsContentModifications: Bool, isDefault: Bool) {
        self.id = id; self.title = title; self.sourceTitle = sourceTitle; self.sourceType = sourceType
        self.allowsContentModifications = allowsContentModifications; self.isDefault = isDefault
    }

    public var json: JSON {
        ["id": .string(id), "title": .string(title),
         "source": ["title": .string(sourceTitle), "type": .string(sourceType)],
         "allowsContentModifications": .bool(allowsContentModifications), "isDefault": .bool(isDefault)]
    }
}

/// EventKit authorization, by stable raw value (0…4) so that any SDK maps the same way.
public enum Authorization: String {
    case notDetermined, restricted, denied, fullAccess, writeOnly, unknown

    public init(raw: Int) {
        switch raw {
        case 0: self = .notDetermined
        case 1: self = .restricted
        case 2: self = .denied
        case 3: self = .fullAccess   // == legacy .authorized
        case 4: self = .writeOnly
        default: self = .unknown
        }
    }

    /// Error for anything but full access (the bridge must read).
    public var accessError: HelperError? {
        switch self {
        case .fullAccess: return nil
        case .notDetermined: return HelperError(.tccNotDetermined, "Reminders access not requested yet")
        case .restricted: return HelperError(.tccRestricted, "Reminders access restricted by policy")
        case .denied: return HelperError(.tccDenied, "Reminders access denied in System Settings > Privacy & Security > Reminders")
        case .writeOnly: return HelperError(.tccWriteOnly, "Only write access granted; full access is needed")
        case .unknown: return HelperError(.tccUnknown, "Unknown authorization status")
        }
    }
}

public enum Timestamps {
    static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    static let lock = NSLock()

    /// UTC with milliseconds: stable text for revisions and instants.
    public static func format(_ d: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return formatter.string(from: d)
    }

    public static func parse(_ s: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        if let d = formatter.date(from: s) { return d }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

extension Calendar {
    static let gregorianUTC: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
}
