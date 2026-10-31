// End-to-end encrypted pushes (K2 0.46.3 `push-e2e-v1`): open a sealed
// `e2e` blob. ONE source shared by the app's k2-push plugin and the
// Notification Service Extension (project.yml), like K2BadgeStore.swift.
// CryptoKit + Foundation only; no key storage here (K2PushKeys does that).
//
// Wire (prd-e2e-push-v1 rev 2 §3, §7.3): base64url, no padding, of
//   format ‖ 0x01 (suite) ‖ enc (65-byte SEC1 uncompressed) ‖ ct+tag
// HPKE RFC 9180 mode_psk (0x01): DHKEM(P-256, HKDF-SHA256) 0x0010,
// HKDF-SHA256 0x0001, AES-256-GCM 0x0002; psk_id "k2-push-psk-v1";
// info "k2-push-v1\0alert" | "k2-push-v1\0nudge"; AAD = the first 2 bytes;
// sequence 0. Plaintext = u16be(len) ‖ JSON ‖ zeros, padded to the
// format's bucket. Two formats (K2 0.46.7 `push-e2e-v2`), picked by length
// with byte 0 required to agree:
//   format 1 (0x01): alert 1536 → 1619-byte blob (2159 chars),
//                    nudge  256 →  339 (452)
//   format 2 (0x02): alert 2880 → 2963 (3951), nudge 1024 → 1107 (1476)
//
// iOS 15 floor: CryptoKit's HPKE is iOS 17+, so the key schedule is done
// here (HMAC-SHA256 + AES-GCM, both iOS 13+). The Diffie-Hellman step is a
// closure so the private key can stay in the Secure Enclave.

import CryptoKit
import Foundation

public enum K2PushKind: String {
  case alert
  case nudge

  var info: Data { Data("k2-push-v1\u{0}\(rawValue)".utf8) }

  /// The padded plaintext's size in `format`.
  func paddedBytes(_ format: K2PushFormat) -> Int {
    switch (self, format) {
    case (.alert, .v1): return 1536
    case (.nudge, .v1): return 256
    case (.alert, .v2): return 2880
    case (.nudge, .v2): return 1024
    }
  }

  /// format ‖ suite ‖ enc ‖ padded ciphertext ‖ tag.
  func blobBytes(_ format: K2PushFormat) -> Int { 2 + 65 + paddedBytes(format) + 16 }

  /// base64url characters, no padding.
  func base64Chars(_ format: K2PushFormat) -> Int { (blobBytes(format) * 4 + 2) / 3 }

  /// The format a blob of this many bytes is in, or nil.
  public func format(blobBytes count: Int) -> K2PushFormat? {
    K2PushFormat.allCases.first { blobBytes($0) == count }
  }

  /// The format an `e2e` string of this many characters is in, or nil.
  public func format(base64Chars count: Int) -> K2PushFormat? {
    K2PushFormat.allCases.first { base64Chars($0) == count }
  }
}

/// The sealed blob's format, its byte 0 (and in the AAD).
public enum K2PushFormat: UInt8, CaseIterable {
  case v1 = 0x01
  case v2 = 0x02
}

public enum K2PushCryptoError: Error, Equatable {
  case badEncoding
  case badLength
  case badHeader
  case openFailed
  case badPadding
  case badJSON
}

public enum K2PushCrypto {
  static let pskId = Data("k2-push-psk-v1".utf8)
  static let modePsk: UInt8 = 0x01
  static let kemSuite = Data("KEM".utf8) + Data([0x00, 0x10])
  static let hpkeSuite = Data("HPKE".utf8) + Data([0x00, 0x10, 0x00, 0x01, 0x00, 0x02])
  static let version = Data("HPKE-v1".utf8)

  /// base64url (no padding) → bytes.
  public static func base64url(_ s: String) -> Data? {
    var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b.count % 4 != 0 { b += "=" }
    return Data(base64Encoded: b)
  }

  public static func base64urlString(_ d: Data) -> String {
    d.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  // ── HKDF pieces (RFC 5869 via HMAC-SHA256) ──────────────────────────

  static func extract(salt: Data, ikm: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt)))
  }

  static func expand(prk: Data, info: Data, length: Int) -> Data {
    var out = Data()
    var t = Data()
    var i: UInt8 = 1
    let key = SymmetricKey(data: prk)
    while out.count < length {
      t = Data(HMAC<SHA256>.authenticationCode(for: t + info + Data([i]), using: key))
      out += t
      i &+= 1
    }
    return out.prefix(length)
  }

  static func labeledExtract(suite: Data, salt: Data, label: String, ikm: Data) -> Data {
    extract(salt: salt, ikm: version + suite + Data(label.utf8) + ikm)
  }

  static func labeledExpand(suite: Data, prk: Data, label: String, info: Data, length: Int) -> Data {
    let l = Data([UInt8(length >> 8), UInt8(length & 0xff)])
    return expand(prk: prk, info: l + version + suite + Data(label.utf8) + info, length: length)
  }

  // ── Open ─────────────────────────────────────────────────────────────

  /// The ECDH step: the shared secret's x-coordinate (32 bytes) with the
  /// recipient's private key and the sender's ephemeral public key.
  public typealias DH = (_ ephemeralPublicKeyX963: Data) throws -> Data

  /// Open one blob for one recipient key. `recipientPublicKeyX963` is the
  /// 65-byte SEC1 uncompressed key the box was given. Returns the JSON
  /// bytes (unpadded). Throws on any mismatch (a wrong key fails the tag).
  public static func open(
    blob: Data,
    kind: K2PushKind,
    recipientPublicKeyX963: Data,
    psk: Data,
    dh: DH
  ) throws -> Data {
    guard let format = kind.format(blobBytes: blob.count) else { throw K2PushCryptoError.badLength }
    let b = [UInt8](blob)
    guard b[0] == format.rawValue, b[1] == 0x01 else { throw K2PushCryptoError.badHeader }
    let aad = Data(b[0..<2])
    let enc = Data(b[2..<67])
    let ct = Data(b[67...])

    // DHKEM Decap (RFC 9180 §4.1).
    let dhSecret: Data
    do {
      dhSecret = try dh(enc)
    } catch {
      throw K2PushCryptoError.openFailed
    }
    let kemContext = enc + recipientPublicKeyX963
    let eaePrk = labeledExtract(suite: kemSuite, salt: Data(), label: "eae_prk", ikm: dhSecret)
    let shared = labeledExpand(suite: kemSuite, prk: eaePrk, label: "shared_secret", info: kemContext, length: 32)

    // Key schedule, mode_psk (§5.1).
    let pskIdHash = labeledExtract(suite: hpkeSuite, salt: Data(), label: "psk_id_hash", ikm: pskId)
    let infoHash = labeledExtract(suite: hpkeSuite, salt: Data(), label: "info_hash", ikm: kind.info)
    let context = Data([modePsk]) + pskIdHash + infoHash
    let secret = labeledExtract(suite: hpkeSuite, salt: shared, label: "secret", ikm: psk)
    let key = labeledExpand(suite: hpkeSuite, prk: secret, label: "key", info: context, length: 32)
    let nonce = labeledExpand(suite: hpkeSuite, prk: secret, label: "base_nonce", info: context, length: 12)

    guard ct.count > 16 else { throw K2PushCryptoError.badLength }
    let padded: Data
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: ct.prefix(ct.count - 16),
        tag: ct.suffix(16)
      )
      padded = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    } catch {
      throw K2PushCryptoError.openFailed
    }
    return try unpad(padded, bytes: kind.paddedBytes(format))
  }

  /// `u16be(len) ‖ JSON ‖ zeros` → JSON; every byte after it must be 0.
  static func unpad(_ p: Data, bytes: Int) throws -> Data {
    let b = [UInt8](p)
    guard b.count == bytes else { throw K2PushCryptoError.badPadding }
    let len = Int(b[0]) << 8 | Int(b[1])
    guard len > 0, 2 + len <= b.count else { throw K2PushCryptoError.badPadding }
    guard b[(2 + len)...].allSatisfy({ $0 == 0 }) else { throw K2PushCryptoError.badPadding }
    return Data(b[2..<(2 + len)])
  }

  /// The ECDH closure for a software key (simulator, tests, and the
  /// Secure Enclave's fallback).
  public static func softwareDH(_ key: P256.KeyAgreement.PrivateKey) -> DH {
    { enc in
      let pub = try P256.KeyAgreement.PublicKey(x963Representation: enc)
      let s = try key.sharedSecretFromKeyAgreement(with: pub)
      return s.withUnsafeBytes { Data($0) }
    }
  }

  /// `kid` (and the reply's `keyId`): hex of the first 8 bytes of
  /// SHA-256(publicKey SEC1 uncompressed).
  public static func keyId(publicKeyX963: Data) -> String {
    SHA256.hash(data: publicKeyX963).prefix(8).map { String(format: "%02x", $0) }.joined()
  }
}
