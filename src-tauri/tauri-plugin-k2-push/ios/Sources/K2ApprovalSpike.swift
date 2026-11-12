// SPIKE (signed approvals S0, K2 PRD prd-signed-approvals-v1 §9). Thrown
// away after the result is written up; never merge.
//
// Proves on a real iPhone, from a TestFlight build:
//   1. a Secure Enclave P-256 key made with .biometryCurrentSet (and one
//      with .devicePasscode) signs "K2-SIGNED-APPROVAL-1" 0x00 <JSON>;
//   2. the signature verifies with `openssl dgst -sha256 -verify` on a Mac
//      (we hand back the SPKI PEM, the DER signature and the exact bytes);
//   3. what the Face ID and passcode prompts show (a native sheet with the
//      words first, then the system check);
//   4. App Attest returns an attestation over the two public keys.

import CryptoKit
import DeviceCheck
import Foundation
import LocalAuthentication
import Security
import UIKit

enum K2ApprovalSpike {
  static let prefix = Data("K2-SIGNED-APPROVAL-1".utf8) + Data([0])
  static func tag(_ which: String) -> Data {
    Data("com.alakazamlabs.k2so.companion.approve-spike.\(which)".utf8)
  }

  // ── Fixture ─────────────────────────────────────────────────────────

  static func iso(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: d)
  }

  static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

  static func randomHex(_ n: Int) -> String {
    var b = Data(count: n)
    _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
    return hex(b)
  }

  /// A k2.release payload in the PRD's §5 shape. The JSON text is written
  /// once here and signed as is (SA-3); nothing re-encodes it.
  static func fixture(keyIds: [String]) -> (Data, [String: Any]) {
    let now = Date()
    let body: [String: Any] = [
      "version": "0.46.12",
      "base": "52b4d0838c0ffee52b4d0838c0ffee52b4d08380",
      "assets": ["K2_0.46.12_aarch64.dmg", "K2_0.46.12_aarch64.app.tar.gz"],
      "windows": false,
      "session_until": iso(now.addingTimeInterval(12 * 3600)),
    ]
    let obj: [String: Any] = [
      "kind": "k2.release",
      "kind_v": 1,
      "rp": "k2sign@spike",
      "approver": "Rosson",
      "approver_keys": keyIds,
      "nonce": randomHex(16),
      "issued": iso(now),
      "answer_by": iso(now.addingTimeInterval(15 * 60)),
      "body": body,
    ]
    let json = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    return (prefix + json, obj)
  }

  // ── Keys ────────────────────────────────────────────────────────────

  static let spkiHeader = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ])

  static func spki(_ key: SecKey) -> Data? {
    var err: Unmanaged<CFError>?
    guard let pub = SecKeyCopyPublicKey(key), let raw = SecKeyCopyExternalRepresentation(pub, &err) as Data?,
      raw.count == 65
    else { return nil }
    return spkiHeader + raw
  }

  static func pem(_ spki: Data) -> String {
    let b64 = spki.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN PUBLIC KEY-----\n\(b64)\n-----END PUBLIC KEY-----\n"
  }

  /// Key id = sha256(SPKI DER), hex (PRD: fingerprint over the public key).
  static func keyId(_ spki: Data) -> String { hex(Data(SHA256.hash(data: spki))) }

  static func delete(_ which: String) {
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(which)] as CFDictionary)
  }

  static func find(_ which: String, ctx: LAContext? = nil) -> SecKey? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(which),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    if let ctx { q[kSecUseAuthenticationContext as String] = ctx }
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let k = out else { return nil }
    return (k as! SecKey)
  }

  static func make(_ which: String) throws -> SecKey {
    delete(which)
    let flags: SecAccessControlCreateFlags =
      which == "biometric" ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage, .devicePasscode]
    var err: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &err)
    else { throw NSError(domain: "spike", code: 1, userInfo: [NSLocalizedDescriptionKey: "access control"]) }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag(which),
        kSecAttrAccessControl as String: access,
      ],
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else {
      throw err!.takeRetainedValue() as Error
    }
    return key
  }

  static func keyOrMake(_ which: String) throws -> (SecKey, Bool) {
    if let k = find(which) { return (k, false) }
    return (try make(which), true)
  }

  static func biometryName() -> String {
    let ctx = LAContext()
    var e: NSError?
    let can = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
    let t: String
    switch ctx.biometryType {
    case .faceID: t = "faceID"
    case .touchID: t = "touchID"
    case .none: t = "none"
    default: t = "other(\(ctx.biometryType.rawValue))"
    }
    return can ? t : "\(t) (unavailable: \(e?.localizedDescription ?? "?"))"
  }

  static func deviceModel() -> String {
    var s = utsname()
    uname(&s)
    return withUnsafePointer(to: &s.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
  }

  // ── Run ─────────────────────────────────────────────────────────────

  /// `which`: "biometric" | "passcode". Shows a native sheet with the words,
  /// then signs (the system check runs inside SecKeyCreateSignature).
  static func sign(which: String, fresh: Bool, root: UIViewController?, done: @escaping ([String: Any]) -> Void) {
    var out: [String: Any] = [
      "which": which, "model": deviceModel(), "ios": UIDevice.current.systemVersion, "biometry": biometryName(),
    ]
    let key: SecKey
    do {
      if fresh { delete(which) }
      let (k, made) = try keyOrMake(which)
      key = k
      out["key_made_now"] = made
    } catch {
      out["error"] = "make key: \(error.localizedDescription)"
      return done(out)
    }
    guard let spki = spki(key) else {
      out["error"] = "public key"
      return done(out)
    }
    let kid = keyId(spki)
    let (bytes, obj) = fixture(keyIds: [kid])
    out["key_id"] = kid
    out["pub_pem"] = pem(spki)
    out["payload_b64"] = bytes.base64EncodedString()

    let body = obj["body"] as? [String: Any] ?? [:]
    let assets = (body["assets"] as? [String] ?? []).joined(separator: ", ")
    let words =
      "Approve K2 release \(body["version"] ?? "?") at base commit \(body["base"] ?? "?").\n\nSign: \(assets).\nWindows setup: no.\nSigning stays open until \(body["session_until"] ?? "?").\n\nFor: \(obj["rp"] ?? "?")\nAnswer by: \(obj["answer_by"] ?? "?")\nCheck: \(which == "biometric" ? "Face ID / Touch ID" : "passcode")\n\n(TEST: nothing is released.)"

    DispatchQueue.main.async {
      guard let root = topmost(root) else {
        out["error"] = "no view controller"
        return done(out)
      }
      let sheet = UIAlertController(title: "Approve K2 release", message: words, preferredStyle: .alert)
      sheet.addAction(
        UIAlertAction(title: "Cancel", style: .cancel) { _ in
          out["cancelled_on_sheet"] = true
          done(out)
        })
      sheet.addAction(
        UIAlertAction(title: "Approve", style: .default) { _ in
          DispatchQueue.global(qos: .userInitiated).async {
            let ctx = LAContext()
            ctx.localizedReason = "Approve K2 release \(body["version"] ?? "?") (test)"
            ctx.touchIDAuthenticationAllowableReuseDuration = 0
            let signKey = find(which, ctx: ctx) ?? key
            let t0 = Date()
            var err: Unmanaged<CFError>?
            let sig = SecKeyCreateSignature(signKey, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &err) as Data?
            out["sign_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            if let sig {
              out["sig_der_b64"] = sig.base64EncodedString()
              if let pub = SecKeyCopyPublicKey(key) {
                out["verified_on_phone"] = SecKeyVerifySignature(
                  pub, .ecdsaSignatureMessageX962SHA256, bytes as CFData, sig as CFData, nil)
              }
            } else {
              let e = err?.takeRetainedValue()
              out["error"] = "sign: \(e.map { CFErrorGetCode($0) } ?? 0) \(e?.localizedDescription ?? "?")"
            }
            done(out)
          }
        })
      root.present(sheet, animated: true)
    }
  }

  /// App Attest over sha256(SPKI biometric || SPKI passcode), the keys a
  /// real enrolment would export.
  static func attest(done: @escaping ([String: Any]) -> Void) {
    var out: [String: Any] = ["model": deviceModel(), "ios": UIDevice.current.systemVersion]
    guard #available(iOS 14.0, *) else {
      out["error"] = "App Attest needs iOS 14"
      return done(out)
    }
    let svc = DCAppAttestService.shared
    out["supported"] = svc.isSupported
    guard svc.isSupported else { return done(out) }
    var clientData = Data()
    for w in ["biometric", "passcode"] {
      if let k = find(w), let s = spki(k) {
        clientData += s
        out["\(w)_key_id"] = keyId(s)
      }
    }
    if clientData.isEmpty { clientData = Data("k2-approval-spike-no-keys".utf8) }
    out["client_data_b64"] = clientData.base64EncodedString()
    let hash = Data(SHA256.hash(data: clientData))
    let t0 = Date()
    svc.generateKey { keyId, err in
      guard let keyId else {
        out["error"] = "generateKey: \(err.map { "\(($0 as NSError).code) \($0.localizedDescription)" } ?? "?")"
        return done(out)
      }
      out["attest_key_id"] = keyId
      svc.attestKey(keyId, clientDataHash: hash) { att, err in
        out["attest_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        if let att {
          out["attestation_b64"] = att.base64EncodedString()
          out["attestation_bytes"] = att.count
        } else {
          out["error"] = "attestKey: \(err.map { "\(($0 as NSError).code) \($0.localizedDescription)" } ?? "?")"
        }
        done(out)
      }
    }
  }

  static func topmost(_ root: UIViewController?) -> UIViewController? {
    var vc = root
    while let p = vc?.presentedViewController { vc = p }
    return vc
  }
}
