// Keys for end-to-end encrypted pushes (K2 0.46.3 `push-e2e-v1`, prd §7.4).
// ONE source shared by the app's k2-push plugin and the Notification
// Service Extension (project.yml), like K2BadgeStore.swift.
//
// One P-256 key agreement key + one 32-byte PSK per saved server entry,
// never shared across servers. The private key lives in the Secure Enclave
// (a software key on the simulator, or when the Enclave refuses); its
// opaque handle, the PSK and the server's tunnel label are one keychain
// item in the App Group access group (the NSE reads it),
// AfterFirstUnlockThisDeviceOnly: never in a backup, never on another
// phone. Before the first unlock the NSE can't read it and the generic
// "K2 / New message" shows (as at Signal and Element X).
//
// Rotation keeps the old key RETIRE_DAYS for pushes already in flight.
// Keychain items can outlive an uninstall while App Group data can't: the
// first run after an install wipes leftovers (`wipeIfFreshInstall`).

import CryptoKit
import Foundation
import Security

public enum K2PushKeys {
  static let appGroup = "group.com.alakazamlabs.k2so.companion"
  static let service = "com.alakazamlabs.k2.push-e2e"
  static let installMarker = "k2.pushKeys.installed.v1"
  /// A rotated-out key still opens pushes sealed to it for this long.
  public static let retireDays: Double = 14

  public struct Record: Codable, Equatable {
    /// The phone's saved server id (the plugin's `server` argument).
    public var server: String
    /// The server's tunnel label (`rosson` for rosson.k2.dev): checked
    /// against the sealed `srv.sub`.
    public var subdomain: String
    public var keyId: String
    /// SEC1 uncompressed public key (65 bytes), base64.
    public var publicKey: String
    /// Secure Enclave `dataRepresentation`, or the software key's raw
    /// bytes (`enclave: false`), base64.
    public var privateKey: String
    public var enclave: Bool
    /// 32 bytes, base64.
    public var psk: String
    public var createdAt: Double
    /// Set when a newer key replaced this one: deleted after.
    public var retireAt: Double?
  }

  // ── Keychain ─────────────────────────────────────────────────────────

  static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccessGroup as String: appGroup,
    ]
  }

  static func account(_ r: Record) -> String { "\(r.server)|\(r.keyId)" }

  static func save(_ r: Record) -> Bool {
    guard let data = try? JSONEncoder().encode(r) else { return false }
    var q = baseQuery()
    q[kSecAttrAccount as String] = account(r)
    SecItemDelete(q as CFDictionary)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }

  static func delete(_ r: Record) {
    var q = baseQuery()
    q[kSecAttrAccount as String] = account(r)
    SecItemDelete(q as CFDictionary)
  }

  /// Every key on this phone (nil: the keychain is locked — before the
  /// first unlock — or unreadable).
  public static func all() -> [Record]? {
    var q = baseQuery()
    q[kSecMatchLimit as String] = kSecMatchLimitAll
    q[kSecReturnData as String] = true
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = out as? [Data] else { return nil }
    return items.compactMap { try? JSONDecoder().decode(Record.self, from: $0) }
  }

  /// The keys for one saved server, newest first.
  public static func keys(server: String) -> [Record] {
    (all() ?? []).filter { $0.server == server }.sorted { $0.createdAt > $1.createdAt }
  }

  // ── Create / rotate / forget ─────────────────────────────────────────

  /// This server's current key, made on first use (or a new one with
  /// `rotate`; the old one is kept RETIRE_DAYS). Nil when no key can be
  /// made or saved (the caller registers without `e2e`).
  public static func current(server: String, subdomain: String, rotate: Bool = false, now: Date = Date()) -> Record? {
    pruneRetired(now: now)
    let mine = keys(server: server).filter { $0.retireAt == nil }
    if let k = mine.first, !rotate, k.subdomain == subdomain { return k }
    guard let fresh = make(server: server, subdomain: subdomain, now: now) else { return mine.first }
    guard save(fresh) else { return mine.first }
    for var old in mine {
      // A different label is a different box: its key goes now.
      if old.subdomain != subdomain {
        delete(old)
        continue
      }
      old.retireAt = now.timeIntervalSince1970 + retireDays * 86_400
      _ = save(old)
    }
    return fresh
  }

  /// Sign-out, server removed, session ended: this server's keys go
  /// (and its push device id: the next sign-in registers a new one).
  public static func forget(server: String) {
    for r in keys(server: server) { delete(r) }
    var q = baseQuery()
    q[kSecAttrService as String] = deviceIdService
    q[kSecAttrAccount as String] = server
    SecItemDelete(q as CFDictionary)
  }

  // ── Per-server push device id (prd §7.1) ─────────────────────────────

  static let deviceIdService = "com.alakazamlabs.k2.push-device-id"

  /// This phone's push `deviceId` for one saved server: made once and kept
  /// ThisDeviceOnly, so a restored backup or another phone never reuses it
  /// (and so never replaces this phone's key on the box).
  public static func deviceId(server: String) -> String? {
    var q = baseQuery()
    q[kSecAttrService as String] = deviceIdService
    q[kSecAttrAccount as String] = server
    var read = q
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    if SecItemCopyMatching(read as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
      let id = String(data: d, encoding: .utf8), !id.isEmpty
    {
      return id
    }
    let id = UUID().uuidString.lowercased()
    q[kSecValueData as String] = Data(id.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess ? id : nil
  }

  public static func forgetAll() {
    SecItemDelete(baseQuery() as CFDictionary)
    var q = baseQuery()
    q[kSecAttrService as String] = deviceIdService
    SecItemDelete(q as CFDictionary)
  }

  /// The first run after an install: leftovers from an earlier install
  /// (keychain items survive an uninstall) are wiped, so the phone
  /// registers fresh keys and never trusts a key it no longer pairs with.
  public static func wipeIfFreshInstall() {
    guard let d = UserDefaults(suiteName: appGroup) else { return }
    if d.bool(forKey: installMarker) { return }
    forgetAll()
    K2PushInbox.clear()
    d.set(true, forKey: installMarker)
  }

  static func pruneRetired(now: Date) {
    for r in all() ?? [] {
      if let at = r.retireAt, at <= now.timeIntervalSince1970 { delete(r) }
    }
  }

  static func make(server: String, subdomain: String, now: Date) -> Record? {
    var pskBytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, pskBytes.count, &pskBytes) == errSecSuccess else { return nil }
    let psk = Data(pskBytes)
    var pub: Data
    var priv: Data
    var enclave = false
    #if targetEnvironment(simulator)
      let sw = P256.KeyAgreement.PrivateKey()
      pub = sw.publicKey.x963Representation
      priv = sw.rawRepresentation
    #else
      if SecureEnclave.isAvailable, let se = try? SecureEnclave.P256.KeyAgreement.PrivateKey() {
        pub = se.publicKey.x963Representation
        priv = se.dataRepresentation
        enclave = true
      } else {
        let sw = P256.KeyAgreement.PrivateKey()
        pub = sw.publicKey.x963Representation
        priv = sw.rawRepresentation
      }
    #endif
    return Record(
      server: server,
      subdomain: subdomain.lowercased(),
      keyId: K2PushCrypto.keyId(publicKeyX963: pub),
      publicKey: pub.base64EncodedString(),
      privateKey: priv.base64EncodedString(),
      enclave: enclave,
      psk: psk.base64EncodedString(),
      createdAt: now.timeIntervalSince1970,
      retireAt: nil
    )
  }

  /// The ECDH closure for a stored key.
  public static func dh(_ r: Record) -> K2PushCrypto.DH? {
    guard let raw = Data(base64Encoded: r.privateKey) else { return nil }
    if r.enclave {
      #if targetEnvironment(simulator)
        return nil
      #else
        guard let se = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: raw) else { return nil }
        return { enc in
          let pub = try P256.KeyAgreement.PublicKey(x963Representation: enc)
          let s = try se.sharedSecretFromKeyAgreement(with: pub)
          return s.withUnsafeBytes { Data($0) }
        }
      #endif
    }
    guard let sw = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) else { return nil }
    return K2PushCrypto.softwareDH(sw)
  }

  // ── Open with whatever key fits ──────────────────────────────────────

  public struct Opened {
    public let record: Record
    /// The sealed JSON object.
    public let json: [String: Any]
  }

  public enum OpenFailure: Error {
    /// The keychain can't be read yet (before the first unlock).
    case locked
    /// No key opened it (or the blob is malformed).
    case noKey
    /// It opened, but `v`, `kid` or `srv.sub` don't match that key.
    case mismatch
  }

  /// Trial-decrypt `e2e` with every key on the phone, newest first (no key
  /// id travels in clear). The key that opens it names the server; the
  /// sealed `kid` and `srv.sub` must agree with it.
  public static func open(e2e: String, kind: K2PushKind) -> Result<Opened, OpenFailure> {
    guard let all = all() else { return .failure(.locked) }
    guard e2e.count == (kind == .alert ? 2159 : 452), let blob = K2PushCrypto.base64url(e2e) else {
      return .failure(.noKey)
    }
    for r in all.sorted(by: { $0.createdAt > $1.createdAt }) {
      guard let pub = Data(base64Encoded: r.publicKey), let psk = Data(base64Encoded: r.psk), let dh = dh(r) else {
        continue
      }
      guard let jsonData = try? K2PushCrypto.open(blob: blob, kind: kind, recipientPublicKeyX963: pub, psk: psk, dh: dh)
      else { continue }
      guard
        let json = (try? JSONSerialization.jsonObject(with: jsonData)) as? [String: Any],
        (json["v"] as? NSNumber)?.intValue == 1,
        (json["kid"] as? String) == r.keyId,
        let srv = json["srv"] as? [String: Any],
        ((srv["sub"] as? String) ?? "").lowercased() == r.subdomain
      else { return .failure(.mismatch) }
      return .success(Opened(record: r, json: json))
    }
    return .failure(.noKey)
  }
}
