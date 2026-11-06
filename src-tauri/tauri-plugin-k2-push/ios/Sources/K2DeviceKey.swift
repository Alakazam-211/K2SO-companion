// The voice call's E2EE device key in the Secure Enclave (Sew's
// `HardwareDeviceKey`, plugin draft rev 2 §7): a non-exportable P-256 key
// that signs enrolment and the per-call credentials, about once per join.
// Sew sees only the public key and signatures; there is no software
// fallback. Readable after the first unlock with no user presence, so a
// re-join on a locked phone can still sign.
//
// Rust reaches this through the plugin's `voiceKey` command
// (`run_mobile_plugin`, on a blocking thread; never from the webview: the
// command has no JS permission).

import Foundation
import Security

public enum K2DeviceKey {
  public enum Failure: Error {
    case unavailable(String)
  }

  /// `id` is Sew's `DeviceKeyId::account()`
  /// ("<install_id>:<member_id>:<device_scope>", stable, at most ~100 chars).
  static let tagPrefix = "com.alakazamlabs.k2so.companion.voice."
  static func tag(_ id: String) -> Data { Data("\(tagPrefix)\(id)".utf8) }

  static func find(_ id: String) throws -> SecKey? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(id),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let key = out else { throw Failure.unavailable("keychain \(status)") }
    return (key as! SecKey)
  }

  /// SEC1 uncompressed (65 bytes).
  static func publicBytes(_ key: SecKey) throws -> Data {
    var err: Unmanaged<CFError>?
    guard let pub = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(pub, &err) as Data?,
      data.count == 65
    else { throw Failure.unavailable("public key") }
    return data
  }

  public static func publicKey(_ id: String) throws -> Data? {
    try find(id).map(publicBytes)
  }

  /// A new key for `id`, replacing any old one.
  public static func generate(_ id: String) throws -> Data {
    delete(id)
    var err: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &err)
    else { throw Failure.unavailable("access control") }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag(id),
        kSecAttrAccessControl as String: access,
      ],
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else {
      // The simulator, or a phone without a Secure Enclave.
      throw Failure.unavailable(err?.takeRetainedValue().localizedDescription ?? "secure enclave")
    }
    return try publicBytes(key)
  }

  /// ECDSA P-256 with SHA-256 over `msg`: the platform's DER (X9.62), as is.
  public static func sign(_ id: String, _ msg: Data) throws -> Data {
    guard let key = try find(id) else { throw Failure.unavailable("no key") }
    var err: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, msg as CFData, &err) as Data? else {
      throw Failure.unavailable(err?.takeRetainedValue().localizedDescription ?? "sign")
    }
    return sig
  }

  public static func delete(_ id: String) {
    let q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(id),
    ]
    SecItemDelete(q as CFDictionary)
  }

  // Keychain items, Secure Enclave keys included, outlive an uninstall,
  // but the app's data (Sew's record of each key) doesn't. A fresh install
  // starts with no voice keys, so the engine enrols cleanly and an old
  // member's key never lingers on a phone that changed hands.
  static let installMarker = "k2.voice.installed"

  public static func wipeIfFreshInstall() {
    let d = UserDefaults.standard
    if d.bool(forKey: installMarker) { return }
    wipeAll()
    d.set(true, forKey: installMarker)
  }

  static func wipeAll() {
    let q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let rows = out as? [[String: Any]] else { return }
    let prefix = Data(tagPrefix.utf8)
    for row in rows {
      guard let tag = row[kSecAttrApplicationTag as String] as? Data, tag.starts(with: prefix) else { continue }
      SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary)
    }
  }
}
