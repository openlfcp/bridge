import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

func registerEventTests() {
    test("events: own writes and the person's edits both produce coalesced `changed`") {
        let rig = Rig()
        let l = rig.bridgeList()
        let item = rig.create(l, ["title": "a"])
        _ = rig.update(item, ["title": "b"])
        let first = rig.waitForEvents("changed", count: 1)
        try expect(!first.isEmpty, "no changed event after own writes")
        Thread.sleep(forTimeInterval: 0.15)
        let settled = rig.events.filter { $0["event"]?.stringValue == "changed" }.count
        try expect(settled < 4, "events were not coalesced: \(settled)")   // ensureList + create + update -> 1-2 events
        _ = rig.userEdit(rig.get(item["ref"]!), ["title": "person"])
        let after = rig.waitForEvents("changed", count: settled + 1)
        try expect(after.count > settled, "no changed event after the person's edit")
        let seqs = after.compactMap { $0["seq"]?.intValue }
        try expectEqual(seqs, Array(1...seqs.count))
    }

    test("events: access_changed when authorization changes") {
        let rig = Rig()
        _ = rig.ok(["op": "debug.setAuthorization", "authorization": "denied"])
        let ev = rig.waitForEvents("access_changed", count: 1)
        try expectEqual(ev.first?["authorization"], "denied")
    }

    test("events: wake and sleep pass through") {
        let rig = Rig()
        rig.server.systemEvent("wake")
        try expectEqual(rig.waitForEvents("wake", count: 1).count, 1)
    }
}

func registerRetryTests() {
    test("retry: transient -3002 is retried with reset; the write lands once") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        _ = rig.ok(["op": "debug.failNext", "target": "update", "transient": 2])
        let r = rig.update(item, ["title": "b"])
        try expectEqual(r["retries"], 2)
        try expectEqual(r["written"], ["title": "b"])
    }

    test("retry: exhausted -> store_conflict, retryable, nothing written") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        _ = rig.ok(["op": "debug.failNext", "transient": 9])
        let r = rig.update(item, ["title": "b"])
        try expectEqual(r["error"]?["code"], "store_conflict")
        try expectEqual(r["error"]?["retryable"], .bool(true))
        try expectEqual(r["error"]?["retries"], 4)
        try expectEqual(rig.get(item["ref"]!)["title"], "a")
    }

    test("retry policy: every retry is pause, then reset, then the whole body again") {
        var log: [String] = []
        var calls = 0
        let policy = RetryPolicy(delays: [0.1, 0.2, 0.3], sleep: { log.append("sleep \($0)") })
        let conflict = NSError(domain: "com.apple.reminderkit", code: -3002)
        let (v, retries) = try policy.run(isTransient: isReminderKitConflict, reset: { log.append("reset") }) { () -> Int in
            calls += 1
            log.append("body")
            if calls < 3 { throw conflict }
            return 42
        }
        try expectEqual(v, 42)
        try expectEqual(retries, 2)
        try expectEqual(log, ["body", "sleep 0.1", "reset", "body", "sleep 0.2", "reset", "body"])
    }

    test("retry exhausted: the store is reset after the last refused attempt too (review #23 P2-1)") {
        var resets = 0
        var calls = 0
        let policy = RetryPolicy(delays: [0, 0], sleep: { _ in })
        let conflict = NSError(domain: "com.apple.reminderkit", code: -3002)
        do {
            _ = try policy.run(isTransient: isReminderKitConflict, reset: { resets += 1 }) { () -> Int in
                calls += 1
                throw conflict
            }
            try expect(false, "should have thrown")
        } catch let e as HelperError { try expectEqual(e.code, .storeConflict) }
        try expectEqual(calls, 3)
        try expectEqual(resets, 3, "a reset after every refused attempt, the last one included")
    }

    test("retry policy: helper errors and non-transient errors are not retried") {
        var sleeps = 0
        let policy = RetryPolicy(delays: [0, 0], sleep: { _ in sleeps += 1 })
        do {
            _ = try policy.run(isTransient: { _ in true }, reset: {}) { () -> Int in throw HelperError(.notFound, "x") }
            try expect(false, "should have thrown")
        } catch let e as HelperError { try expectEqual(e.code, .notFound) }
        let plain = NSError(domain: "x", code: 1)
        do {
            _ = try policy.run(isTransient: isReminderKitConflict, reset: {}) { () -> Int in throw plain }
            try expect(false, "should have thrown")
        } catch { try expectEqual((error as NSError).domain, "x") }
        try expectEqual(sleeps, 0)
        let nested = NSError(domain: "EKErrorDomain", code: 5,
                             userInfo: [NSUnderlyingErrorKey: NSError(domain: "com.apple.reminderkit", code: -3002)])
        try expect(isReminderKitConflict(nested), "underlying -3002 not recognised")
    }
}

func registerGateTests() {
    func gatedRig(_ writes: String?) -> Rig {
        let rig = Rig(hello: false)
        rig.backend.requiresWriteGate = true
        var hello: [String: JSON] = ["op": "hello", "allowListTitlePrefixes": ["LFCP · ", "LFCP Verify · "]]
        if let w = writes { hello["writes"] = .string(w) }
        _ = rig.ok(hello)
        return rig
    }

    test("gate: a gated backend refuses every write until hello enables writes") {
        let rig = gatedRig(nil)
        try expectEqual(rig.ok(["op": "hello", "allowListTitlePrefixes": ["LFCP · "]])["writes"], "off")
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k"]), "writes_disabled")
        // reads still work
        try expectEqual(rig.ok(["op": "lists.list"])["complete"], .bool(true))
    }

    test("gate: verification writes only to \"LFCP Verify · …\" lists") {
        let rig = gatedRig("verification")
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k1"]), "forbidden_list")
        let l = rig.bridgeList("LFCP Verify · Test")
        let item = rig.create(l, ["title": "a"])
        try expectEqual(item["title"], "a")
    }

    test("gate: verified writes to allowed lists; ungated backends report it") {
        let rig = gatedRig("verified")
        let l = rig.bridgeList("LFCP · Inbox")
        try expectEqual(rig.create(l, ["title": "a"])["title"], "a")
        try expectEqual(Rig().ok(["op": "hello"])["writes"], "ungated")
        try expectEqual(Rig(hello: false).errorCode(["op": "hello", "writes": "yes"]), "invalid")
    }
}

func registerRetryRecheckTests() {
    /// Verification mode: writes only to "LFCP Verify · …" lists, checked by title on every write.
    func verificationRig() -> Rig {
        let rig = Rig(hello: false)
        rig.backend.requiresWriteGate = true
        _ = rig.ok(["op": "hello", "allowListTitlePrefixes": ["LFCP Verify · "], "writes": "verification"])
        return rig
    }

    test("retry: create rechecks the list after the pause (renamed out of verification scope -> forbidden_list)") {
        let rig = verificationRig()
        let l = rig.bridgeList("LFCP Verify · X")
        _ = rig.ok(["op": "debug.failNext", "target": "create", "transient": 1,
                    "meanwhile": ["renameList": ["list": .string(l), "title": "Groceries"]]])
        let r = rig.send(["op": "items.create", "list": .string(l), "linkUrl": "lfcp://task/RT1", "opKey": "c",
                          "set": ["title": "a"]])
        try expectEqual(r["error"]?["code"], "forbidden_list")
        try expectEqual(rig.ok(["op": "items.snapshot", "list": .string(l)])["count"], 0)
    }

    test("retry: create finds a record that appeared during the pause (existing, no duplicate)") {
        let rig = Rig()
        let l = rig.bridgeList()
        _ = rig.ok(["op": "debug.failNext", "target": "create", "transient": 1,
                    "meanwhile": ["userCreate": ["list": .string(l), "title": "made elsewhere", "url": "lfcp://task/RT2"]]])
        let r = rig.ok(["op": "items.create", "list": .string(l), "linkUrl": "lfcp://task/RT2", "opKey": "c",
                        "set": ["title": "a"]])
        try expectEqual(r["existing"], .bool(true))
        try expectEqual(rig.ok(["op": "items.find", "url": "lfcp://task/RT2"])["count"], 1)
    }

    test("retry: createMarker rechecks the list after the pause") {
        let rig = verificationRig()
        let l = rig.bridgeList("LFCP Verify · X")
        _ = rig.ok(["op": "debug.failNext", "target": "marker", "transient": 1,
                    "meanwhile": ["renameList": ["list": .string(l), "title": "Personal"]]])
        let r = rig.send(["op": "markers.create", "list": .string(l), "markerUrl": "lfcp://bridge/x?r=R", "opKey": "m"])
        try expectEqual(r["error"]?["code"], "forbidden_list")
    }

    test("retry: createList rechecks the title after the pause (taken meanwhile -> list_exists)") {
        let rig = Rig()
        _ = rig.ok(["op": "debug.failNext", "target": "createList", "transient": 1,
                    "meanwhile": ["createList": ["title": "LFCP · Race"]]])
        let r = rig.send(["op": "lists.create", "title": "LFCP · Race", "opKey": "k"])
        try expectEqual(r["error"]?["code"], "list_exists")
        let same = rig.ok(["op": "lists.list"])["lists"]!.arrayValue!.filter { $0["title"] == "LFCP · Race" }
        try expectEqual(same.count, 1)
    }
}

func registerBootstrapGateTests() {
    test("gate: bootstrap mode allows only lists.create and markers (D-010 §6.5, review r3 P2-4)") {
        let rig = Rig(hello: false)
        rig.backend.requiresWriteGate = true
        _ = rig.ok(["op": "hello", "allowListTitlePrefixes": ["LFCP · "], "writes": "bootstrap"])
        let l = rig.ok(["op": "lists.create", "title": "LFCP · Work", "opKey": "k1"])["list"]!["id"]!
        let m = rig.ok(["op": "markers.create", "list": l, "markerUrl": "lfcp://bridge/i?r=R", "opKey": "k2"])
        try expectEqual(m["item"]?["completed"], .bool(true))
        try expectEqual(rig.errorCode(["op": "items.create", "list": l, "linkUrl": "lfcp://task/T", "opKey": "k3",
                                       "set": ["title": "a"]]), "writes_disabled")
        // A reminder the person put there cannot be written either.
        let mine = rig.ok(["op": "debug.userCreate", "list": l, "title": "milk"])["debug"]!["item"]!
        try expectEqual(rig.update(mine, ["title": "eggs"])["error"]?["code"], "writes_disabled")
        try expectEqual(rig.errorCode(["op": "items.restoreUrl", "ref": mine["ref"]!, "linkUrl": "lfcp://task/T",
                                       "opKey": "k4", "expect": ["rev": mine["rev"]!]]), "writes_disabled")
        // Retiring its own marker is allowed (unbind during bootstrap).
        let marker = m["item"]!
        try expectEqual(rig.ok(["op": "markers.retire", "ref": marker["ref"]!, "markerUrl": "lfcp://bridge/i?r=R",
                                "opKey": "k5", "expect": ["rev": marker["rev"]!]])["retired"], .bool(true))
        try expectEqual(rig.ok(["op": "hello", "writes": "bootstrap"])["writes"], "bootstrap")
    }
}
