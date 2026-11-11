import Foundation

/// Protocol v2 dispatcher, IO-free: the executable feeds it lines and prints what it emits.
/// Requests are handled one at a time on `queue`; events may be emitted from any thread,
/// so `emit` must be thread-safe (the executable serializes stdout).
public final class Server {
    public let backend: Backend
    private let emit: (JSON) -> Void
    private let coalesce: TimeInterval
    private let eventQueue = DispatchQueue(label: "helper.events")
    public let queue = DispatchQueue(label: "helper.requests")
    /// How long one request may run (respond). A store call that never returns would otherwise
    /// hold `queue` for good (R-001 live run 2).
    public let opTimeout: TimeInterval
    /// Where respond runs a request; replaced when a request passes its deadline.
    private var worker = DispatchQueue(label: "helper.worker.0")
    private var workers = 0

    // Write allowlist (second line of defense, D-010 §8.1). Empty until `hello`.
    private var allowListIds: Set<String> = []
    private var allowTitlePrefixes: [String] = []
    private var writeMode: WriteMode = .off
    /// What the request being handled writes: reminders, or lists and markers (bootstrap).
    private var writeKind: WriteKind = .reminders
    private enum WriteKind { case reminders, bootstrap }

    private var changePending = false
    private var changeSeq = 0
    private var lastAuthorization: Authorization
    public private(set) var shutdownRequested = false

    public init(backend: Backend, coalesce: TimeInterval = 0.2, opTimeout: TimeInterval = 30,
                emit: @escaping (JSON) -> Void) {
        self.backend = backend
        self.coalesce = coalesce
        self.opTimeout = opTimeout
        self.emit = emit
        self.lastAuthorization = backend.authorization
        backend.onChange = { [weak self] in self?.noteChange() }
    }

    // MARK: Events

    public func readyEvent(process: [String: JSON]) -> JSON {
        var o: [String: JSON] = process
        o["event"] = "ready"
        o["protocol"] = .int(HelperInfo.protocolVersion)
        o["helperVersion"] = .string(HelperInfo.version)
        o["backend"] = .string(backend.name)
        o["cas"] = .string(backend.cas)
        o["authorization"] = .string(backend.authorization.rawValue)
        o["ts"] = .number(Server.nowMs())
        return .object(o)
    }

    /// Store changed: coalesce into one `changed` event per `coalesce` window; report access changes.
    public func noteChange() {
        eventQueue.async {
            let auth = self.backend.authorization
            if auth != self.lastAuthorization {
                self.lastAuthorization = auth
                self.emit(["event": "access_changed", "authorization": .string(auth.rawValue), "ts": .number(Server.nowMs())])
            }
            if self.changePending { return }
            self.changePending = true
            self.eventQueue.asyncAfter(deadline: .now() + self.coalesce) {
                self.changePending = false
                self.changeSeq += 1
                self.emit(["event": "changed", "seq": .int(self.changeSeq), "ts": .number(Server.nowMs())])
            }
        }
    }

    /// `wake` / `sleep` from the system (NSWorkspace in the app).
    public func systemEvent(_ name: String) {
        emit(["event": .string(name), "ts": .number(Server.nowMs())])
    }

    // MARK: Requests

    /// Handles one request line within `opTimeout` (call it on `queue`, one at a time). Past the
    /// deadline the answer is `eventkit_timeout` for that request, a `stalled` event tells the host
    /// (it restarts the helper and journals it), and the next request runs on a new worker after
    /// `backend.abandon()`. The stuck call is left to finish or not; nothing it returns is sent.
    public func respond(line: String) -> JSON {
        let t0 = Date()
        let done = DispatchSemaphore(value: 0)
        let box = Box()
        worker.async {
            box.value = self.handle(line: line)
            done.signal()
        }
        if done.wait(timeout: .now() + opTimeout) == .success, let r = box.value { return r }
        let request = (try? JSON.parse(line))?.objectValue
        let op = request?["op"]?.stringValue ?? "?"
        workers += 1
        worker = DispatchQueue(label: "helper.worker.\(workers)")
        backend.abandon()
        emit(["event": "stalled", "op": .string(op), "timeoutS": .number(opTimeout), "ts": .number(Server.nowMs())])
        let error = HelperError(.eventkitTimeout,
                                "\(op) did not finish within \(Int(opTimeout.rounded(.up))) s; its outcome is unknown",
                                ["op": .string(op)])
        return ["id": request?["id"] ?? .null, "ok": false, "error": error.json,
                "ms": .int(Int(Date().timeIntervalSince(t0) * 1000))]
    }

    private final class Box { var value: JSON? }

    /// Handles one request line and returns the response (one JSON object).
    public func handle(line: String) -> JSON {
        let t0 = Date()
        var id: JSON = .null
        var body: [String: JSON]
        do {
            let parsed: JSON
            do { parsed = try JSON.parse(line) } catch { throw invalid("request is not valid JSON") }
            if let o = parsed.objectValue { id = o["id"] ?? .null }
            let req = try Request.parse(parsed)
            body = try perform(req.op)
            body["ok"] = true
        } catch let e as HelperError {
            if let rid = e.extra["requestId"] { id = rid }
            var clean = e
            clean.extra["requestId"] = nil
            body = ["ok": false, "error": clean.json]
        } catch {
            body = ["ok": false, "error": HelperError(.internalError, error.localizedDescription, ["native": nativeJSON(error)]).json]
        }
        body["id"] = id
        body["ms"] = .int(Int(Date().timeIntervalSince(t0) * 1000))
        return .object(body)
    }

    private func requireAccess() throws {
        if let e = backend.authorization.accessError {
            var err = e
            err.extra["authorization"] = .string(backend.authorization.rawValue)
            throw err
        }
    }

    private func isAllowed(_ list: ListInfo) -> Bool {
        allowListIds.contains(list.id) || allowTitlePrefixes.contains { list.title.hasPrefix($0) }
    }

    /// Before any write: the gate (EventKit) and, in verification, the dedicated test lists only.
    private func requireWrites(title: String? = nil) throws {
        guard backend.requiresWriteGate else { return }
        switch writeMode {
        case .off:
            throw HelperError(.writesDisabled, "writes are disabled until the host enables them (hello writes)")
        case .bootstrap:
            if writeKind != .bootstrap {
                throw HelperError(.writesDisabled, "bootstrap mode writes only lists and ownership markers")
            }
        case .verification:
            if let t = title, !t.hasPrefix(WriteMode.verificationListPrefix) {
                throw HelperError(.forbiddenList, "verification writes only go to \"\(WriteMode.verificationListPrefix)…\" lists")
            }
        case .verified:
            break
        }
    }

    private func writeGuard(_ list: ListInfo) throws {
        try requireWrites(title: list.title)
        guard isAllowed(list) else {
            throw HelperError(.forbiddenList, "list \"\(list.title)\" is not allowed for writes (see hello)", ["list": .string(list.id)])
        }
        guard list.allowsContentModifications else {
            throw HelperError(.forbiddenList, "list \"\(list.title)\" is read-only", ["list": .string(list.id)])
        }
    }

    private func perform(_ op: Operation) throws -> [String: JSON] {
        switch op {
        case .listsCreate, .markersCreate, .markersRetire: writeKind = .bootstrap
        default: writeKind = .reminders
        }
        switch op {
        case .hello(let ids, let prefixes, let writes):
            allowListIds = Set(ids)
            allowTitlePrefixes = prefixes
            writeMode = writes
            return ["protocol": .int(HelperInfo.protocolVersion), "helperVersion": .string(HelperInfo.version),
                    "backend": .string(backend.name), "cas": .string(backend.cas),
                    "authorization": .string(backend.authorization.rawValue),
                    "writes": .string(backend.requiresWriteGate ? writeMode.rawValue : "ungated"),
                    "allow": ["listIds": .array(allowListIds.sorted().map(JSON.string)),
                              "titlePrefixes": .array(prefixes.map(JSON.string))]]
        case .ping:
            return ["pong": true]
        case .shutdown:
            shutdownRequested = true
            return ["shutdown": true]
        case .accessStatus:
            return ["authorization": .string(backend.authorization.rawValue)]
        case .accessRequest(let timeout):
            let (granted, api) = try backend.requestAccess(timeout: timeout)
            return ["granted": .bool(granted), "api": .string(api), "authorization": .string(backend.authorization.rawValue)]
        case .listsList:
            try requireAccess()
            return ["lists": .array(try backend.lists().map(\.json)), "complete": true]
        case .listsCreate(let title, let opKey):
            try requireAccess()
            guard allowTitlePrefixes.contains(where: { title.hasPrefix($0) }) else {
                throw HelperError(.forbiddenList, "title \"\(title)\" does not match an allowed prefix (see hello)")
            }
            try requireWrites(title: title)
            let list = try backend.createList(title: title)
            allowListIds.insert(list.id)
            return ["opKey": .string(opKey), "list": list.json]
        case .itemsSnapshot(let list):
            try requireAccess()
            let items = try backend.snapshot(list: list)
            return ["items": .array(items.map(\.json)), "count": .int(items.count), "complete": true,
                    "asOf": .string(Timestamps.format(Date()))]
        case .itemsGet(let ref):
            try requireAccess()
            return ["item": try backend.get(ref).json]
        case .itemsFind(let q, let lists):
            try requireAccess()
            let items = try backend.find(q, lists: lists)
            return ["items": .array(items.map(\.json)), "count": .int(items.count), "complete": true]
        case .itemsCreate(let list, let url, let opKey, let set):
            try requireAccess()
            return writeBody(opKey, try backend.create(list: list, linkUrl: url, set: set, writeGuard: writeGuard))
        case .itemsUpdate(let ref, let set, let opKey, let expect):
            try requireAccess()
            return writeBody(opKey, try backend.update(ref, set: set, expect: expect, writeGuard: writeGuard))
        case .itemsRestoreUrl(let ref, let url, let opKey, let expect):
            try requireAccess()
            return writeBody(opKey, try backend.restoreUrl(ref, linkUrl: url, expect: expect, writeGuard: writeGuard))
        case .markersCreate(let list, let url, let opKey):
            try requireAccess()
            let r = try backend.createMarker(list: list, markerUrl: url, writeGuard: writeGuard)
            var body = writeBody(opKey, r)
            body["item"] = r.item.json
            return body
        case .markersRetire(let ref, let url, let opKey, let expect):
            try requireAccess()
            let retries = try backend.retireMarker(ref, markerUrl: url, expect: expect, writeGuard: writeGuard)
            return ["opKey": .string(opKey), "ref": ref.json, "retired": true, "written": [:], "retries": .int(retries)]
        case .debug(let name, let body):
            guard backend.name == "memory" else { throw invalid("debug ops exist only with --backend memory") }
            return ["debug": try backend.debug(name, body)]
        }
    }

    /// Write answers carry what the contract's AppleOpResult needs (D-010 r4 §4.2); the full item is
    /// left out on purpose: the bridge's bases come from `written`, not from a post-write snapshot.
    private func writeBody(_ opKey: String, _ r: WriteResult) -> [String: JSON] {
        var o: [String: JSON] = ["opKey": .string(opKey), "ref": ["id": .string(r.item.id), "externalId": .str(r.item.externalId)],
                                 "rev": .string(r.item.rev), "written": r.written, "retries": .int(r.retries)]
        if r.existing { o["existing"] = true }
        if !r.warnings.isEmpty { o["warnings"] = .array(r.warnings.map(JSON.string)) }
        return o
    }

    static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
}
