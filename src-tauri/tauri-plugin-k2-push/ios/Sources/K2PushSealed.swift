// Sealed pushes → today's shapes (K2 0.46.3 `push-e2e-v1`, prd §7.3). ONE
// source shared by the k2-push plugin and the Notification Service
// Extension (project.yml).
//
// A sealed push arrives as `{kind:"e2e"|"nudge", v:"1", e2e:"<base64url>"}`
// (alerts also carry the constant "K2 / New message"). `unseal` opens it
// with this phone's keys (K2PushKeys), checks it is fresh (K2PushReplay)
// and returns what today's plaintext push would have carried: the title,
// body and group, and a `userInfo` with today's keys (the sealed `data`
// plus `subdomain`, `instanceId`, `badgeKey`), so the badge store, the
// avatar lookup and the tap router are reused unchanged.
//
// Diagnostics (TestFlight / internal builds read them): the last 20
// sealed pushes — key names, `e2e` length, the result, `ctr`, server —
// never any decrypted text, `e2e` or key.

import Foundation

public enum K2PushSealed {
  public struct Unsealed {
    public let title: String
    public let body: String
    /// `thread:<conversationId>` etc.: the notification's threadIdentifier.
    public let group: String
    /// Today's keys (all strings).
    public let userInfo: [String: Any]
    public let keyId: String
    /// K2 0.46.3 sealed Thread alerts: the message itself
    /// `{id, seq, conversationId, from, at, kind, text, truncated}`; nil
    /// for tickets, projects and older daemons.
    public let msg: [String: Any]?
  }

  public enum Outcome: String, Error {
    case ok
    case locked
    case noKey = "no-key"
    case mismatch
    case replay
    case malformed
  }

  /// Is this a sealed push (`kind` e2e / nudge)? Which kind?
  public static func kind(of info: [AnyHashable: Any]) -> K2PushKind? {
    switch info["kind"] as? String {
    case "e2e": return .alert
    case "nudge": return .nudge
    default: return nil
    }
  }

  public static func unseal(_ info: [AnyHashable: Any], now: Date = Date()) -> Result<Unsealed, Outcome> {
    guard let kind = kind(of: info), let e2e = info["e2e"] as? String else { return .failure(.malformed) }
    let result: Result<Unsealed, Outcome>
    switch K2PushKeys.open(e2e: e2e, kind: kind) {
    case .failure(.locked): result = .failure(.locked)
    case .failure(.noKey): result = .failure(.noKey)
    case .failure(.mismatch): result = .failure(.mismatch)
    case .success(let opened):
      result = shape(opened, now: now)
    }
    record(info: info, kind: kind, outcome: result)
    return result
  }

  static func shape(_ o: K2PushKeys.Opened, now: Date) -> Result<Unsealed, Outcome> {
    let j = o.json
    guard let ctr = (j["ctr"] as? NSNumber)?.uint64Value, let ts = (j["ts"] as? NSNumber)?.doubleValue else {
      return .failure(.malformed)
    }
    guard K2PushReplay.accept(keyId: o.record.keyId, ctr: ctr, ts: ts, now: now.timeIntervalSince1970) else {
      return .failure(.replay)
    }
    var info: [String: Any] = [:]
    if let data = j["data"] as? [String: Any] {
      for (k, v) in data {
        if let s = v as? String { info[k] = s } else if let n = v as? NSNumber { info[k] = n.stringValue }
      }
    }
    let srv = j["srv"] as? [String: Any] ?? [:]
    info["subdomain"] = (srv["sub"] as? String) ?? o.record.subdomain
    if let iid = srv["iid"] as? String { info["instanceId"] = iid }
    if let bk = j["bk"] as? String { info["badgeKey"] = bk }
    if info["kind"] == nil, let k = j["kind"] as? String { info["kind"] = k }
    return .success(
      Unsealed(
        title: (j["title"] as? String) ?? "K2",
        body: (j["body"] as? String) ?? "",
        group: (j["group"] as? String) ?? "",
        userInfo: info,
        keyId: o.record.keyId,
        msg: j["msg"] as? [String: Any]))
  }

  // ── Diagnostics (no content) ─────────────────────────────────────────

  public static let diagnosticsMax = 20

  static func diagnosticsFile() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: K2PushKeys.appGroup)?
      .appendingPathComponent("push-e2e", isDirectory: true)
      .appendingPathComponent("diagnostics.json")
  }

  static func record(info: [AnyHashable: Any], kind: K2PushKind, outcome: Result<Unsealed, Outcome>) {
    guard let file = diagnosticsFile() else { return }
    var row: [String: Any] = [
      "at": Date().timeIntervalSince1970,
      "kind": kind.rawValue,
      "keys": info.keys.compactMap { $0 as? String }.sorted(),
      "e2eLength": (info["e2e"] as? String)?.count ?? 0,
    ]
    switch outcome {
    case .success(let u):
      row["result"] = Outcome.ok.rawValue
      row["keyId"] = u.keyId
      row["server"] = u.userInfo["subdomain"] as? String ?? ""
    case .failure(let f):
      row["result"] = f.rawValue
    }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forMerging, error: &coordError) { url in
      var rows = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [[String: Any]]) ?? []
      rows.insert(row, at: 0)
      if rows.count > diagnosticsMax { rows.removeLast(rows.count - diagnosticsMax) }
      if let data = try? JSONSerialization.data(withJSONObject: rows) {
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
  }

  public static func diagnostics() -> [[String: Any]] {
    guard let file = diagnosticsFile(), let data = try? Data(contentsOf: file) else { return [] }
    return ((try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]) ?? []
  }

  // ── `enforce` (sealed-only servers, a later stage) ───────────────────

  static let enforceKey = "k2.push.enforce.v1"

  /// The register reply's `e2e.enforce`, per server label (the app sets it).
  public static func setEnforce(subdomain: String, _ on: Bool) {
    guard let d = UserDefaults(suiteName: K2PushKeys.appGroup) else { return }
    var m = d.dictionary(forKey: enforceKey) as? [String: Bool] ?? [:]
    m[subdomain.lowercased()] = on ? true : nil
    d.set(m, forKey: enforceKey)
  }

  /// A plaintext Thread / ticket / project push from a server that is
  /// sealed-only: show it generic.
  public static func enforced(_ info: [AnyHashable: Any]) -> Bool {
    guard let sub = (info["subdomain"] as? String)?.lowercased(), !sub.isEmpty,
      let m = UserDefaults(suiteName: K2PushKeys.appGroup)?.dictionary(forKey: enforceKey) as? [String: Bool]
    else { return false }
    return m[sub] == true
  }
}
