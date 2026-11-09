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
