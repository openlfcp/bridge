import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

func registerProtocolTests() {
    test("json: serialize is one sorted line, escapes newlines") {
        let j: JSON = ["b": "x\ny", "a": [1, true, nil], "c": 1.5]
        try expectEqual(j.serialized(), #"{"a":[1,true,null],"b":"x\ny","c":1.5}"#)
        try expectEqual(try JSON.parse(j.serialized()), j)
    }

    test("json: booleans and numbers stay distinct") {
        let j = try JSON.parse(#"{"t":true,"one":1}"#)
        try expectEqual(j["t"], .bool(true))
        try expectEqual(j["one"], .number(1))
    }

    test("request: not JSON -> invalid with id null") {
        let rig = Rig()
        let r = rig.server.handle(line: "not json")
        try expectEqual(r["ok"], .bool(false))
        try expectEqual(r["error"]?["code"], "invalid")
        try expectEqual(r["id"], .null)
    }

    test("request: wrong protocol version -> unsupported_protocol, id echoed") {
        let rig = Rig()
        let r = rig.server.handle(line: #"{"v":1,"id":"a7","op":"ping"}"#)
        try expectEqual(r["error"]?["code"], "unsupported_protocol")
        try expectEqual(r["id"], "a7")
        try expectEqual(r["error"]?["supported"], [2])
    }

    test("request: unknown op and missing op -> invalid") {
        let rig = Rig()
        try expectEqual(rig.errorCode(["op": "items.frobnicate"]), "invalid")
        try expectEqual(rig.errorCode([:]), "invalid")
    }

    test("request: unknown top-level keys are ignored, unknown set keys rejected") {
        let rig = Rig()
        try expectEqual(rig.send(["op": "ping", "future": 1])["ok"], .bool(true))
        let l = rig.bridgeList()
        let item = rig.create(l, ["title": "a"])
        try expectEqual(rig.update(item, ["notes": "x"])["error"]?["code"], "invalid")
    }

    test("request: writes require opKey and expect.rev") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let ref = item["ref"]!, rev = item["rev"]!
        try expectEqual(rig.errorCode(["op": "items.update", "ref": ref, "set": ["title": "b"], "opKey": "k"]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.update", "ref": ref, "set": ["title": "b"], "expect": ["rev": rev]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.update", "ref": ref, "set": ["title": "b"], "opKey": "k",
                                       "expect": ["lastModified": rev]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.restoreUrl", "ref": ref, "linkUrl": "lfcp://task/T", "opKey": "k"]), "invalid")
        try expectEqual(rig.errorCode(["op": "markers.retire", "ref": ref, "markerUrl": "lfcp://bridge/x",
                                       "expect": ["rev": rev]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.update", "ref": ["nope": 1], "set": ["title": "b"], "opKey": "k",
                                       "expect": ["rev": rev]]), "invalid")
    }

    test("request: the old dueAlarm parameter is ignored, never acted on (B15)") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a", "dueDate": "2026-12-01"])
        item = rig.userEdit(item, ["dueTime": "09:00", "tz": "Europe/Paris", "addAlarmAt": .string(instant("2026-12-01T09:00"))])
        let r = rig.ok(["op": "items.update", "ref": item["ref"]!, "set": ["dueDate": "2026-12-03"], "opKey": "k",
                        "dueAlarm": "ui-due-alarm", "expect": ["rev": item["rev"]!]])
        try expectEqual(rig.get(r["ref"]!)["alarms"], item["alarms"])
    }

    test("response: id, ok, ms on every answer; ping and shutdown") {
        let rig = Rig()
        let r = rig.ok(["op": "ping"])
        try expectEqual(r["pong"], .bool(true))
        try expect(r["ms"]?.intValue != nil, "ms missing")
        try expect(!rig.server.shutdownRequested, "early shutdown")
        _ = rig.ok(["op": "shutdown"])
        try expect(rig.server.shutdownRequested, "shutdown not recorded")
    }

    test("ready event and hello report protocol, backend, cas") {
        let rig = Rig(hello: false)
        let ready = rig.server.readyEvent(process: ["pid": 1])
        try expectEqual(ready["event"], "ready")
        try expectEqual(ready["protocol"], 2)
        try expectEqual(ready["backend"], "memory")
        try expectEqual(ready["cas"], "strong")
        let h = rig.ok(["op": "hello", "allowListTitlePrefixes": ["LFCP · "]])
        try expectEqual(h["allow"]?["titlePrefixes"], ["LFCP · "])
    }

    test("access: every data op reports the tcc state; access.request grants (memory)") {
        let rig = Rig(authorization: .notDetermined)
        try expectEqual(rig.errorCode(["op": "lists.list"]), "tcc_not_determined")
        try expectEqual(rig.errorCode(["op": "items.snapshot", "list": "x"]), "tcc_not_determined")
        try expectEqual(rig.ok(["op": "access.status"])["authorization"], "notDetermined")
        let r = rig.ok(["op": "access.request", "timeoutSec": 5])
        try expectEqual(r["granted"], .bool(true))
        try expectEqual(rig.ok(["op": "lists.list"])["complete"], .bool(true))
        for (a, code) in [("denied", "tcc_denied"), ("restricted", "tcc_restricted"), ("writeOnly", "tcc_write_only")] {
            _ = rig.ok(["op": "debug.setAuthorization", "authorization": .string(a)])
            try expectEqual(rig.errorCode(["op": "lists.list"]), code)
        }
    }

    test("debug ops are refused when the backend is not memory") {
        // The server checks the backend name; a renamed memory backend stands in for EventKit.
        final class Named: Backend {
            let inner = MemoryBackend(retry: RetryPolicy(delays: [], sleep: { _ in }))
            var name: String { "eventkit" }
            var cas: String { "best-effort" }
            var requiresWriteGate: Bool { false }
            var authorization: Authorization { inner.authorization }
            var onChange: (() -> Void)? { get { inner.onChange } set { inner.onChange = newValue } }
            func requestAccess(timeout: TimeInterval) throws -> (granted: Bool, api: String) { try inner.requestAccess(timeout: timeout) }
            func lists() throws -> [ListInfo] { try inner.lists() }
            func list(id: String) throws -> ListInfo { try inner.list(id: id) }
            func createList(title: String) throws -> ListInfo { try inner.createList(title: title) }
            func snapshot(list: String) throws -> [ItemState] { try inner.snapshot(list: list) }
            func find(_ q: FindQuery, lists: [String]?) throws -> [ItemState] { try inner.find(q, lists: lists) }
            func get(_ ref: ItemRef) throws -> ItemState { try inner.get(ref) }
            func create(list: String, linkUrl: String, set: WritableSet, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
                try inner.create(list: list, linkUrl: linkUrl, set: set, writeGuard: writeGuard)
            }
            func update(_ ref: ItemRef, set: WritableSet, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
                try inner.update(ref, set: set, expect: expect, writeGuard: writeGuard)
            }
            func restoreUrl(_ ref: ItemRef, linkUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
                try inner.restoreUrl(ref, linkUrl: linkUrl, expect: expect, writeGuard: writeGuard)
            }
            func createMarker(list: String, markerUrl: String, writeGuard: (ListInfo) throws -> Void) throws -> WriteResult {
                try inner.createMarker(list: list, markerUrl: markerUrl, writeGuard: writeGuard)
            }
            func retireMarker(_ ref: ItemRef, markerUrl: String, expect: String, writeGuard: (ListInfo) throws -> Void) throws -> Int {
                try inner.retireMarker(ref, markerUrl: markerUrl, expect: expect, writeGuard: writeGuard)
            }
            func debug(_ name: String, _ body: [String: JSON]) throws -> JSON { try inner.debug(name, body) }
        }
        let server = Server(backend: Named()) { _ in }
        let r = server.handle(line: #"{"v":2,"id":1,"op":"debug.dump"}"#)
        try expectEqual(r["error"]?["code"], "invalid")
    }
}
