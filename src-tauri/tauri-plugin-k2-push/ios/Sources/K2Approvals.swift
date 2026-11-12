// Signed approvals (K2 PRD prd-signed-approvals-v1, S1): the native flows
// behind the plugin's two approval commands.
//
//   approvalOpen {server, url, requestId}: the approval screen for one
//     request. Native code fetches the bytes (GET /cli/approve/get) with
//     the server's Keychain token, shows them, signs and answers
//     (POST /cli/approve/answer). The web view gets back only the outcome.
//   approverKeys: the Approver keys screen: set up the two keys, show their
//     six words, share the public keys + enrol.json (App Attest), remove.
//
// No command takes bytes to sign or returns a signature (SA-8).

import DeviceCheck
import Foundation
import K2Approval
import UIKit

@available(iOS 15.0, *)
enum K2Approvals {
  enum Result<T> {
    case success(T)
    case failure(String)
  }

  struct Fetched {
    let state: String
    let bytes: Data
    let requestedBy: String?
  }

  // MARK: device

  static func machine() -> String {
    var s = utsname()
    uname(&s)
    return withUnsafePointer(to: &s.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
  }

  /// Shown on the card ("Approved on iPhone (iPhone18,4), Face ID"); ≤ 80.
  static func deviceName() -> String { String("\(UIDevice.current.model) (\(machine()))".prefix(80)) }

  static func appVersion() -> String {
    let i = Bundle.main.infoDictionary ?? [:]
    return "\(i["CFBundleShortVersionString"] as? String ?? "?") (\(i["CFBundleVersion"] as? String ?? "?"))"
  }

  // MARK: HTTP

  static func call(
    _ r: K2ApprovalViewController.Request, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil,
    done: @escaping (Result<[String: Any]>) -> Void
  ) {
    guard let token = K2SecureTokens.get(server: r.server) else {
      return done(.failure("This phone isn't signed in to that server. Open K2 and sign in, then try again."))
    }
    guard var c = URLComponents(url: r.base.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
      return done(.failure("Bad server address."))
    }
    if !query.isEmpty { c.queryItems = query }
    guard let url = c.url else { return done(.failure("Bad server address.")) }
    var req = URLRequest(url: url, timeoutInterval: 20)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: req) { data, resp, err in
      if let err { return done(.failure(err.localizedDescription)) }
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
      if (200..<300).contains(status) { return done(.success(obj)) }
      let code = (obj["error"] as? String) ?? (obj["code"] as? String) ?? ""
      done(.failure(message(status: status, code: code, obj: obj)))
    }.resume()
  }

  static func message(status: Int, code: String, obj: [String: Any]) -> String {
    switch code {
    case "approval_not_waiting": return "This request was already answered, or withdrawn."
    case "approval_expired": return "The time to answer this request has passed."
    case "approval_not_found": return "K2 has no such request for you."
    case "approval_person_only": return "Only the person asked can answer, signed in as themselves."
    case "approval_bad_record": return "K2 didn't accept the signed answer (\(obj["message"] as? String ?? code))."
    default:
      if status == 404 { return "This server doesn't take approvals yet." }
      return "The server answered \(status)\(code.isEmpty ? "" : " (\(code))")."
    }
  }

  static func get(_ r: K2ApprovalViewController.Request, done: @escaping (Result<Fetched>) -> Void) {
    call(r, "cli/approve/get", query: [URLQueryItem(name: "id", value: r.id)]) { res in
      switch res {
      case let .failure(m): done(.failure(m))
      case let .success(o):
        guard let state = o["state"] as? String, let b64 = o["payloadB64"] as? String,
          let bytes = Data(base64Encoded: b64)
        else { return done(.failure("The server's answer had no request in it.")) }
        // Transport check only; the strict reader decides what is shown.
        if let want = o["payloadSha256"] as? String,
          want.lowercased() != K2SHA256.hash(bytes).map({ String(format: "%02x", $0) }).joined()
        {
          return done(.failure("The request arrived damaged. Try again."))
        }
        let by = (o["requestedBy"] as? [String: Any])?["agent"] as? String
        done(.success(Fetched(state: state, bytes: bytes, requestedBy: by)))
      }
    }
  }

  /// `record` nil = decline.
  static func answer(_ r: K2ApprovalViewController.Request, record: String?, done: @escaping (Result<Void>) -> Void) {
    var body: [String: Any] = [
      "id": r.id, "decision": record == nil ? "decline" : "approve", "device": deviceName(), "via": "phone",
    ]
    if let record { body["record"] = record }
    call(r, "cli/approve/answer", body: body) { res in
      switch res {
      case let .failure(m): done(.failure(m))
      case .success: done(.success(()))
      }
    }
  }

  // MARK: present

  static func topmost(_ root: UIViewController?) -> UIViewController? {
    var vc = root
    while let p = vc?.presentedViewController { vc = p }
    return vc
  }

  static func open(
    server: String, url: String, requestId: String, root: UIViewController?,
    done: @escaping (_ outcome: String, _ detail: String?) -> Void
  ) {
    guard let base = URL(string: url), base.scheme == "https" || base.host == "localhost" || base.host == "127.0.0.1",
      requestId.hasPrefix("ap_"), requestId.count <= 64
    else { return done("failed", "bad request") }
    DispatchQueue.main.async {
      guard let top = topmost(root) else { return done("failed", "no view") }
      let vc = K2ApprovalViewController(request: .init(server: server, base: base, id: requestId)) { o, d in
        done(o.rawValue, d)
      }
      top.present(vc, animated: true)
    }
  }

  static func openKeys(root: UIViewController?, done: @escaping () -> Void) {
    DispatchQueue.main.async {
      guard let top = topmost(root) else { return done() }
      let vc = K2ApproverKeysViewController(done: done)
      top.present(UINavigationController(rootViewController: vc), animated: true)
    }
  }

  // MARK: enrolment export (wire contract dated note, S0)

  /// enrol.json for the relying party: the public keys with their check,
  /// view, key id and words, plus App Attest over
  /// "K2-APPROVER-ENROL-1" 0x00 ‖ challenge ‖ SPKI(biometric) ‖ SPKI(credential)
  /// (keys present, in that order). S1 has no challenge route, so the phone
  /// makes the challenge (challenge_from: "device"; K2 11-11).
  /// enrol.json for the relying party: the public keys with their check,
  /// view, key id and words, plus App Attest over
  /// "K2-APPROVER-ENROL-1" 0x00 ‖ challenge ‖ SPKI(biometric) ‖ SPKI(credential)
  /// (keys present, in that order). S1 has no challenge route, so the phone
  /// makes the challenge (challenge_from: "device"; K2 11-11).
  /// The relying party's enrolment challenge: 64 hex (k2sign-admin
  /// enrol-challenge), spaces and case forgiven; nil when it isn't one.
  static func challengeBytes(_ text: String) -> [UInt8]? {
    let hex = text.lowercased().filter { !$0.isWhitespace }
    guard hex.count == 64, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
    var out: [UInt8] = []
    var i = hex.startIndex
    while i < hex.endIndex {
      let j = hex.index(i, offsetBy: 2)
      guard let v = UInt8(hex[i..<j], radix: 16) else { return nil }
      out.append(v)
      i = j
    }
    return out
  }

  /// enrol.json for the relying party (wire contract, dated notes 3 and
  /// S0): the public keys with check, view, key id and words, plus App
  /// Attest over "K2-APPROVER-ENROL-1" 0x00 ‖ challenge ‖ SPKI(biometric) ‖
  /// SPKI(credential) (keys present, in that order). k2sign reads the
  /// top-level `attest_key_id`, `client_data_b64` and `attestation_b64`.
  /// `challenge` is k2sign's (enrol-challenge); without one the phone
  /// makes its own (challenge_from "device"), which k2sign won't take for
  /// --attest.
  static func enrolment(_ keys: [K2ApproverKeys.Key], challenge given: [UInt8]?, done: @escaping ([String: Any]) -> Void) {
    var out: [String: Any] = [
      "v": 1, "kind": "k2-approver-enrol", "platform": "ios", "device": deviceName(),
      "os": "iOS \(UIDevice.current.systemVersion)", "app": "K2 \(appVersion())",
      "made": ISO8601DateFormatter().string(from: Date()),
      "keys": keys.map {
        [
          "file": pemName($0.check), "check": $0.check.rawValue, "view": "device", "alg": "ES256",
          "key_id": $0.keyId, "words": $0.words, "pem": $0.pem,
        ]
      },
    ]
    var challenge = given ?? [UInt8](repeating: 0, count: 32)
    if given == nil { _ = SecRandomCopyBytes(kSecRandomDefault, 32, &challenge) }
    let clientData = K2ApprovalEnrol.clientData(
      challenge: challenge, biometric: keys.first { $0.check == .biometric }?.spki,
      credential: keys.first { $0.check == .credential }?.spki)
    out["challenge_from"] = given == nil ? "device" : "relying_party"
    out["challenge_hex"] = challenge.map { String(format: "%02x", $0) }.joined()
    out["client_data_b64"] = clientData.base64EncodedString()
    out["client_data"] = "K2-APPROVER-ENROL-1 0x00 || challenge || SPKI(biometric) || SPKI(credential)"
    let svc = DCAppAttestService.shared
    guard svc.isSupported else {
      out["attest_error"] = "App Attest isn't supported on this device"
      return done(out)
    }
    svc.generateKey { keyId, err in
      guard let keyId else {
        out["attest_error"] = "generateKey: \(err?.localizedDescription ?? "?")"
        return done(out)
      }
      out["attest_key_id"] = keyId
      svc.attestKey(keyId, clientDataHash: Data(K2SHA256.hash(clientData))) { att, err in
        if let att {
          out["attestation_b64"] = att.base64EncodedString()
        } else {
          out["attest_error"] = "attestKey: \(err?.localizedDescription ?? "?")"
        }
        done(out)
      }
    }
  }

  static func pemName(_ c: K2ApproverKeys.Check) -> String { "k2-approver-\(c.rawValue).pem" }

  /// The files for the Share sheet, in a fresh temporary folder.
  static func shareFiles(_ keys: [K2ApproverKeys.Key], challenge: [UInt8]?, done: @escaping ([URL]) -> Void) {
    enrolment(keys, challenge: challenge) { enrol in
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent("approver-\(UUID().uuidString)")
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var urls: [URL] = []
      for k in keys {
        let u = dir.appendingPathComponent(pemName(k.check))
        if (try? k.pem.write(to: u, atomically: true, encoding: .utf8)) != nil { urls.append(u) }
      }
      let u = dir.appendingPathComponent("k2-approver-enrol.json")
      if let d = try? JSONSerialization.data(withJSONObject: enrol, options: [.prettyPrinted, .sortedKeys]),
        (try? d.write(to: u)) != nil
      {
        urls.append(u)
      }
      done(urls)
    }
  }
}

// MARK: - Approver keys screen

@available(iOS 15.0, *)
final class K2ApproverKeysViewController: UIViewController {
  private let done: () -> Void
  private let stack = UIStackView()
  private let scroll = UIScrollView()
  private let spinner = UIActivityIndicatorView(style: .large)

  init(done: @escaping () -> Void) {
    self.done = done
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:)") }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Approver keys"
    view.backgroundColor = .black
    overrideUserInterfaceStyle = .dark
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.close() })
    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.color = .white
    view.addSubview(scroll)
    view.addSubview(spinner)
    scroll.addSubview(stack)
    let g = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: g.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: g.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: g.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: g.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    render()
  }

  private func close() {
    dismiss(animated: true) { self.done() }
  }

  private func label(_ t: String, size: CGFloat = 17, color: UIColor = .white, weight: UIFont.Weight = .regular)
    -> UILabel
  {
    let l = UILabel()
    l.text = t
    l.numberOfLines = 0
    l.font = .systemFont(ofSize: size, weight: weight)
    l.textColor = color
    return l
  }

  private func button(_ t: String, color: UIColor = .systemBlue, filled: Bool = false, _ action: @escaping () -> Void)
    -> UIButton
  {
    let b = UIButton(type: .system)
    b.setTitle(t, for: .normal)
    b.titleLabel?.font = .systemFont(ofSize: 17, weight: filled ? .semibold : .regular)
    b.setTitleColor(filled ? .white : color, for: .normal)
    if filled { b.backgroundColor = color }
    b.layer.cornerRadius = 14
    b.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    b.addAction(UIAction { _ in action() }, for: .touchUpInside)
    return b
  }

  private func render(note: String? = nil) {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    let keys = K2ApproverKeys.current()
    let muted = UIColor(white: 1, alpha: 0.6)
    stack.addArrangedSubview(
      label(
        "These keys let you approve an agent's request, such as a K2 release, on this iPhone. They never leave it, and each approval needs your face or passcode.",
        size: 15, color: muted))
    if keys.isEmpty {
      stack.addArrangedSubview(
        button("Set up approver keys", filled: true) { [weak self] in
          let r = K2ApproverKeys.makeMissing()
          self?.render(note: r.errors.isEmpty ? nil : "Not made: " + r.errors.joined(separator: "; "))
        })
    } else {
      for k in keys {
        let box = UIStackView()
        box.axis = .vertical
        box.spacing = 6
        box.isLayoutMarginsRelativeArrangement = true
        box.layoutMargins = UIEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        box.backgroundColor = UIColor(white: 1, alpha: 0.08)
        box.layer.cornerRadius = 14
        let name = k.check == .biometric ? "\(K2ApproverKeys.biometryName()) key" : "Passcode key"
        box.addArrangedSubview(label(name, size: 13, color: muted, weight: .semibold))
        box.addArrangedSubview(label(k.words, size: 22, weight: .semibold))
        box.addArrangedSubview(label("Key id \(k.keyId.prefix(16))…", size: 13, color: muted))
        stack.addArrangedSubview(box)
      }
      if keys.count < 2 {
        stack.addArrangedSubview(
          button("Make the missing key") { [weak self] in
            let r = K2ApproverKeys.makeMissing()
            self?.render(note: r.errors.isEmpty ? nil : "Not made: " + r.errors.joined(separator: "; "))
          })
      }
      stack.addArrangedSubview(
        label(
          "To be trusted, these public keys are pinned once where approvals are checked. Whoever pins them reads the six words back to you; they must match this screen.",
          size: 15, color: muted))
      stack.addArrangedSubview(button("Share public keys", filled: true) { [weak self] in self?.share(keys) })
      stack.addArrangedSubview(
        button("Remove keys", color: .systemRed) { [weak self] in
          let a = UIAlertController(
            title: "Remove approver keys?",
            message: "Anything that trusts them will stop accepting approvals from this iPhone until you set up new keys and pin them again.",
            preferredStyle: .alert)
          a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
          a.addAction(
            UIAlertAction(title: "Remove", style: .destructive) { _ in
              K2ApproverKeys.deleteAll()
              self?.render()
            })
          self?.present(a, animated: true)
        })
    }
    if let note { stack.addArrangedSubview(label(note, size: 15, color: .systemRed)) }
  }

  /// Share asks for k2sign's enrolment challenge first (paste the 64 hex
  /// from `k2sign-admin enrol-challenge`); empty lets the phone make one.
  private func share(_ keys: [K2ApproverKeys.Key]) {
    let a = UIAlertController(
      title: "Enrolment challenge",
      message: "Paste the 64 characters from k2sign-admin enrol-challenge. Leave it empty to share without one.",
      preferredStyle: .alert)
    a.addTextField { f in
      f.placeholder = "64 characters"
      f.autocapitalizationType = .none
      f.autocorrectionType = .no
      f.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    }
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    a.addAction(
      UIAlertAction(title: "Share", style: .default) { [weak self, weak a] _ in
        let text = a?.textFields?.first?.text ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          self?.shareNow(keys, challenge: nil)
        } else if let c = K2ApprovalEnrol.challenge(hex: text) {
          self?.shareNow(keys, challenge: c)
        } else {
          self?.render(note: "That isn't a challenge: it should be 64 characters, 0-9 and a-f.")
        }
      })
    present(a, animated: true)
  }

  private func shareNow(_ keys: [K2ApproverKeys.Key], challenge: [UInt8]?) {
    spinner.startAnimating()
    view.isUserInteractionEnabled = false
    K2Approvals.shareFiles(keys, challenge: challenge) { urls in
      DispatchQueue.main.async {
        self.spinner.stopAnimating()
        self.view.isUserInteractionEnabled = true
        let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = self.view
        self.present(sheet, animated: true)
      }
    }
  }

}
