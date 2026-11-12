// Signed approvals (K2 PRD prd-signed-approvals-v1 §3, S1): this phone's
// two approver keys, beside the voice key (K2DeviceKey) and the push keys.
//
//   biometric  [.privateKeyUsage, .biometryCurrentSet]: Face ID / Touch ID
//              only; enrolling a new face or finger kills it (by design).
//   credential [.privateKeyUsage, .devicePasscode]: the device passcode.
//
// Both are non-exportable Secure Enclave P-256 keys, usable only while a
// passcode is set (kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly), with no
// reuse window: every signature needs a fresh check. They sign approval
// payloads only, and only from native code (K2Approvals): no JS command
// signs anything (SA-8).

import Foundation
import K2Approval
import LocalAuthentication
import Security

public enum K2ApproverKeys {
  public enum Check: String {
    case biometric
    case credential

    var flags: SecAccessControlCreateFlags {
      self == .biometric ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage, .devicePasscode]
    }
  }

  public struct Key {
    public let check: Check
    public let spki: Data
    public var keyId: String { K2ApprovalKeyId.keyId(spki: spki) }
    public var words: String { K2ApprovalKeyId.words(keyId: keyId) }
    public var pem: String { K2ApprovalKeyId.pem(spki: spki) }
  }

  static func tag(_ c: Check) -> Data { Data("com.alakazamlabs.k2so.companion.approver.\(c.rawValue)".utf8) }

  static func find(_ c: Check, ctx: LAContext? = nil) -> SecKey? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(c),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    if let ctx { q[kSecUseAuthenticationContext as String] = ctx }
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let k = out else { return nil }
    return (k as! SecKey)
  }

  static func spki(_ key: SecKey) -> Data? {
    var err: Unmanaged<CFError>?
    guard let pub = SecKeyCopyPublicKey(key), let raw = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
      return nil
    }
    return K2ApprovalKeyId.spki(rawPoint: raw)
  }

  /// The keys this phone has now (none until set up).
  public static func current() -> [Key] {
    [Check.biometric, .credential].compactMap { c in find(c).flatMap(spki).map { Key(check: c, spki: $0) } }
  }

  public static func key(for keyId: String) -> Key? { current().first { $0.keyId == keyId } }

  public static func delete(_ c: Check) {
    SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(c)] as CFDictionary)
  }

  public static func deleteAll() {
    delete(.biometric)
    delete(.credential)
  }

  /// Make whichever key is missing. The biometric key needs Face ID or
  /// Touch ID set up; both need a device passcode. Returns what was made
  /// and why any wasn't.
  public static func makeMissing() -> (made: [Check], errors: [String]) {
    removeSpikeKeys()
    var made: [Check] = []
    var errors: [String] = []
    for c in [Check.biometric, .credential] where find(c) == nil {
      var err: Unmanaged<CFError>?
      guard
        let access = SecAccessControlCreateWithFlags(
          nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, c.flags, &err)
      else {
        errors.append("\(c.rawValue): access control")
        continue
      }
      let attrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: tag(c),
          kSecAttrAccessControl as String: access,
        ],
      ]
      if SecKeyCreateRandomKey(attrs as CFDictionary, &err) != nil {
        made.append(c)
      } else {
        errors.append("\(c.rawValue): \(err?.takeRetainedValue().localizedDescription ?? "Secure Enclave")")
      }
    }
    return (made, errors)
  }

  /// ECDSA P-256 / SHA-256 over the exact bytes, DER. Runs the key's own
  /// check (Face ID or the passcode) with a fresh context; blocks while the
  /// system prompt is up, so call it off the main thread.
  public static func sign(_ c: Check, bytes: [UInt8], reason: String) throws -> Data {
    let ctx = LAContext()
    ctx.localizedReason = reason
    ctx.touchIDAuthenticationAllowableReuseDuration = 0
    guard let key = find(c, ctx: ctx) else {
      throw NSError(domain: "K2Approval", code: 1, userInfo: [NSLocalizedDescriptionKey: "This phone has no \(c.rawValue) key."])
    }
    var err: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(bytes) as CFData, &err) as Data?
    else {
      throw (err?.takeRetainedValue() as Error?)
        ?? NSError(domain: "K2Approval", code: 2, userInfo: [NSLocalizedDescriptionKey: "The phone didn't sign."])
    }
    return sig
  }

  /// True when the error is the person cancelling the system check.
  public static func isCancel(_ error: Error) -> Bool {
    let e = error as NSError
    return e.code == errSecUserCanceled || e.code == LAError.userCancel.rawValue
      || e.code == LAError.systemCancel.rawValue || e.code == LAError.appCancel.rawValue
  }

  /// "Face ID", "Touch ID", or "Optic ID" for the biometric key's check.
  public static func biometryName() -> String {
    let ctx = LAContext()
    _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    switch ctx.biometryType {
    case .touchID: return "Touch ID"
    case .faceID: return "Face ID"
    default:
      if #available(iOS 17.0, *), ctx.biometryType == .opticID { return "Optic ID" }
      return "Face ID"
    }
  }

  /// The S0 spike's keys (`…approve-spike.*`, build 202611112012) go.
  static func removeSpikeKeys() {
    for w in ["biometric", "passcode"] {
      SecItemDelete(
        [
          kSecClass as String: kSecClassKey,
          kSecAttrApplicationTag as String: Data("com.alakazamlabs.k2so.companion.approve-spike.\(w)".utf8),
        ] as CFDictionary)
    }
  }
}
