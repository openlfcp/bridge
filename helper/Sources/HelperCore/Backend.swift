import Foundation

/// Result of a write: the item after it, the written fields, whether the record already existed.
public struct WriteResult {
    public var item: ItemState
    public var written: JSON
    public var existing: Bool
    public var warnings: [String]
    public var retries: Int

    public init(item: ItemState, written: JSON, existing: Bool = false, warnings: [String] = [], retries: Int = 0) {
        self.item = item; self.written = written; self.existing = existing; self.warnings = warnings; self.retries = retries
    }
}

/// Storage behind the protocol: EventKit in the app, memory for CI and contract tests.
/// Every method is called on the server's serial queue, never on the main thread.
/// The bridge never deletes reminders (B11) and never touches alarms (B15); only its own
/// markers can be retired.
public protocol Backend: AnyObject {
    var name: String { get }
    /// "strong" when the expect check and the write are one atomic step; "best-effort" otherwise (EventKit).
    var cas: String { get }
    var authorization: Authorization { get }
    /// Set by the server; called (on any thread) whenever the store may have changed,
    /// including after the backend's own writes (EventKit posts EKEventStoreChanged for them too).
    var onChange: (() -> Void)? { get set }

    func requestAccess(timeout: TimeInterval) throws -> (granted: Bool, api: String)
    func lists() throws -> [ListInfo]
    func list(id: String) throws -> ListInfo
    /// A new list; `list_exists` when a list with this title exists (never adopt by title).
    func createList(title: String) throws -> ListInfo
    /// Every reminder of the list, completed ones included (a complete snapshot).
    func snapshot(list: String) throws -> [ItemState]
    func find(_ query: FindQuery, lists: [String]?) throws -> [ItemState]
    func get(_ ref: ItemRef) throws -> ItemState
    /// Idempotent by `linkUrl` in the list: an existing record is returned (`existing`).
    func create(list: String, linkUrl: String, set: WritableSet, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult
    /// Must refresh the object, check `expect`, call `writeGuard` with the item's list, apply only `set`.
    func update(_ ref: ItemRef, set: WritableSet, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult
    func restoreUrl(_ ref: ItemRef, linkUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult
    /// A completed reminder with a fixed title and `markerUrl`; idempotent by url in the list.
    func createMarker(list: String, markerUrl: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult
    /// Removes only a record whose url is exactly `markerUrl`.
    func retireMarker(_ ref: ItemRef, markerUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> Int
    /// Test hooks; backends without them throw `invalid`.
    func debug(_ name: String, _ body: [String: JSON]) throws -> JSON
}

public enum Marker {
    public static let title = "LFCP bridge · не удалять"
}
