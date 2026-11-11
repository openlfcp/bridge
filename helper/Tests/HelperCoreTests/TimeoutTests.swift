import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

// A store operation that never returns (R-001 live run 2: an EventKit fetch on a list with a
// repeating reminder hung, and every later request waited behind it on the serial queue).
func registerTimeoutTests() {
    test("an operation past its deadline answers eventkit_timeout; the next request is answered") {
        let rig = Rig(hello: false, opTimeout: 0.3)
        let t0 = Date()
        let r = rig.respond(["op": "debug.hang", "seconds": 5])
        try expectEqual(r["error"]?["code"]?.stringValue, "eventkit_timeout")
        try expectEqual(r["id"], .int(1), "the answer is for the request that hung")
        try expectEqual(r["error"]?["retryable"]?.boolValue, false, "a write that hung has an unknown outcome")
        try expect(Date().timeIntervalSince(t0) < 2, "answered at the deadline, not when the operation ends")
        let t1 = Date()
        let next = rig.respond(["op": "lists.list"])
        try expectEqual(next["error"]?["code"]?.stringValue, "helper_stalled", "answered, not run on the stalled helper")
        try expect(Date().timeIntervalSince(t1) < 1, "the next request does not wait for the stuck one")
        try expect(rig.events.contains { $0["event"]?.stringValue == "stalled" && $0["op"]?.stringValue == "debug.hang" },
                   "a stalled event tells the host (it restarts the helper)")
    }

    test("after a deadline nothing else runs: a late write cannot use another request's gate (review #23 P1-2)") {
        // The reviewer's scenario: a write stuck before its gate check outlives its deadline; a later
        // allowed request must not run on the shared Server, or the stuck write would see its gate.
        let rig = Rig(hello: false, opTimeout: 0.1)
        rig.backend.requiresWriteGate = true
        _ = rig.respond(["op": "hello", "allowListTitlePrefixes": ["LFCP · "], "writes": "bootstrap"])
        let a = rig.respond(["op": "lists.create", "title": "LFCP · A", "opKey": "k-a"])["list"]?["id"]?.stringValue ?? ""
        try expect(!a.isEmpty, "list A created")
        let gate = DispatchSemaphore(value: 0)
        rig.backend.beforeWriteGuard = { gate.wait() }
        let stuck = rig.respond(["op": "items.create", "list": .string(a), "linkUrl": "lfcp://task/T1?s=S&b=b1",
                                 "set": ["title": "x"], "opKey": "k-r"])
        try expectEqual(stuck["error"]?["code"]?.stringValue, "eventkit_timeout")
        let later = rig.respond(["op": "lists.create", "title": "LFCP · B", "opKey": "k-b"])
        try expectEqual(later["error"]?["code"]?.stringValue, "helper_stalled", "the next request is refused, not run")
        rig.backend.beforeWriteGuard = nil
        gate.signal()
        Thread.sleep(forTimeInterval: 0.3)
        try expectEqual(try rig.backend.snapshot(list: a).count, 0, "the late write met its own gate (bootstrap) and wrote nothing")
        try expect(!(try rig.backend.lists()).contains { $0.title == "LFCP · B" }, "the refused request created nothing")
    }

    test("after a deadline every request is refused at once, without the backend (review #23 P1-1)") {
        let rig = Rig(hello: false, opTimeout: 0.1)
        _ = rig.respond(["op": "debug.hang", "seconds": 2])
        let t0 = Date()
        for op in ["lists.list", "hello", "access.status"] {
            let r = rig.respond(["op": .string(op)])
            try expectEqual(r["error"]?["code"]?.stringValue, "helper_stalled", op)
        }
        try expect(Date().timeIntervalSince(t0) < 0.5, "refused at once")
        try expect(rig.server.stalled, "the server says it is stalled (the executable then exits)")
    }

    test("an operation within its deadline is answered as before") {
        let rig = Rig(opTimeout: 2)
        let r = rig.respond(["op": "debug.hang", "seconds": 0.05])
        try expectEqual(r["ok"]?.boolValue, true)
        try expect(!rig.events.contains { $0["event"]?.stringValue == "stalled" }, "no stalled event")
    }
}
