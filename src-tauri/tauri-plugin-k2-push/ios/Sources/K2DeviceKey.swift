// The voice call's E2EE device key in the Secure Enclave (Sew's
// `HardwareDeviceKey`, plugin draft rev 2 §7): a non-exportable P-256 key
// that signs enrolment and the per-call credentials, about once per join.
// Sew sees only the public key and signatures; there is no software
// fallback. Readable after the first unlock with no user presence, so a
// re-join on a locked phone can still sign.
//
// Rust reaches this and the Keychain login copy through the C functions at
// the end (the voice plugin's provider and signer run in Rust, off the main
// thread, with the webview possibly asleep).

import Foundation
import Security

public enum K2DeviceKey {
  public enum Failure: Error {
    case unavailable(String)
  }

  /// `id` is Sew's `DeviceKeyId::account()`
  /// ("<install_id>:<member_id>:<device_scope>", stable, at most ~100 chars).
  static func tag(_ id: String) -> Data { Data("com.alakazamlabs.k2so.companion.voice.\(id)".utf8) }

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
}

// ── For Rust ───────────────────────────────────────────────────────────
// Every function is synchronous; Rust calls them from a blocking task.
// Returned buffers are malloc'd and freed with `k2_native_free`.

private func string(_ p: UnsafePointer<CChar>?) -> String? {
  guard let p = p else { return nil }
  let s = String(cString: p)
  return s.isEmpty ? nil : s
}

private func copyOut(_ data: Data, _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?, _ len: UnsafeMutablePointer<Int>?) {
  let buf = malloc(max(data.count, 1))!.assumingMemoryBound(to: UInt8.self)
  data.copyBytes(to: buf, count: data.count)
  out?.pointee = buf
  len?.pointee = data.count
}

/// This server's login token (NUL-terminated), or NULL.
@_cdecl("k2_native_token_get")
public func k2NativeTokenGet(_ server: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let server = string(server), let token = K2SecureTokens.get(server: server) else { return nil }
  return strdup(token)
}

/// 1: found (65 bytes in `out`); 0: no key; -1: unavailable.
@_cdecl("k2_native_device_key_public")
public func k2NativeDeviceKeyPublic(_ id: UnsafePointer<CChar>?, _ out: UnsafeMutablePointer<UInt8>?) -> Int32 {
  guard let id = string(id), let out = out else { return -1 }
  do {
    guard let pub = try K2DeviceKey.publicKey(id) else { return 0 }
    pub.copyBytes(to: out, count: 65)
    return 1
  } catch {
    return -1
  }
}

/// 1: made (65 bytes in `out`); -1: unavailable.
@_cdecl("k2_native_device_key_generate")
public func k2NativeDeviceKeyGenerate(_ id: UnsafePointer<CChar>?, _ out: UnsafeMutablePointer<UInt8>?) -> Int32 {
  guard let id = string(id), let out = out, let pub = try? K2DeviceKey.generate(id) else { return -1 }
  pub.copyBytes(to: out, count: 65)
  return 1
}

/// 1: signed (DER in `out`/`len`); -1: unavailable.
@_cdecl("k2_native_device_key_sign")
public func k2NativeDeviceKeySign(
  _ id: UnsafePointer<CChar>?, _ msg: UnsafePointer<UInt8>?, _ msgLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?, _ len: UnsafeMutablePointer<Int>?
) -> Int32 {
  guard let id = string(id), let msg = msg, msgLen >= 0,
    let sig = try? K2DeviceKey.sign(id, Data(bytes: msg, count: msgLen))
  else { return -1 }
  copyOut(sig, out, len)
  return 1
}

@_cdecl("k2_native_device_key_delete")
public func k2NativeDeviceKeyDelete(_ id: UnsafePointer<CChar>?) -> Int32 {
  guard let id = string(id) else { return -1 }
  K2DeviceKey.delete(id)
  return 1
}

@_cdecl("k2_native_free")
public func k2NativeFree(_ p: UnsafeMutableRawPointer?) {
  free(p)
}
