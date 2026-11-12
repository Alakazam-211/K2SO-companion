// Holds the phone's signed-approval reader (ios/Approval) to K2's shared
// fixtures (wire contract §10), on macOS:
//   cd src-tauri/tauri-plugin-k2-push/ios && swift run ApprovalCheck [fixtures dir]
// Every valid payload parses and its screen text equals the .txt; every
// invalid one is refused with its code; key ids and words match keys.json;
// records rebuild byte for byte.
import Foundation
import K2Approval

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let dir = CommandLine.arguments.dropFirst().first.map { URL(fileURLWithPath: $0) } ?? here.appendingPathComponent("sa1")
func file(_ p: String) -> Data { try! Data(contentsOf: dir.appendingPathComponent(p)) }
func json(_ p: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: file(p)) as! [String: Any] }

var failed = 0
var passed = 0
func check(_ ok: Bool, _ what: String) {
  if ok { passed += 1 } else { failed += 1; print("FAIL \(what)") }
}

// Payloads.
let manifest = json("payloads.json")
for v in manifest["valid"] as! [[String: Any]] {
  let name = v["name"] as! String
  do {
    let p = try K2ApprovalPayload.parse(file(v["payload"] as! String))
    let want = String(decoding: file(v["display"] as! String), as: UTF8.self)
    check(p.text == want, "valid \(name): text\n--- got\n\(p.text)--- want\n\(want)")
    check(p.bytes == Array(file(v["payload"] as! String)), "valid \(name): bytes kept")
  } catch {
    check(false, "valid \(name): refused \(error)")
  }
}
for v in manifest["invalid"] as! [[String: Any]] {
  let name = v["name"] as! String
  let code = v["code"] as! String
  do {
    _ = try K2ApprovalPayload.parse(file(v["payload"] as! String))
    check(false, "invalid \(name): accepted (want \(code))")
  } catch let r as K2ApprovalRefusal {
    check(r.code.rawValue == code, "invalid \(name): got \(r.code.rawValue) (\(r.message)), want \(code)")
  } catch {
    check(false, "invalid \(name): \(error)")
  }
}

// Word list.
let words = String(decoding: file("wordlist.txt"), as: UTF8.self).split(separator: "\n").map(String.init)
check(words == K2ApprovalWords.list, "wordlist.txt equals K2ApprovalWords.list")

// Key ids and words from the PEMs.
func spki(pem: String) -> Data {
  let b64 = pem.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
  return Data(base64Encoded: b64)!
}
let keys = json("keys.json")
for (name, any) in keys {
  guard let k = any as? [String: Any], (k["alg"] as? String) == "ES256",
    let pemData = try? Data(contentsOf: dir.appendingPathComponent("keys/\(name).pem"))
  else { continue }
  let der = spki(pem: String(decoding: pemData, as: UTF8.self))
  let id = K2ApprovalKeyId.keyId(spki: der)
  check(id == k["key_id"] as? String, "key \(name): key id \(id)")
  check(K2ApprovalKeyId.words(keyId: id) == k["words"] as? String, "key \(name): words")
  // A raw point rebuilds the same SPKI (what the phone does with SecKey).
  check(K2ApprovalKeyId.spki(rawPoint: der.suffix(65)) == der, "key \(name): SPKI from raw point")
}

// Records rebuild byte for byte.
let records = (try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("records").path)) ?? []
for r in records.sorted() where r.hasSuffix(".json") {
  let text = String(decoding: file("records/\(r)"), as: UTF8.self).trimmingCharacters(in: .newlines)
  let o = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
  guard (o["alg"] as? String) == "ES256", let p = Data(base64Encoded: o["payload_b64"] as! String),
    let s = Data(base64Encoded: o["sig_b64"] as! String)
  else { continue }
  let built = K2ApprovalRecord.json(payload: Array(p), keyId: o["key_id"] as! String, signatureDER: s)
  check(built == text, "record \(r): rebuilt\n\(built)\n\(text)")
}

// Reader edge cases from json.rs's own tests.
func code(_ t: String) -> String {
  do { _ = try K2StrictJSON.parse(Array(t.utf8)); return "ok" } catch let r as K2ApprovalRefusal { return r.code.rawValue } catch { return "?" }
}
let edges: [(String, String)] = [
  ("{\"a\":1,\"a\":2}", "duplicate_key"), ("{\"nonce\":1,\"\\u006eonce\":2}", "duplicate_key"),
  ("{\"\u{e9}\":1,\"e\u{301}\":2}", "ok"),
  ("1.5", "not_integer"), ("1e3", "not_integer"), ("-0", "not_integer"), ("9007199254740992", "not_integer"),
  ("123456789012345678901234567890", "not_integer"), ("9007199254740991", "ok"), ("-9007199254740991", "ok"),
  ("\"a\\u202eb\"", "forbidden_char"), ("\"a\u{202e}b\"", "forbidden_char"), ("\"a\u{200b}b\"", "forbidden_char"),
  ("\"a\\nb\"", "forbidden_char"), ("\"a\nb\"", "forbidden_char"), ("\"\\ud800\"", "forbidden_char"),
  ("\"\\ud800\\u0041\"", "forbidden_char"), ("\"\\udc00\"", "forbidden_char"), ("\"\u{fe0f}\"", "forbidden_char"),
  ("\"\u{e0041}\"", "forbidden_char"), ("\"\u{ffff}\"", "forbidden_char"), ("\"\\ud83d\\ude00\"", "ok"),
  ("{} x", "json"), ("{", "json"), ("01", "json"), ("NaN", "json"), ("\u{feff}{}", "json"), ("\"\\x\"", "json"),
  ("[[[[[[[[[]]]]]]]]]", "json"), ("[[[[[[[[]]]]]]]]", "ok"),
]
for (t, want) in edges { check(code(t) == want, "edge \(t.debugDescription): got \(code(t)), want \(want)") }
check(K2StrictJSON.firstInvalidUTF8([0xED, 0xA0, 0x80]) == 0, "utf8: encoded surrogate refused")
check(K2StrictJSON.firstInvalidUTF8([0xC0, 0x80]) == 0, "utf8: overlong refused")
check(K2StrictJSON.firstInvalidUTF8([0x41, 0xE2, 0x82]) == 1, "utf8: cut short refused")
check(K2StrictJSON.firstInvalidUTF8(Array("é😀".utf8)) == nil, "utf8: good text")
check(K2ApprovalTime.parseUTC("2026-11-11T14:00:00Z") == 1_794_405_600, "time: epoch")
check(K2ApprovalTime.parseUTC("2028-02-29T00:00:00Z") != nil, "time: leap day")
for bad in ["2026-02-29T00:00:00Z", "2026-11-11T14:00:00.5Z", "2026-11-11T24:00:00Z", "1999-12-31T23:59:59Z", "2026-13-01T00:00:00Z"] {
  check(K2ApprovalTime.parseUTC(bad) == nil, "time: \(bad) refused")
}

// The Touch ID / passcode prompt line (K2 Design 11-11).
func reason(_ kind: String, _ body: String = "{\"x\":\"y\"}") -> String {
  let json = "{\"kind\":\"\(kind)\",\"kind_v\":1,\"rp\":\"k2sign@z3mbpZ\",\"approver\":\"r\",\"approver_keys\":[\"\(String(repeating: "a", count: 64))\"],\"nonce\":\"\(String(repeating: "0", count: 32))\",\"issued\":\"2026-11-11T14:00:00Z\",\"answer_by\":\"2026-11-11T14:15:00Z\",\"body\":\(body)}"
  return (try? K2ApprovalPayload.parse(K2ApprovalPayload.prefix + Array(json.utf8)).promptReason) ?? "refused"
}
check(reason("k2.delete") == "Approve a delete for k2sign@z3mbpZ", "reason k2.delete: \(reason("k2.delete"))")
check(reason("k2.send") == "Approve a send for k2sign@z3mbpZ", "reason k2.send")
check(reason("k2.device.add") == "Approve a new device for k2sign@z3mbpZ", "reason k2.device.add")
check(reason("k2.confirm") == "Approve this for k2sign@z3mbpZ", "reason k2.confirm")
check(reason("com.example.refund") == "Approve a com.example.refund request for k2sign@z3mbpZ", "reason unknown kind")
if let r = try? K2ApprovalPayload.parse(file("payloads/valid/release.bin")) {
  check(r.promptReason == "Approve K2 release 0.46.13 for k2sign@build-mac", "reason release: \(r.promptReason)")
}

print("ApprovalCheck: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
