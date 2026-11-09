import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

func registerWriteTests() {
    // MARK: lists and allowlist

    test("lists.create: allowed prefix only; a taken title -> list_exists (never adopt by title)") {
        let rig = Rig(hello: false)
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k"]), "forbidden_list")
        _ = rig.ok(["op": "hello", "allowListTitlePrefixes": ["LFCP · "]])
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "Groceries", "opKey": "k"]), "forbidden_list")
        let first = rig.ok(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k1"])
        try expectEqual(first["opKey"], "k1")
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k2"]), "list_exists")
        // A person's list with a bridge-like title is also "taken".
        _ = rig.ok(["op": "debug.addList", "title": "LFCP · Work"])
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · Work", "opKey": "k3"]), "list_exists")
        try expectEqual(rig.errorCode(["op": "lists.create", "title": "LFCP · X"]), "invalid")   // opKey required
    }

    test("allowlist: writes to a real list are refused; reads are allowed") {
        let rig = Rig()
        let real = rig.ok(["op": "debug.addList", "title": "Groceries"])["debug"]!["list"]!["id"]!
        try expectEqual(rig.errorCode(["op": "items.create", "list": real, "linkUrl": "lfcp://task/T", "opKey": "c",
                                       "set": ["title": "x"]]), "forbidden_list")
        let mine = rig.ok(["op": "debug.userCreate", "list": real, "title": "milk"])["debug"]!["item"]!
        try expectEqual(rig.update(mine, ["title": "eggs"])["error"]?["code"], "forbidden_list")
        try expectEqual(rig.ok(["op": "items.snapshot", "list": real])["count"], 1)
    }

    test("allowlist: list ids from hello are writable; read-only lists are not") {
        let rig = Rig(hello: false)
        let ro = rig.ok(["op": "debug.addList", "title": "Shared", "readOnly": true])["debug"]!["list"]!["id"]!
        _ = rig.ok(["op": "hello", "allowListIds": [ro]])
        try expectEqual(rig.errorCode(["op": "items.create", "list": ro, "linkUrl": "lfcp://task/T", "opKey": "c",
                                       "set": ["title": "x"]]), "forbidden_list")
    }

    test("a reminder moved to a list outside the scope cannot be written") {
        let rig = Rig()
        let l = rig.bridgeList()
        let real = rig.ok(["op": "debug.addList", "title": "Personal"])["debug"]!["list"]!["id"]!
        let item = rig.create(l, ["title": "a"])
        let moved = rig.userEdit(item, ["moveToList": real])
        try expectEqual(rig.update(moved, ["title": "b"])["error"]?["code"], "forbidden_list")
    }

    // MARK: create

    test("create: answer carries opKey, ref, rev, written; fields round-trip") {
        let rig = Rig()
        let l = rig.bridgeList()
        let r = rig.ok(["op": "items.create", "list": .string(l), "linkUrl": "lfcp://task/T-milk", "opKey": "op-milk",
                        "set": ["title": "Buy milk", "priority": 9, "dueDate": "2026-12-01"]])
        try expectEqual(r["opKey"], "op-milk")
        try expectEqual(r["written"], ["title": "Buy milk", "priority": 9, "dueDate": "2026-12-01", "linkUrl": "lfcp://task/T-milk"])
        try expectEqual(r["existing"], nil)
        try expectEqual(r["item"], nil)   // bases come from `written`, not from a post-write snapshot
        let a = rig.get(r["ref"]!)
        try expectEqual(a["rev"], r["rev"])
        try expectEqual(a["due"], ["date": "2026-12-01", "time": nil, "tz": nil])
        try expectEqual(a["linkUrl"], "lfcp://task/T-milk")
    }

    test("create: idempotent by link in the list; snapshot complete with completed items") {
        let rig = Rig()
        let l = rig.bridgeList()
        let a = rig.ok(["op": "items.create", "list": .string(l), "linkUrl": "lfcp://task/T1", "opKey": "c1", "set": ["title": "a"]])
        let again = rig.ok(["op": "items.create", "list": .string(l), "linkUrl": "lfcp://task/T1", "opKey": "c2", "set": ["title": "a"]])
        try expectEqual(again["existing"], .bool(true))
        try expectEqual(again["ref"], a["ref"])
        _ = rig.create(l, ["title": "done", "completed": ["value": true]], url: "lfcp://task/T2")
        let snap = rig.ok(["op": "items.snapshot", "list": .string(l)])
        try expectEqual(snap["count"], 2)
        try expectEqual(snap["complete"], .bool(true))
    }

    test("create: needs opKey, title and an lfcp://task/ link") {
        let rig = Rig()
        let l = JSON.string(rig.bridgeList())
        try expectEqual(rig.errorCode(["op": "items.create", "list": l, "linkUrl": "lfcp://task/T", "set": ["title": "a"]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.create", "list": l, "linkUrl": "https://x", "opKey": "c", "set": ["title": "a"]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.create", "list": l, "linkUrl": "lfcp://bridge/x", "opKey": "c", "set": ["title": "a"]]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.create", "list": l, "linkUrl": "lfcp://task/T", "opKey": "c", "set": [:]]), "invalid")
    }

    // MARK: update

    test("update: stale expect.rev -> conflict_changed with fresh item") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let edited = rig.userEdit(item, ["title": "edited on iPhone"])
        try expect(edited["rev"] != item["rev"], "rev did not change on a user edit")
        let r = rig.update(item, ["title": "b"])
        try expectEqual(r["error"]?["code"], "conflict_changed")
        try expectEqual(r["error"]?["retryable"], .bool(true))
        try expectEqual(r["error"]?["fresh"]?["title"], "edited on iPhone")
        let ok = rig.update(edited, ["title": "b"])
        try expectEqual(ok["written"], ["title": "b"])
    }

    test("update: rev changes on every write; A-B-C-B writes every time") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "A"])
        var revs: Set<String> = [item["rev"]!.stringValue!]
        for t in ["B", "C", "B"] {
            let r = rig.update(item, ["title": .string(t)])
            try expectEqual(r["written"], ["title": .string(t)])
            revs.insert(r["rev"]!.stringValue!)
            item = rig.get(r["ref"]!)
        }
        try expectEqual(revs.count, 4)
    }

    test("rev: unique for every write, also within one millisecond") {
        // A clock that ticks one millisecond every second call, over a thousand writes: revisions must
        // stay distinct both within one millisecond and across many millisecond values (a whole
        // millisecond as a Double can format as the previous one).
        var calls = 0
        let start = 1_794_259_613_123.0
        let backend = MemoryBackend(retry: RetryPolicy(delays: [], sleep: { _ in }), zone: Rig.zone, clock: {
            calls += 1
            return Date(timeIntervalSince1970: (start + Double(calls / 2)) / 1000)   // x.123 s may be stored as x.12299…
        })
        let server = Server(backend: backend) { _ in }
        func call(_ o: [String: JSON]) -> JSON {
            var r = o; r["v"] = 2; r["id"] = 1
            return server.handle(line: JSON.object(r).serialized())
        }
        _ = call(["op": "hello", "allowListTitlePrefixes": ["LFCP · "]])
        let l = call(["op": "lists.create", "title": "LFCP · Inbox", "opKey": "k"])["list"]!["id"]!
        var r = call(["op": "items.create", "list": l, "linkUrl": "lfcp://task/T", "opKey": "c", "set": ["title": "t0"]])
        var revs: [String] = [r["rev"]!.stringValue!]
        for i in 1...1000 {
            r = call(["op": "items.update", "ref": r["ref"]!, "set": ["title": .string("t\(i)")], "opKey": .string("u\(i)"),
                      "expect": ["rev": .string(revs.last!)]])
            guard let rev = r["rev"]?.stringValue else { throw TestFailure(description: "write \(i) failed: \(r.serialized())") }
            revs.append(rev)
        }
        try expectEqual(Set(revs).count, revs.count)
    }

    test("update: only the set fields change; notes, time, alarms, link untouched") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a", "dueDate": "2026-12-01"])
        item = rig.userEdit(item, ["dueTime": "09:00", "tz": "Europe/Paris", "notes": true, "addLocationAlarm": true,
                                   "addAlarmAt": .string(instant("2026-11-30T18:00")), "addRelativeAlarmSec": -900])
        let r = rig.update(item, ["title": "b", "priority": 1, "completed": ["value": true]])
        try expect(r["written"]?["title"] == "b" && r["written"]?["priority"] == 1, "written: \(r.serialized())")
        let after = rig.get(r["ref"]!)
        try expectEqual(after["hasNotes"], .bool(true))
        try expectEqual(after["due"], item["due"])
        try expectEqual(after["alarms"], item["alarms"])
        try expectEqual(after["linkUrl"], item["linkUrl"])
    }

    test("priority: only 0, 1, 9 (B13 buckets)") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a"])
        for p in [0, 1, 9] {
            let r = rig.update(item, ["priority": .int(p)])
            try expectEqual(r["written"], ["priority": .int(p)])
            item = rig.get(r["ref"]!)
        }
        for p in [5, 3, 10, -1] { try expectEqual(rig.update(item, ["priority": .int(p)])["error"]?["code"], "invalid") }
    }

    test("unknown set keys are rejected (notes, linkUrl, alarms are not writable)") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        for k in ["notes", "linkUrl", "alarms", "dueTime"] {
            try expectEqual(rig.update(item, [k: "x"])["error"]?["code"], "invalid")
        }
    }

    test("completed: past date -> noon of that day; false clears the date") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let done = rig.update(item, ["completed": ["value": true, "date": "2026-11-02"]])
        try expectEqual(done["written"], ["completed": ["value": true, "completionDate": .string(instant("2026-11-02T12:00"))]])
        let reopened = rig.update(rig.get(done["ref"]!), ["completed": ["value": false]])
        try expectEqual(reopened["written"], ["completed": ["value": false]])
        try expectEqual(rig.update(item, ["completed": ["value": false, "date": "2026-11-02"]])["error"]?["code"], "invalid")
    }

    test("completed: done(cd1) -> done(today) replaces the old completion date") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let old = rig.update(item, ["completed": ["value": true, "date": "2020-01-01"]])
        try expectEqual(old["written"], ["completed": ["value": true, "completionDate": .string(instant("2020-01-01T12:00"))]])
        let today = LocalDate.today(in: Rig.zone).description
        let r = rig.update(rig.get(old["ref"]!), ["completed": ["value": true, "date": .string(today)]])
        let cd = r["written"]?["completed"]?["completionDate"]?.stringValue.flatMap(Timestamps.parse)
        try expect(cd != nil && abs(cd!.timeIntervalSinceNow) < 60, "completion date not replaced: \(r.serialized())")
        try expectEqual(rig.get(r["ref"]!)["completionDate"], r["written"]?["completed"]?["completionDate"])
        // Already today: a repeat keeps it (no churn).
        let again = rig.update(rig.get(r["ref"]!), ["completed": ["value": true, "date": .string(today)]])
        try expectEqual(again["written"]?["completed"]?["completionDate"], r["written"]?["completed"]?["completionDate"])
    }

    // MARK: due date (B2, B12, B15)

    test("due: set on a reminder without due -> date only") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let r = rig.update(item, ["dueDate": "2026-12-05"])
        try expectEqual(r["written"], ["dueDate": "2026-12-05"])
        try expectEqual(rig.get(r["ref"]!)["due"], ["date": "2026-12-05", "time": nil, "tz": nil])
    }

    test("due: date change keeps time, zone and every alarm (B15); warns about the old day") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a", "dueDate": "2026-12-01"])
        item = rig.userEdit(item, ["dueTime": "09:00", "tz": "Europe/Paris",
                                   "addAlarmAt": .string(instant("2026-12-01T09:00")), "addRelativeAlarmSec": -1800])
        let r = rig.update(item, ["dueDate": "2026-12-03"])
        try expectEqual(r["warnings"], ["alarm_on_old_date"])
        let after = rig.get(r["ref"]!)
        try expectEqual(after["due"], ["date": "2026-12-03", "time": "09:00", "tz": "Europe/Paris"])
        try expectEqual(after["alarms"], item["alarms"])
    }

    test("due: same date or no alarm on the old day -> no warning") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a", "dueDate": "2026-12-01"])
        item = rig.userEdit(item, ["dueTime": "09:00", "tz": "Europe/Paris", "addRelativeAlarmSec": -900])
        try expectEqual(rig.update(item, ["dueDate": "2026-12-04"])["warnings"], nil)
    }

    test("due=null: allowed for a bare date, personal_conflict with time or any alarm (B12)") {
        let rig = Rig()
        let l = rig.bridgeList()
        let bare = rig.create(l, ["title": "a", "dueDate": "2026-12-01"], url: "lfcp://task/A")
        try expectEqual(rig.update(bare, ["dueDate": nil])["written"], ["dueDate": nil])

        var timed = rig.create(l, ["title": "b", "dueDate": "2026-12-01"], url: "lfcp://task/B")
        timed = rig.userEdit(timed, ["dueTime": "09:00"])
        let r1 = rig.update(timed, ["dueDate": nil])
        try expectEqual(r1["error"]?["code"], "personal_conflict")
        try expectEqual(r1["error"]?["hasTime"], .bool(true))

        var alarmed = rig.create(l, ["title": "c", "dueDate": "2026-12-01"], url: "lfcp://task/C")
        alarmed = rig.userEdit(alarmed, ["addLocationAlarm": true])
        try expectEqual(rig.update(alarmed, ["dueDate": nil])["error"]?["code"], "personal_conflict")
        try expectEqual(rig.get(alarmed["ref"]!)["rev"], alarmed["rev"])   // nothing was written
    }

    test("due=null on a recurring reminder -> eventkit_error (EventKit rule)") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a", "dueDate": "2026-12-01"])
        item = rig.userEdit(item, ["recurrence": true])
        try expectEqual(rig.update(item, ["dueDate": nil])["error"]?["code"], "eventkit_error")
    }

    // MARK: restoreUrl

    test("restoreUrl: fills a missing link, keeps a URL the person set") {
        let rig = Rig()
        var item = rig.create(rig.bridgeList(), ["title": "a"], url: "lfcp://task/T9")
        item = rig.userEdit(item, ["url": nil])
        try expectEqual(item["linkUrl"], .null)
        let r = rig.ok(["op": "items.restoreUrl", "ref": item["ref"]!, "linkUrl": "lfcp://task/T9", "opKey": rig.opKey(),
                        "expect": ["rev": item["rev"]!]])
        try expectEqual(r["written"], ["linkUrl": "lfcp://task/T9"])
        let theirs = rig.userEdit(rig.get(r["ref"]!), ["url": "https://example.com/recipe"])
        try expectEqual(rig.errorCode(["op": "items.restoreUrl", "ref": theirs["ref"]!, "linkUrl": "lfcp://task/T9",
                                       "opKey": rig.opKey(), "expect": ["rev": theirs["rev"]!]]), "personal_conflict")
        let mine = rig.userEdit(theirs, ["url": "lfcp://task/T9"])
        let same = rig.ok(["op": "items.restoreUrl", "ref": mine["ref"]!, "linkUrl": "lfcp://task/T9", "opKey": rig.opKey(),
                           "expect": ["rev": mine["rev"]!]])
        try expectEqual(same["rev"], mine["rev"])   // nothing to do, no write
    }

    // MARK: markers

    test("markers: create is a completed reminder, idempotent; retire only the exact marker") {
        let rig = Rig()
        let l = JSON.string(rig.bridgeList())
        let url: JSON = "lfcp://bridge/inst-1?r=R1"
        let m = rig.ok(["op": "markers.create", "list": l, "markerUrl": url, "opKey": rig.opKey()])
        try expectEqual(m["item"]?["completed"], .bool(true))
        try expectEqual(m["item"]?["title"], .string(Marker.title))
        let again = rig.ok(["op": "markers.create", "list": l, "markerUrl": url, "opKey": rig.opKey()])
        try expectEqual(again["existing"], .bool(true))
        try expectEqual(again["ref"], m["ref"])
        try expectEqual(rig.errorCode(["op": "markers.create", "list": l, "markerUrl": "lfcp://task/T", "opKey": "k"]), "invalid")

        let task = rig.create(l.stringValue!, ["title": "not a marker"])
        try expectEqual(rig.errorCode(["op": "markers.retire", "ref": task["ref"]!, "markerUrl": url, "opKey": "k",
                                       "expect": ["rev": task["rev"]!]]), "forbidden_list")
        let marker = m["item"]!
        try expectEqual(rig.errorCode(["op": "markers.retire", "ref": marker["ref"]!, "markerUrl": "lfcp://bridge/inst-1?r=R2",
                                       "opKey": "k", "expect": ["rev": marker["rev"]!]]), "forbidden_list")
        let r = rig.ok(["op": "markers.retire", "ref": marker["ref"]!, "markerUrl": url, "opKey": "k",
                        "expect": ["rev": marker["rev"]!]])
        try expectEqual(r["retired"], .bool(true))
        try expectEqual(rig.ok(["op": "items.find", "url": url])["count"], 0)
    }

    test("items.delete does not exist (B11)") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        try expectEqual(rig.errorCode(["op": "items.delete", "ref": item["ref"]!, "expect": ["rev": item["rev"]!]]), "invalid")
    }

    // MARK: find

    test("find: url, urlPrefix, externalId, id; scoped and across all lists") {
        let rig = Rig()
        let l = rig.bridgeList()
        let a = rig.create(l, ["title": "a"], url: "lfcp://task/F-a")
        let other = rig.ok(["op": "debug.addList", "title": "Elsewhere"])["debug"]!["list"]!["id"]!
        _ = rig.ok(["op": "debug.userCreate", "list": other, "title": "b", "url": "lfcp://task/F-b"])
        try expectEqual(rig.ok(["op": "items.find", "url": "lfcp://task/F-a", "lists": [.string(l)]])["count"], 1)
        try expectEqual(rig.ok(["op": "items.find", "urlPrefix": "lfcp://task/F-"])["count"], 2)
        try expectEqual(rig.ok(["op": "items.find", "urlPrefix": "lfcp://task/F-", "lists": [.string(l)]])["count"], 1)
        try expectEqual(rig.ok(["op": "items.find", "externalId": a["ref"]!["externalId"]!])["count"], 1)
        try expectEqual(rig.ok(["op": "items.find", "itemId": a["ref"]!["id"]!])["count"], 1)
        try expectEqual(rig.errorCode(["op": "items.find", "url": "x", "itemId": "y"]), "invalid")
        try expectEqual(rig.errorCode(["op": "items.find", "url": "x", "lists": ["nope"]]), "list_not_found")
    }

    test("get by externalId; ambiguous when it matches several (id churn)") {
        let rig = Rig()
        let item = rig.create(rig.bridgeList(), ["title": "a"])
        let churned = rig.userEdit(item, ["changeId": true])
        try expect(churned["ref"]?["id"] != item["ref"]?["id"], "id did not change")
        try expectEqual(rig.errorCode(["op": "items.get", "ref": ["id": item["ref"]!["id"]!]]), "not_found")
        let byExt = rig.ok(["op": "items.get", "ref": ["externalId": item["ref"]!["externalId"]!]])
        try expectEqual(byExt["item"]?["ref"]?["id"], churned["ref"]?["id"])
    }
}
