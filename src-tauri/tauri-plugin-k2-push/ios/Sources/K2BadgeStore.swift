// K2 app-icon badge store — ONE implementation shared by two targets:
//   - the app, through the k2-push plugin (this Swift package), and
//   - the Notification Service Extension: gen/apple/project.yml adds this
//     same file to the K2NotificationService target's sources.
// So it may only import Foundation (no Tauri, no UIKit: UIApplication is
// unavailable in an extension). Badge APIs live in the callers.
//
// Layout in the App Group container (group.com.alakazamlabs.k2so.companion):
//   <AppGroup>/badges/totals.json
//     {"version":1,"servers":{"<key>":{"unread":N,"waiting":N,"at":epochMs}}}
//   <AppGroup>/badges/received.json   (delivery diagnostics)
//     {"version":1,"days":{"YYYY-MM-DD":{"<subdomain>":{"silent":N,"alert":N,"lastAt":epochMs}}}}
// Totals key = the push's `badgeKey` (K2 0.46.1: opaque, stable per person
// per server, so two logins on one host get two entries) when present,
// else its tunnel label (`<label>.k2.dev`, lowercased) for older daemons.
// JS picks the same way (badgeTotals.ts: the learned badgeKey, else the
// label) and moves a server off its label once it learns the key.
// Diagnostics stay per tunnel label.
// Badge = sum of `unread` across servers (K2's `unreadTotal` already is
// "unmuted unread + all waiting"). Servers never send `aps.badge`: with
// several servers on one phone only the phone can sum. Totals entries are
// never expired (stale beats wrong-zero); received days are kept 30 days.
//
// Concurrency: the app and the NSE are separate processes writing the same
// files. Every read-modify-write runs inside an NSFileCoordinator write
// (cross-process, serialises writers) and the write itself is
// `.atomic` (temp file + rename), so a reader never sees a torn file.
// An in-process lock serialises callers on different threads too.

import Foundation

enum K2BadgeStore {
  static let appGroupId = "group.com.alakazamlabs.k2so.companion"
  /// Days of delivery diagnostics kept (today included).
  static let diagnosticsDays = 30

  struct ServerTotals: Codable, Equatable {
    var unread: Int
    var waiting: Int
    var at: Int64
  }

  struct Totals: Codable {
    var version: Int
    var servers: [String: ServerTotals]
  }

  struct DayCount: Codable, Equatable {
    var silent: Int
    var alert: Int
    var lastAt: Int64?
  }

  struct Received: Codable {
    var version: Int
    var days: [String: [String: DayCount]]
  }

  enum Source {
    /// A `content-available` `kind:"badge"` push, handled by the app.
    case silent
    /// A Thread / project-chat alert push with totals, handled by the NSE.
    case alert
  }

  /// Totals parsed out of a push payload.
  struct PushTotals: Equatable {
    /// The totals.json key: `badgeKey` when present, else `subdomain`.
    var key: String
    /// The tunnel label (nil when the push carried none / a bad one).
    var subdomain: String?
    var badgeKey: String?
    var unread: Int
    var waiting: Int?
  }

  private static let lock = NSLock()

  // ── Paths ───────────────────────────────────────────────────────────

  static func directory() -> URL? {
    guard
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupId)
    else { return nil }
    return container.appendingPathComponent("badges", isDirectory: true)
  }

  // ── Parsing ─────────────────────────────────────────────────────────

  /// Lowercased, trimmed tunnel label; nil when empty or not a DNS label.
  static func label(_ subdomain: String) -> String? {
    let k = subdomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !k.isEmpty, k.count <= 63,
      k.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-").contains($0) })
    else { return nil }
    return k
  }

  private static let storeKeyChars = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:+/=-")

  /// A totals.json key as given (a badgeKey, or a label JS already
  /// lowercased): trimmed, 1–128 chars of `[A-Za-z0-9._~:+/=-]`, case
  /// kept. Same rule as `normalizeBadgeKey` in JS. nil otherwise.
  static func storeKey(_ raw: String) -> String? {
    let k = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !k.isEmpty, k.count <= 128, k.unicodeScalars.allSatisfy({ storeKeyChars.contains($0) })
    else { return nil }
    return k
  }

  /// The key a JS command names: `key` (new), else `subdomain` (older JS).
  static func commandKey(key: String?, subdomain: String?) -> String? {
    if let k = key.flatMap(storeKey) { return k }
    return subdomain.flatMap(label)
  }

  /// A non-negative integer from a push value: K2 sends strings ("3"),
  /// numbers are accepted too. Anything else = nil.
  static func count(_ value: Any?) -> Int? {
    if let s = value as? String {
      guard let n = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)), n >= 0 else { return nil }
      return n
    }
    if let n = value as? NSNumber {
      // Bool bridges to NSNumber too; a boolean is not a count.
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
      let d = n.doubleValue
      guard d >= 0, d == d.rounded(), d < Double(Int32.max) else { return nil }
      return n.intValue
    }
    return nil
  }

  /// `{badgeKey?, subdomain?, unreadTotal, waitingTotal?}` from a push's
  /// userInfo (custom keys at the top level). Keyed by `badgeKey` when it
  /// is usable, else by `subdomain`. nil = no usable totals or key.
  static func totals(fromPush info: [AnyHashable: Any]) -> PushTotals? {
    guard let unread = count(info["unreadTotal"]) else { return nil }
    let sub = (info["subdomain"] as? String).flatMap(label)
    let badgeKey = (info["badgeKey"] as? String).flatMap(storeKey)
    guard let key = badgeKey ?? sub else { return nil }
    return PushTotals(
      key: key, subdomain: sub, badgeKey: badgeKey, unread: unread,
      waiting: count(info["waitingTotal"]))
  }

  static func sum(_ totals: Totals) -> Int {
    totals.servers.values.reduce(0) { $0 + max(0, $1.unread) }
  }

  static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

  // ── Totals ──────────────────────────────────────────────────────────

  /// Set one server's totals under `key` (a badgeKey or a tunnel label);
  /// `waiting` nil keeps the stored value. Returns the new badge sum, or
  /// nil when there is no App Group.
  @discardableResult
  static func set(key raw: String, unread: Int, waiting: Int?, now: Int64 = nowMs()) -> Int? {
    guard let key = storeKey(raw) else { return currentSum() }
    return mutateTotals { totals in
      let prev = totals.servers[key]
      totals.servers[key] = ServerTotals(
        unread: max(0, unread), waiting: max(0, waiting ?? prev?.waiting ?? 0), at: now)
    }
  }

  /// Drop one entry (server removed / signed out, or moved to a new key).
  /// Returns the new sum.
  @discardableResult
  static func clear(key raw: String) -> Int? {
    guard let key = storeKey(raw) else { return currentSum() }
    return mutateTotals { totals in
      totals.servers[key] = nil
    }
  }

  /// The stored totals (empty when the file is missing or unreadable),
  /// or nil when there is no App Group.
  static func snapshot() -> Totals? {
    guard let dir = directory() else { return nil }
    lock.lock()
    defer { lock.unlock() }
    var out = Totals(version: 1, servers: [:])
    coordinatedRead(dir.appendingPathComponent("totals.json")) { data in
      if let data = data, let t = try? JSONDecoder().decode(Totals.self, from: data) { out = t }
    }
    return out
  }

  static func currentSum() -> Int? {
    snapshot().map(sum)
  }

  // ── Received counters (delivery diagnostics) ───────────────────────

  /// Count one received push for `subdomain` on the local day. A
  /// duplicate delivery (same collapse id) simply counts again.
  static func recordReceived(subdomain: String, source: Source, now: Date = Date()) {
    guard let key = label(subdomain), let dir = directory() else { return }
    lock.lock()
    defer { lock.unlock() }
    let file = dir.appendingPathComponent("received.json")
    coordinatedWrite(file) { data in
      var rec = data.flatMap { try? JSONDecoder().decode(Received.self, from: $0) }
        ?? Received(version: 1, days: [:])
      let day = dayKey(now)
      var entry = rec.days[day]?[key] ?? DayCount(silent: 0, alert: 0, lastAt: nil)
      switch source {
      case .silent: entry.silent += 1
      case .alert: entry.alert += 1
      }
      entry.lastAt = Int64((now.timeIntervalSince1970 * 1000).rounded())
      rec.days[day, default: [:]][key] = entry
      let cutoff = dayKey(now.addingTimeInterval(-Double(diagnosticsDays - 1) * 86_400))
      rec.days = rec.days.filter { $0.key >= cutoff }
      return try? JSONEncoder().encode(rec)
    }
  }

  /// The received counters (empty when none), or nil without an App Group.
  static func diagnostics() -> Received? {
    guard let dir = directory() else { return nil }
    lock.lock()
    defer { lock.unlock() }
    var out = Received(version: 1, days: [:])
    coordinatedRead(dir.appendingPathComponent("received.json")) { data in
      if let data = data, let r = try? JSONDecoder().decode(Received.self, from: data) { out = r }
    }
    return out
  }

  /// `YYYY-MM-DD` in the phone's current time zone.
  static func dayKey(_ date: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
  }

  // ── Push entry point (app + NSE) ────────────────────────────────────

  /// Apply a push's totals: update the entry under its key (badgeKey,
  /// else subdomain), count the delivery (per subdomain), and return the
  /// new badge sum. nil = the push carried no usable totals (or no App
  /// Group): leave the badge alone.
  static func apply(push info: [AnyHashable: Any], source: Source) -> (totals: PushTotals, sum: Int)? {
    guard let t = totals(fromPush: info) else { return nil }
    guard let s = set(key: t.key, unread: t.unread, waiting: t.waiting) else { return nil }
    if let sub = t.subdomain { recordReceived(subdomain: sub, source: source) }
    return (t, s)
  }

  // ── File plumbing ───────────────────────────────────────────────────

  /// Read-modify-write of totals.json; returns the new sum.
  private static func mutateTotals(_ change: (inout Totals) -> Void) -> Int? {
    guard let dir = directory() else { return nil }
    lock.lock()
    defer { lock.unlock() }
    var result = 0
    coordinatedWrite(dir.appendingPathComponent("totals.json")) { data in
      var totals = data.flatMap { try? JSONDecoder().decode(Totals.self, from: $0) }
        ?? Totals(version: 1, servers: [:])
      totals.version = 1
      change(&totals)
      result = sum(totals)
      let enc = JSONEncoder()
      enc.outputFormatting = [.sortedKeys]
      return try? enc.encode(totals)
    }
    return result
  }

  /// Coordinated write: `body` gets the current bytes (nil if none) and
  /// returns the new bytes (nil = leave the file as it is). The write is
  /// atomic (temp + rename). Errors are swallowed: best effort.
  private static func coordinatedWrite(_ file: URL, _ body: (Data?) -> Data?) {
    try? FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var coordError: NSError?
    var ran = false
    NSFileCoordinator(filePresenter: nil).coordinate(
      writingItemAt: file, options: .forMerging, error: &coordError
    ) { url in
      ran = true
      let current = try? Data(contentsOf: url)
      guard let next = body(current) else { return }
      try? next.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    if !ran {
      // Coordination itself failed (should not happen in a container we
      // own): still do the atomic write rather than drop the update.
      let current = try? Data(contentsOf: file)
      if let next = body(current) {
        try? next.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
  }

  private static func coordinatedRead(_ file: URL, _ body: (Data?) -> Void) {
    var coordError: NSError?
    var ran = false
    NSFileCoordinator(filePresenter: nil).coordinate(
      readingItemAt: file, options: [], error: &coordError
    ) { url in
      ran = true
      body(try? Data(contentsOf: url))
    }
    if !ran { body(try? Data(contentsOf: file)) }
  }
}
