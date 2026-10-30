// Checks K2PushCrypto against K2's e2e push vectors (macOS), format 1
// (e2e_push_vectors.json) and format 2 (e2e_push_vectors_v2.json):
//   swiftc -O ../Sources/K2PushCrypto.swift main.swift -o /tmp/k2vec && /tmp/k2vec <vectors.json>
import CryptoKit
import Foundation

func hex(_ s: String) -> Data {
  var d = Data()
  var i = s.startIndex
  while i < s.endIndex {
    let j = s.index(i, offsetBy: 2)
    d.append(UInt8(s[i..<j], radix: 16)!)
    i = j
  }
  return d
}

let path = CommandLine.arguments.dropFirst().first ?? "/Users/Shared/k2-companion/e2e_push_vectors.json"
let root = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
let r = root["recipient"] as! [String: Any]
let sk = try P256.KeyAgreement.PrivateKey(rawRepresentation: hex(r["privateKeyHex"] as! String))
let pub = K2PushCrypto.base64url(r["publicKeyB64url"] as! String)!
precondition(pub == sk.publicKey.x963Representation, "public key mismatch")
let psk = hex(r["pskHex"] as! String)
precondition(K2PushCrypto.base64url(r["pskB64url"] as! String) == psk, "psk b64url mismatch")
let kid = K2PushCrypto.keyId(publicKeyX963: pub)
print("keyId", kid, kid == (r["keyId"] as! String) ? "OK" : "MISMATCH")

var failures = 0
for c in root["cases"] as! [[String: Any]] {
  let name = c["name"] as! String
  let kind: K2PushKind = (c["kind"] as! String) == "nudge" ? .nudge : .alert
  let e2e = c["e2e"] as! String
  do {
    guard let format = kind.format(base64Chars: e2e.count) else { throw K2PushCryptoError.badLength }
    if let want = c["format"] as? Int, want != Int(format.rawValue) {
      failures += 1
      print("FAIL", name, "format \(format.rawValue), vectors say \(want)")
    }
    let blob = K2PushCrypto.base64url(e2e)!
    // Byte 0 must agree with the length: a format-1 header on a format-2
    // length (or the reverse) is refused.
    var swapped = blob
    swapped[0] = format == .v1 ? 0x02 : 0x01
    if (try? K2PushCrypto.open(blob: swapped, kind: kind, recipientPublicKeyX963: pub, psk: psk, dh: K2PushCrypto.softwareDH(sk))) != nil {
      failures += 1
      print("FAIL", name, "opened with the other format byte")
    }
    precondition(blob == hex(c["blobHex"] as! String), "\(name): blob decode mismatch")
    let json = try K2PushCrypto.open(blob: blob, kind: kind, recipientPublicKeyX963: pub, psk: psk, dh: K2PushCrypto.softwareDH(sk))
    let want = Data((c["plaintextJson"] as! String).utf8)
    if json == want {
      print("OK  ", name, json.count, "bytes")
    } else {
      failures += 1
      print("FAIL", name, "plaintext differs")
    }
    // A wrong PSK or key must fail the tag.
    var badPsk = psk
    badPsk[0] ^= 1
    if (try? K2PushCrypto.open(blob: blob, kind: kind, recipientPublicKeyX963: pub, psk: badPsk, dh: K2PushCrypto.softwareDH(sk))) != nil {
      failures += 1
      print("FAIL", name, "opened with a wrong psk")
    }
    let other = P256.KeyAgreement.PrivateKey()
    if (try? K2PushCrypto.open(blob: blob, kind: kind, recipientPublicKeyX963: other.publicKey.x963Representation, psk: psk, dh: K2PushCrypto.softwareDH(other))) != nil {
      failures += 1
      print("FAIL", name, "opened with a wrong key")
    }
    let wrongKind: K2PushKind = kind == .alert ? .nudge : .alert
    if (try? K2PushCrypto.open(blob: blob, kind: wrongKind, recipientPublicKeyX963: pub, psk: psk, dh: K2PushCrypto.softwareDH(sk))) != nil {
      failures += 1
      print("FAIL", name, "opened as the other kind")
    }
  } catch {
    failures += 1
    print("FAIL", name, error)
  }
}
print(failures == 0 ? "ALL VECTORS OK" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
