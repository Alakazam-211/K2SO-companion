// Signed approvals (K2 PRD prd-signed-approvals-v1, wire contract
// contract-signed-approvals-wire-v1): the phone's own strict reader for
// `"K2-SIGNED-APPROVAL-1" 0x00 <JSON>` and the words the approval screen
// shows. A port of K2's `k2-approve` crate (json.rs, payload.rs,
// describe.rs, time.rs at 6d56666c1); the shared fixtures
// (`ApprovalCheck/sa1`, `swift run ApprovalCheck`) hold both to the same
// answers.
//
// Foundation only, no UIKit: the plugin uses it on iOS and the check runs
// it on macOS. Nothing here re-writes the bytes: the phone signs exactly
// what it received (SA-3). JSONSerialization is never used on a payload:
// it keeps one of a repeated key and loses the written order.

import Foundation

public enum K2ApprovalCode: String {
  case tooLarge = "too_large"
  case prefix
  case utf8
  case json
  case duplicateKey = "duplicate_key"
  case forbiddenChar = "forbidden_char"
  case notInteger = "not_integer"
  case notObject = "not_object"
  case unknownField = "unknown_field"
  case missingField = "missing_field"
  case fieldType = "field_type"
  case fieldFormat = "field_format"
  case bodyValue = "body_value"
  case times
  case shape
}

public struct K2ApprovalRefusal: Error, CustomStringConvertible {
  public let code: K2ApprovalCode
  public let message: String
  public var description: String { "\(code.rawValue): \(message)" }
}

private func refuse<T>(_ code: K2ApprovalCode, _ message: String) throws -> T {
  throw K2ApprovalRefusal(code: code, message: message)
}

// ── Strict JSON (json.rs) ─────────────────────────────────────────────

public indirect enum K2JSON: Equatable {
  case null
  case bool(Bool)
  case int(Int64)
  case str(String)
  case arr([K2JSON])
  case obj([(String, K2JSON)])

  public static func == (a: K2JSON, b: K2JSON) -> Bool {
    switch (a, b) {
    case (.null, .null): return true
    case let (.bool(x), .bool(y)): return x == y
    case let (.int(x), .int(y)): return x == y
    case let (.str(x), .str(y)): return sameBytes(x, y)
    case let (.arr(x), .arr(y)): return x == y
    case let (.obj(x), .obj(y)):
      return x.count == y.count && zip(x, y).allSatisfy { sameBytes($0.0, $1.0) && $0.1 == $1.1 }
    default: return false
    }
  }

  var typeName: String {
    switch self {
    case .null: return "null"
    case .bool: return "true/false"
    case .int: return "a whole number"
    case .str: return "a string"
    case .arr: return "a list"
    case .obj: return "an object"
    }
  }
}

/// Swift's `==` on String is canonical equivalence ("é" == "e\u{301}");
/// the contract compares code points, as Rust does.
@inline(__always) func sameBytes(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

public enum K2StrictJSON {
  public static let maxDepth = 8
  public static let maxInt: Int64 = 9_007_199_254_740_991

  /// The contract's forbidden code points (§2): controls, direction marks
  /// and overrides, invisible and zero-width characters, fillers, variation
  /// selectors, tags, surrogates and noncharacters.
  public static func forbidden(_ cp: UInt32) -> Bool {
    switch cp {
    case 0x0000...0x001F, 0x007F...0x009F, 0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5,
      0x180B...0x180F, 0x200B...0x200F, 0x2028...0x202E, 0x2060...0x206F, 0x3164, 0xD800...0xDFFF,
      0xFDD0...0xFDEF, 0xFE00...0xFE0F, 0xFEFF, 0xFFA0, 0xFFF0...0xFFFB, 0x1BCA0...0x1BCA3,
      0x1D173...0x1D17A, 0xE0000...0xE0FFF:
      return true
    default:
      return (cp & 0xFFFE) == 0xFFFE
    }
  }

  /// Strict UTF-8 (no overlongs, no encoded surrogates, ≤ U+10FFFF), as
  /// Rust's `str::from_utf8`. Returns the offset of the first bad byte.
  public static func firstInvalidUTF8(_ b: [UInt8]) -> Int? {
    var i = 0
    while i < b.count {
      let c = b[i]
      if c < 0x80 {
        i += 1
        continue
      }
      var need = 0
      var lo: UInt8 = 0x80
      var hi: UInt8 = 0xBF
      switch c {
      case 0xC2...0xDF: need = 1
      case 0xE0: need = 2; lo = 0xA0
      case 0xE1...0xEC, 0xEE...0xEF: need = 2
      case 0xED: need = 2; hi = 0x9F
      case 0xF0: need = 3; lo = 0x90
      case 0xF1...0xF3: need = 3
      case 0xF4: need = 3; hi = 0x8F
      default: return i
      }
      if i + need >= b.count { return i }
      if b[i + 1] < lo || b[i + 1] > hi { return i }
      for k in 2..<(need + 1) where b[i + k] < 0x80 || b[i + k] > 0xBF { return i }
      i += need + 1
    }
    return nil
  }

  /// Parse one JSON value from bytes already checked to be UTF-8.
  public static func parse(_ bytes: [UInt8]) throws -> K2JSON {
    var p = Parser(b: bytes)
    p.ws()
    let v = try p.value(0)
    p.ws()
    if p.i != bytes.count { return try refuse(.json, "text after the JSON value at byte \(p.i)") }
    return v
  }

  struct Parser {
    let b: [UInt8]
    var i = 0

    init(b: [UInt8]) { self.b = b }

    func at(_ k: Int) -> UInt8? { k < b.count ? b[k] : nil }

    mutating func ws() {
      while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0A || b[i] == 0x0D { i += 1 }
    }

    func syntax<T>(_ what: String) throws -> T { try refuse(.json, "\(what) at byte \(i)") }

    mutating func value(_ depth: Int) throws -> K2JSON {
      if depth >= K2StrictJSON.maxDepth { return try syntax("nested too deep") }
      guard let c = at(i) else { return try syntax("unexpected end") }
      switch c {
      case UInt8(ascii: "{"): return try object(depth)
      case UInt8(ascii: "["): return try array(depth)
      case UInt8(ascii: "\""): return .str(try string())
      case UInt8(ascii: "t"): return try literal("true", .bool(true))
      case UInt8(ascii: "f"): return try literal("false", .bool(false))
      case UInt8(ascii: "n"): return try literal("null", .null)
      case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try number()
      default: return try syntax("not a JSON value")
      }
    }

    mutating func literal(_ word: String, _ v: K2JSON) throws -> K2JSON {
      let w = Array(word.utf8)
      if i + w.count <= b.count, Array(b[i..<(i + w.count)]) == w {
        i += w.count
        return v
      }
      return try syntax("not a JSON value")
    }

    mutating func object(_ depth: Int) throws -> K2JSON {
      i += 1
      var out: [(String, K2JSON)] = []
      ws()
      if at(i) == UInt8(ascii: "}") {
        i += 1
        return .obj(out)
      }
      while true {
        ws()
        if at(i) != UInt8(ascii: "\"") { return try syntax("expected a key") }
        let k = try string()
        if out.contains(where: { sameBytes($0.0, k) }) {
          return try refuse(.duplicateKey, "the key \"\(k)\" appears twice in one object")
        }
        ws()
        if at(i) != UInt8(ascii: ":") { return try syntax("expected ':'") }
        i += 1
        ws()
        let v = try value(depth + 1)
        out.append((k, v))
        ws()
        switch at(i) {
        case UInt8(ascii: ","): i += 1
        case UInt8(ascii: "}"):
          i += 1
          return .obj(out)
        default: return try syntax("expected ',' or '}'")
        }
      }
    }

    mutating func array(_ depth: Int) throws -> K2JSON {
      i += 1
      var out: [K2JSON] = []
      ws()
      if at(i) == UInt8(ascii: "]") {
        i += 1
        return .arr(out)
      }
      while true {
        ws()
        out.append(try value(depth + 1))
        ws()
        switch at(i) {
        case UInt8(ascii: ","): i += 1
        case UInt8(ascii: "]"):
          i += 1
          return .arr(out)
        default: return try syntax("expected ',' or ']'")
        }
      }
    }

    func isDigit(_ k: Int) -> Bool {
      guard let c = at(k) else { return false }
      return c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
    }

    mutating func number() throws -> K2JSON {
      let start = i
      if b[i] == UInt8(ascii: "-") { i += 1 }
      let digits = i
      if at(i) == UInt8(ascii: "0") {
        i += 1
      } else if isDigit(i) {
        while isDigit(i) { i += 1 }
      } else {
        return try syntax("a number needs digits")
      }
      let intEnd = i
      var whole = true
      if at(i) == UInt8(ascii: ".") {
        i += 1
        if !isDigit(i) { return try syntax("a fraction needs digits") }
        while isDigit(i) { i += 1 }
        whole = false
      }
      if at(i) == UInt8(ascii: "e") || at(i) == UInt8(ascii: "E") {
        i += 1
        if at(i) == UInt8(ascii: "+") || at(i) == UInt8(ascii: "-") { i += 1 }
        if !isDigit(i) { return try syntax("an exponent needs digits") }
        while isDigit(i) { i += 1 }
        whole = false
      }
      let tok = String(decoding: b[start..<i], as: UTF8.self)
      if !whole { return try refuse(.notInteger, "\(tok) is not a whole number (money is a string: \"125.00 USD\")") }
      if tok == "-0" { return try refuse(.notInteger, "-0 is not allowed (write 0)") }
      if intEnd - digits > 16 { return try refuse(.notInteger, "\(tok) is outside ±(2^53 − 1)") }
      guard let n = Int64(tok), n >= -K2StrictJSON.maxInt, n <= K2StrictJSON.maxInt else {
        return try refuse(.notInteger, "\(tok) is outside ±(2^53 − 1)")
      }
      return .int(n)
    }

    mutating func hex4() throws -> UInt32 {
      guard i + 4 <= b.count else { return try refuse(.json, "short \\u escape") }
      var v: UInt32 = 0
      for k in i..<(i + 4) {
        let c = b[k]
        let d: UInt32
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): d = UInt32(c - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): d = UInt32(c - UInt8(ascii: "a") + 10)
        case UInt8(ascii: "A")...UInt8(ascii: "F"): d = UInt32(c - UInt8(ascii: "A") + 10)
        default: return try refuse(.json, "bad \\u escape at byte \(i)")
        }
        v = v * 16 + d
      }
      i += 4
      return v
    }

    static func push(_ out: inout String.UnicodeScalarView, _ cp: UInt32) throws {
      if K2StrictJSON.forbidden(cp) {
        return try refuse(
          .forbiddenChar, "a string holds U+\(String(format: "%04X", cp)), which is not allowed in a signed approval")
      }
      guard let s = Unicode.Scalar(cp) else {
        return try refuse(.forbiddenChar, "U+\(String(format: "%04X", cp)) is not a character")
      }
      out.append(s)
    }

    /// One UTF-8 character starting at `i` (the bytes are valid UTF-8).
    mutating func utf8Scalar() -> UInt32 {
      let c = b[i]
      if c < 0x80 {
        i += 1
        return UInt32(c)
      }
      let n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : 2
      var v = UInt32(c) & (n == 2 ? 0x1F : n == 3 ? 0x0F : 0x07)
      for k in 1..<n { v = (v << 6) | (UInt32(b[i + k]) & 0x3F) }
      i += n
      return v
    }

    mutating func string() throws -> String {
      i += 1
      var out = String.UnicodeScalarView()
      while true {
        guard let c = at(i) else { return try syntax("unterminated string") }
        switch c {
        case UInt8(ascii: "\""):
          i += 1
          return String(out)
        case UInt8(ascii: "\\"):
          i += 1
          guard let e = at(i) else { return try syntax("unterminated escape") }
          i += 1
          switch e {
          case UInt8(ascii: "\""): out.append("\"")
          case UInt8(ascii: "\\"): out.append("\\")
          case UInt8(ascii: "/"): out.append("/")
          case UInt8(ascii: "b"): try Self.push(&out, 0x08)
          case UInt8(ascii: "f"): try Self.push(&out, 0x0C)
          case UInt8(ascii: "n"): try Self.push(&out, 0x0A)
          case UInt8(ascii: "r"): try Self.push(&out, 0x0D)
          case UInt8(ascii: "t"): try Self.push(&out, 0x09)
          case UInt8(ascii: "u"):
            let hi = try hex4()
            var cp = hi
            if (0xD800...0xDBFF).contains(hi), at(i) == UInt8(ascii: "\\"), at(i + 1) == UInt8(ascii: "u") {
              let save = i
              i += 2
              let lo = try hex4()
              if (0xDC00...0xDFFF).contains(lo) {
                cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
              } else {
                i = save  // a high surrogate alone: refused below
              }
            }
            try Self.push(&out, cp)
          default: return try syntax("unknown escape")
          }
        default:
          let cp = utf8Scalar()
          try Self.push(&out, cp)
        }
      }
    }
  }
}

// ── Times (time.rs) ───────────────────────────────────────────────────

public enum K2ApprovalTime {
  /// Seconds since 1970 for exactly `YYYY-MM-DDTHH:MM:SSZ`, years
  /// 2000–9999, real dates only; else nil.
  public static func parseUTC(_ s: String) -> Int64? {
    let b = Array(s.utf8)
    guard b.count == 20, b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x54, b[13] == 0x3A, b[16] == 0x3A, b[19] == 0x5A
    else { return nil }
    func num(_ r: Range<Int>) -> Int64? {
      var v: Int64 = 0
      for k in r {
        guard b[k] >= 0x30, b[k] <= 0x39 else { return nil }
        v = v * 10 + Int64(b[k] - 0x30)
      }
      return v
    }
    guard let y = num(0..<4), let mo = num(5..<7), let d = num(8..<10), let h = num(11..<13), let mi = num(14..<16),
      let se = num(17..<19)
    else { return nil }
    guard (2000...9999).contains(y), (1...12).contains(mo), d >= 1, d <= daysInMonth(y, mo), h <= 23, mi <= 59, se <= 59
    else { return nil }
    return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se
  }

  /// `2026-11-12T02:00:00Z` → `2026-11-12 02:00:00 UTC`.
  public static func display(_ s: String) -> String {
    let b = Array(s.utf8)
    guard b.count == 20 else { return s }
    return String(decoding: b[0..<10], as: UTF8.self) + " " + String(decoding: b[11..<19], as: UTF8.self) + " UTC"
  }

  static func leap(_ y: Int64) -> Bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

  static func daysInMonth(_ y: Int64, _ m: Int64) -> Int64 {
    switch m {
    case 1, 3, 5, 7, 8, 10, 12: return 31
    case 4, 6, 9, 11: return 30
    default: return leap(y) ? 29 : 28
    }
  }

  static func daysFromCivil(_ y0: Int64, _ m: Int64, _ d: Int64) -> Int64 {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (m + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
  }
}

// ── Payload (payload.rs) ──────────────────────────────────────────────

public enum K2ApprovalBodyValue: Equatable {
  case str(String)
  case int(Int64)
  case bool(Bool)
  case list([String])
}

public struct K2ApprovalPayload {
  public static let prefix: [UInt8] = Array("K2-SIGNED-APPROVAL-1".utf8) + [0]
  public static let maxBytes = 16384
  public static let fields = [
    "kind", "kind_v", "rp", "approver", "approver_keys", "nonce", "issued", "answer_by", "body",
  ]
  public static let releaseFields = [
    "version", "base_commit", "assets", "slots", "windows", "reapproval", "replacement", "replaces_base",
    "max_signatures", "session_until",
  ]

  /// The exact bytes, prefix included: what is shown, signed and posted.
  public let bytes: [UInt8]
  public let kind: String
  public let kindV: Int64
  public let rp: String
  public let approver: String
  public let approverKeys: [String]
  public let nonce: String
  public let issued: String
  public let issuedAt: Int64
  public let answerBy: String
  public let answerByAt: Int64
  /// In the order written.
  public let body: [(String, K2ApprovalBodyValue)]

  public func bodyField(_ name: String) -> K2ApprovalBodyValue? {
    body.first(where: { sameBytes($0.0, name) })?.1
  }

  public var isKnownKind: Bool { kind == "k2.release" }

  // MARK: parse

  public static func parse(_ data: Data) throws -> K2ApprovalPayload { try parse(Array(data)) }

  public static func parse(_ bytes: [UInt8]) throws -> K2ApprovalPayload {
    if bytes.count > maxBytes { return try refuse(.tooLarge, "\(bytes.count) bytes; a payload is at most \(maxBytes)") }
    guard bytes.count >= prefix.count, Array(bytes[0..<prefix.count]) == prefix else {
      return try refuse(.prefix, "the bytes do not start with K2-SIGNED-APPROVAL-1 and a zero byte")
    }
    let rest = Array(bytes[prefix.count...])
    if let bad = K2StrictJSON.firstInvalidUTF8(rest) {
      return try refuse(.utf8, "not UTF-8 at byte \(prefix.count + bad)")
    }
    guard case let .obj(top) = try K2StrictJSON.parse(rest) else {
      return try refuse(.notObject, "the JSON is not one object")
    }
    for (k, _) in top where !fields.contains(where: { sameBytes($0, k) }) {
      return try refuse(.unknownField, "unknown field \"\(k)\"")
    }
    for f in fields where !top.contains(where: { sameBytes($0.0, f) }) {
      return try refuse(.missingField, "missing field \(f)")
    }
    func get(_ f: String) -> K2JSON { top.first(where: { sameBytes($0.0, f) })!.1 }
    func wantStr(_ name: String, _ v: K2JSON) throws -> String {
      if case let .str(s) = v { return s }
      return try refuse(.fieldType, "\(name) must be a string, not \(v.typeName)")
    }
    func wantName(_ name: String) throws -> String {
      let s = try wantStr(name, get(name))
      if s.utf8.isEmpty || s.utf8.count > 128 { return try refuse(.fieldFormat, "\(name) must be 1 to 128 bytes") }
      return s
    }
    func wantTime(_ name: String) throws -> (String, Int64) {
      let s = try wantStr(name, get(name))
      guard let t = K2ApprovalTime.parseUTC(s) else {
        return try refuse(.fieldFormat, "\(name) must be a UTC time like 2026-11-11T14:00:00Z, not \"\(s)\"")
      }
      return (s, t)
    }

    let kind = try wantStr("kind", get("kind"))
    if !kindOK(kind) { return try refuse(.fieldFormat, "kind \"\(kind)\" must look like k2.release or com.example.refund") }
    guard case let .int(kindV) = get("kind_v") else {
      return try refuse(.fieldType, "kind_v must be a whole number, not \(get("kind_v").typeName)")
    }
    if !(1...65535).contains(kindV) { return try refuse(.fieldFormat, "kind_v must be 1 to 65535") }
    let rp = try wantName("rp")
    let approver = try wantName("approver")
    var keys: [String] = []
    guard case let .arr(items) = get("approver_keys") else {
      return try refuse(.fieldType, "approver_keys must be a list, not \(get("approver_keys").typeName)")
    }
    for it in items {
      guard case let .str(s) = it else {
        return try refuse(.fieldType, "approver_keys holds \(it.typeName), not a key id")
      }
      if !isHexLower(s, 64) { return try refuse(.fieldFormat, "approver_keys: \"\(s)\" is not a key id (64 lowercase hex)") }
      if keys.contains(s) { return try refuse(.fieldFormat, "approver_keys lists \(s) twice") }
      keys.append(s)
    }
    if keys.isEmpty || keys.count > 16 { return try refuse(.fieldFormat, "approver_keys must list 1 to 16 keys") }
    let nonce = try wantStr("nonce", get("nonce"))
    if !isHexLower(nonce, 32) { return try refuse(.fieldFormat, "nonce must be 32 lowercase hex") }
    let (issued, issuedAt) = try wantTime("issued")
    let (answerBy, answerByAt) = try wantTime("answer_by")
    guard case let .obj(fieldsIn) = get("body") else {
      return try refuse(.fieldType, "body must be an object, not \(get("body").typeName)")
    }
    if fieldsIn.count > 64 { return try refuse(.fieldFormat, "body has more than 64 fields") }
    var body: [(String, K2ApprovalBodyValue)] = []
    for (k, v) in fieldsIn {
      if !bodyKeyOK(k) {
        return try refuse(
          .fieldFormat, "body field name \"\(k)\" must be lowercase letters, digits and _ (starting with a letter)")
      }
      switch v {
      case let .str(s): body.append((k, .str(s)))
      case let .int(n): body.append((k, .int(n)))
      case let .bool(x): body.append((k, .bool(x)))
      case let .arr(list):
        var l: [String] = []
        for it in list {
          guard case let .str(s) = it else {
            return try refuse(.bodyValue, "body.\(k) lists \(it.typeName); a body list holds strings only")
          }
          l.append(s)
        }
        if l.count > 256 { return try refuse(.fieldFormat, "body.\(k) lists more than 256 items") }
        body.append((k, .list(l)))
      default:
        return try refuse(
          .bodyValue, "body.\(k) is \(v.typeName); body is flat (string, whole number, true/false, list of strings)")
      }
    }
    if answerByAt <= issuedAt { return try refuse(.times, "answer_by must be after issued") }
    let p = K2ApprovalPayload(
      bytes: bytes, kind: kind, kindV: kindV, rp: rp, approver: approver, approverKeys: keys, nonce: nonce,
      issued: issued, issuedAt: issuedAt, answerBy: answerBy, answerByAt: answerByAt, body: body)
    try p.checkKnown()
    return p
  }

  static func isHexLower(_ s: String, _ n: Int) -> Bool {
    let b = Array(s.utf8)
    return b.count == n && b.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
  }

  static func lowerOrDigit(_ c: UInt8) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) }

  static func kindOK(_ s: String) -> Bool {
    let b = Array(s.utf8)
    if b.isEmpty || b.count > 64 { return false }
    let parts = b.split(separator: 0x2E, omittingEmptySubsequences: false)
    guard let first = parts.first, !first.isEmpty, first.allSatisfy(lowerOrDigit) else { return false }
    if parts.count < 2 { return false }
    return parts.dropFirst().allSatisfy { !$0.isEmpty && $0.allSatisfy { lowerOrDigit($0) || $0 == 0x2D } }
  }

  static func bodyKeyOK(_ s: String) -> Bool {
    let b = Array(s.utf8)
    return !b.isEmpty && b.count <= 64 && b[0] >= 0x61 && b[0] <= 0x7A
      && b.allSatisfy { lowerOrDigit($0) || $0 == 0x5F }
  }

  static func versionOK(_ s: String) -> Bool {
    let parts = Array(s.utf8).split(separator: 0x2E, omittingEmptySubsequences: false)
    return parts.count == 3
      && parts.allSatisfy { p in
        !p.isEmpty && p.count <= 6 && p.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } && (p.count == 1 || p.first != 0x30)
      }
  }

  /// A K2 release file name: ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.
  static func assetOK(_ s: String) -> Bool {
    let b = Array(s.utf8)
    func alnum(_ c: UInt8) -> Bool { lowerOrDigit(c) || (c >= 0x41 && c <= 0x5A) }
    return !b.isEmpty && b.count <= 128 && alnum(b[0]) && b.allSatisfy { alnum($0) || $0 == 0x2E || $0 == 0x5F || $0 == 0x2D }
  }

  /// A known kind whose body doesn't match its shape exactly is refused.
  func checkKnown() throws {
    guard kind == "k2.release" else { return }
    func shape(_ d: String) throws { try refuse(.shape, "k2.release: \(d)") as Void }
    if kindV != 1 { return try shape("version \(kindV) is not one this reader knows (1)") }
    for (k, _) in body where !Self.releaseFields.contains(where: { sameBytes($0, k) }) {
      return try shape("unexpected body field \(k)")
    }
    for f in Self.releaseFields where bodyField(f) == nil { return try shape("body field \(f) is missing") }
    func s(_ f: String) -> String? { if case let .str(v) = bodyField(f) { return v } else { return nil } }
    func list(_ f: String) -> [String]? { if case let .list(v) = bodyField(f) { return v } else { return nil } }
    func isBool(_ f: String) -> Bool { if case .bool = bodyField(f) { return true } else { return false } }
    func yes(_ f: String) -> Bool { bodyField(f) == .bool(true) }
    guard let v = s("version"), Self.versionOK(v) else { return try shape("version must be like 0.46.13") }
    guard let bc = s("base_commit"), Self.isHexLower(bc, 40) else { return try shape("base_commit must be 40 lowercase hex") }
    guard let a = list("assets"), !a.isEmpty, a.allSatisfy(Self.assetOK),
      a.enumerated().allSatisfy({ i, x in !a[..<i].contains(where: { sameBytes($0, x) }) })
    else { return try shape("assets must list one or more file names, each once") }
    guard let sl = list("slots"), !sl.isEmpty,
      sl.allSatisfy({ !$0.utf8.isEmpty && $0.utf8.count <= 8 && $0.utf8.allSatisfy(Self.lowerOrDigit) })
    else { return try shape("slots must list one or more key slots") }
    if !isBool("windows") || !isBool("reapproval") || !isBool("replacement") {
      return try shape("windows, reapproval and replacement must be true or false")
    }
    switch s("replaces_base") {
    case .some(let rb) where rb.isEmpty: break
    case .some(let rb) where yes("replacement") && Self.isHexLower(rb, 40): break
    default: return try shape("replaces_base must be \"\" or, for a replacement, 40 lowercase hex")
    }
    if yes("replacement") && yes("reapproval") { return try shape("replacement and reapproval are not both true") }
    guard case let .int(ms) = bodyField("max_signatures"), (1...100_000).contains(ms) else {
      return try shape("max_signatures must be a whole number from 1")
    }
    guard let su = s("session_until"), K2ApprovalTime.parseUTC(su) != nil else {
      return try shape("session_until must be a UTC time")
    }
  }

  // MARK: screen text (describe.rs)

  public static let unknownKindLine = "K2 has no built-in wording for this kind. Every field is shown below."

  /// The shared screen text (§5), one entry per line. The device adds its
  /// own line about which device and check will sign.
  public var lines: [String] {
    var out: [String] = []
    if kind == "k2.release" { releaseLines(&out) } else { genericLines(&out) }
    out.append("")
    out.append("Who will act: \(rp)")
    out.append("Asked: \(approver)")
    out.append("Answer by: \(K2ApprovalTime.display(answerBy))")
    return out
  }

  /// The lines joined by "\n", ending in "\n" (the fixtures' `.txt`).
  public var text: String { lines.joined(separator: "\n") + "\n" }

  func releaseLines(_ out: inout [String]) {
    func s(_ f: String) -> String { if case let .str(v) = bodyField(f) { return v } else { return "" } }
    func yes(_ f: String) -> Bool { bodyField(f) == .bool(true) }
    var assets = ""
    if case let .list(l) = bodyField("assets") { assets = l.joined(separator: ", ") }
    if yes("replacement") {
      let old = s("replaces_base")
      out.append(
        old.isEmpty
          ? "RE-APPROVE for new code: an earlier approval of \(s("version")) was never used."
          : "RE-APPROVE for new code: the earlier approval for base commit \(old) was never used.")
    }
    let re = yes("reapproval") ? "RE-APPROVE: " : ""
    out.append("\(re)Approve K2 release \(s("version")) at base commit \(s("base_commit")).")
    out.append("Sign: \(assets).")
    out.append(yes("windows") ? "Windows setup: yes, with no independent check." : "Windows setup: no.")
    out.append("Signing stays open until \(K2ApprovalTime.display(s("session_until"))).")
  }

  func genericLines(_ out: inout [String]) {
    out.append(Self.unknownKindLine)
    out.append("Kind: \(kind) (version \(kindV))")
    // Sorted by name in byte order, so readers that lose the order agree.
    let sorted = body.sorted { $0.0.utf8.lexicographicallyPrecedes($1.0.utf8) }
    for (k, v) in sorted {
      switch v {
      case let .str(s): out.append("\(k): \(s)")
      case let .int(n): out.append("\(k): \(n)")
      case let .bool(x): out.append("\(k): \(x ? "true" : "false")")
      case let .list(l) where l.isEmpty: out.append("\(k): (none)")
      case let .list(l):
        out.append("\(k):")
        for it in l { out.append("  - \(it)") }
      }
    }
  }

  /// A short line for the system check's prompt (Touch ID and passcode
  /// prompts show it; Face ID shows none). Built from the bytes only.
  /// Wording: K2 Design 11-11. Known kinds by plain name; any other kind
  /// keeps its id, as a request. `rp` stays exact: it is what the person
  /// checks.
  public var promptReason: String {
    if kind == "k2.release", case let .str(v) = bodyField("version") {
      return "Approve K2 release \(v) for \(rp)"
    }
    let names = ["k2.delete": "a delete", "k2.send": "a send", "k2.device.add": "a new device", "k2.confirm": "this"]
    if let name = names[kind] { return "Approve \(name) for \(rp)" }
    return "Approve a \(kind) request for \(rp)"
  }
}

// ── The approval record (§7) and key ids (§8) ────────────────────────

public enum K2ApprovalRecord {
  /// `{"v":1,"payload_b64":…,"key_id":…,"alg":"ES256","sig_b64":…}`,
  /// compact, the contract's field order. Base64 is standard with padding.
  public static func json(payload: [UInt8], keyId: String, signatureDER: Data) -> String {
    let p = Data(payload).base64EncodedString()
    let s = signatureDER.base64EncodedString()
    return "{\"v\":1,\"payload_b64\":\"\(p)\",\"key_id\":\"\(keyId)\",\"alg\":\"ES256\",\"sig_b64\":\"\(s)\"}"
  }
}

public enum K2ApprovalKeyId {
  /// The fixed DER SubjectPublicKeyInfo header for a P-256 point.
  public static let spkiHeader: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  /// SPKI DER for a raw 65-byte uncompressed P-256 point.
  public static func spki(rawPoint: Data) -> Data? {
    rawPoint.count == 65 && rawPoint.first == 0x04 ? Data(spkiHeader) + rawPoint : nil
  }

  /// key id = lowercase hex sha256(SPKI DER).
  public static func keyId(spki: Data) -> String {
    K2SHA256.hash(spki).map { String(format: "%02x", $0) }.joined()
  }

  /// Six words for the key id's first six bytes (wordlist line n = byte n).
  public static func words(keyId: String) -> String {
    let b = Array(keyId.utf8)
    guard b.count >= 12 else { return "" }
    var out: [String] = []
    for k in 0..<6 {
      let pair = String(decoding: b[(2 * k)..<(2 * k + 2)], as: UTF8.self)
      guard let n = UInt8(pair, radix: 16) else { return "" }
      out.append(K2ApprovalWords.list[Int(n)])
    }
    return out.joined(separator: " ")
  }

  public static func pem(spki: Data) -> String {
    let b64 = spki.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN PUBLIC KEY-----\n\(b64)\n-----END PUBLIC KEY-----\n"
  }
}
