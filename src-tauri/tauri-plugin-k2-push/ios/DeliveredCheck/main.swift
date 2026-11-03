// Checks K2DeliveredClear's matcher and read-hint parser (no device needed):
//   swiftc Sources/K2DeliveredClear.swift DeliveredCheck/main.swift -o /tmp/k2dc && /tmp/k2dc

import Foundation
var fails = 0
func check(_ c: Bool, _ m: String) { if !c { fails += 1; print("FAIL", m) } else { print("ok  ", m) } }
let t0 = Date(timeIntervalSince1970: 1000)
let srv = K2DeliveredClear.Server(badgeKey: "abc", subdomain: "z3thon")
func note(_ id: String, _ info: [AnyHashable: Any], _ at: Double) -> K2DeliveredClear.Note { .init(id: id, info: info, date: Date(timeIntervalSince1970: at)) }
let notes = [
  note("a", ["kind":"thread","conversationId":"c1","seq":"5","badgeKey":"abc","subdomain":"z3thon"], 900),
  note("b", ["kind":"thread","conversationId":"c1","seq":"9","badgeKey":"abc","subdomain":"z3thon"], 950),
  note("c", ["kind":"thread","conversationId":"c2","seq":"3","badgeKey":"abc","subdomain":"z3thon"], 900),
  note("d", ["kind":"project","groupId":"g1","badgeKey":"abc","subdomain":"z3thon"], 900),
  note("e", ["kind":"ticket","feedbackId":"t1","badgeKey":"abc","subdomain":"z3thon"], 900),
  note("f", ["kind":"thread","conversationId":"c1","seq":"1","badgeKey":"other","subdomain":"z3thon"], 900),
  note("g", ["kind":"thread","conversationId":"c1","seq":"2","subdomain":"z3thon"], 900),
  note("h", ["kind":"thread","conversationId":"c3","seq":"4","badgeKey":"abc","subdomain":"z3thon"], 1100),
  note("i", ["kind":"project","groupId":"g1","badgeKey":"abc","subdomain":"z3thon"], 1100),
  note("j", ["kind":"thread","badgeKey":"abc","subdomain":"z3thon"], 900),
  note("k", ["kind":"thread","conversationId":"c5","seq":"1","badgeKey":"","subdomain":"","instanceId":"iid9"], 900),
]
typealias C = K2DeliveredClear.Chat
var r = K2DeliveredClear.toRemove(notes, server: srv, op: .read([C(kind:"thread", id:"c1", seq:5)]), before: t0)
check(Set(r) == ["a","g"], "read c1≤5 removes a and the badgeKey-less g, keeps b (seq 9) and other person's f: \(r)")
r = K2DeliveredClear.toRemove(notes, server: srv, op: .read([C(kind:"project", id:"g1", seq:nil)]), before: t0)
check(Set(r) == ["d"], "read project g1 removes only the one delivered before: \(r)")
r = K2DeliveredClear.toRemove(notes, server: srv, op: .keepOnly([]), before: t0)
check(Set(r) == ["a","b","c","d","g","j"], "keepOnly([]) removes every thread/project note before, not tickets, not newer, not other person: \(r)")
r = K2DeliveredClear.toRemove(notes, server: srv, op: .keepOnly([C(kind:"thread", id:"c1", seq:5)]), before: t0)
check(Set(r) == ["a","c","d","g"], "keepOnly c1>5 keeps b and the generic j: \(r)")
r = K2DeliveredClear.toRemove(notes, server: K2DeliveredClear.Server(badgeKey: nil, subdomain: "Z3THON"), op: .keepOnly([]), before: t0)
check(Set(r) == ["a","b","c","d","f","g","j"], "subdomain only matches every login on that host: \(r)")
r = K2DeliveredClear.toRemove(notes, server: K2DeliveredClear.Server(badgeKey: "abc", subdomain: "z3thon", instanceId: "iid9"), op: .read([C(kind:"thread", id:"c5", seq:1)]), before: t0)
check(r == ["k"], "a note with empty badgeKey and subdomain matches on instanceId: \(r)")
let hints = K2DeliveredClear.parseReadHints("t:c-1:42,p:proj:x:7,t::3,q:z:1,t:c9:nope,t:c:2:5")
check(hints == [C(kind:"thread", id:"c-1", seq:42), C(kind:"project", id:"proj:x", seq:7), C(kind:"thread", id:"c:2", seq:5)], "read hints parse: \(hints)")
// K2's format: plain badge and format-2 nudge `read`, project alert `seq` as a string.
let wire = K2DeliveredClear.parseReadHints("t:c-77:418,p:pg-9:7")
check(wire == [C(kind:"thread", id:"c-77", seq:418), C(kind:"project", id:"pg-9", seq:7)], "K2 0.46.8 vector parses: \(wire)")
let fresh = [
  note("p12", ["kind":"project","groupId":"pg-9","seq":"12","badgeKey":"abc"], 995),
  note("p7", ["kind":"project","groupId":"pg-9","seq":"7","badgeKey":"abc"], 995),
  note("t5", ["kind":"thread","conversationId":"c-1","seq":"5","badgeKey":"abc"], 995),
  note("card", ["kind":"thread","conversationId":"c-1","seq":"5","permission":"1","requestId":"pr_1","badgeKey":"abc"], 900),
]
r = K2DeliveredClear.toRemove(fresh, server: srv, op: .read(wire), before: t0.addingTimeInterval(-10))
check(r == ["p7"], "a too-new alert still goes by seq; p12 stays: \(r)")
r = K2DeliveredClear.toRemove(fresh, server: srv, op: .read([C(kind:"thread", id:"c-1", seq:9)]), before: t0)
check(r == ["t5"], "a read clears the chat's alert, not its card's: \(r)")
r = K2DeliveredClear.toRemove(fresh, server: srv, op: .keepOnly([]), before: t0.addingTimeInterval(-10))
check(r == ["card"], "nothing left: the old card goes, too-new alerts wait: \(r)")
func shape(_ o: [K2DeliveredClear.Op]) -> [String] { o.map { if case .read = $0 { return "read" } else { return "keepOnly" } } }
check(shape(K2DeliveredClear.silentOps(unread: 0, waiting: 0, hints: wire)) == ["read","keepOnly"], "totals 0 with hints: both, hints first")
check(shape(K2DeliveredClear.silentOps(unread: 0, waiting: nil, hints: [])) == ["keepOnly"], "bare badge at 0, no waitingTotal: keepOnly")
check(shape(K2DeliveredClear.silentOps(unread: 0, waiting: 1, hints: [])).isEmpty, "a card waiting, no hints: nothing")
check(shape(K2DeliveredClear.silentOps(unread: 3, waiting: 0, hints: wire)) == ["read"], "unread left: hints only")
print(fails == 0 ? "ALL OK" : "\(fails) FAILED")
