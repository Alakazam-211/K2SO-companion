// Signed approvals: the phone's native approval screen (K2 PRD
// prd-signed-approvals-v1 §5, SA-8). The web view only asks to open a
// request by id; this screen fetches the bytes itself, checks them with the
// strict reader (K2Approval), shows the words worked out from them, runs
// Face ID or the passcode, signs those exact bytes, and posts the record to
// the daemon's answer route (wire contract, dated note 2).
//
// What comes from the daemon beside the bytes (who asked) is shown as the
// daemon's report, never as part of what is approved (SA-11).

import Foundation
import K2Approval
import UIKit

@available(iOS 15.0, *)
final class K2ApprovalViewController: UIViewController {
  struct Request {
    let server: String
    let base: URL
    let id: String
  }

  enum Outcome: String {
    case approved, declined, closed, failed
  }

  private let request: Request
  private let finish: (Outcome, String?) -> Void
  private var finished = false
  private var payload: K2ApprovalPayload?

  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private let buttons = UIStackView()
  private let spinner = UIActivityIndicatorView(style: .large)

  init(request: Request, finish: @escaping (Outcome, String?) -> Void) {
    self.request = request
    self.finish = finish
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    isModalInPresentation = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:)") }

  // MARK: layout

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    overrideUserInterfaceStyle = .dark

    let title = UILabel()
    title.text = "Approval request"
    title.font = .systemFont(ofSize: 17, weight: .semibold)
    title.textColor = .white
    title.textAlignment = .center

    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)

    buttons.axis = .vertical
    buttons.spacing = 10
    buttons.translatesAutoresizingMaskIntoConstraints = false

    title.translatesAutoresizingMaskIntoConstraints = false
    spinner.translatesAutoresizingMaskIntoConstraints = false
    spinner.color = .white
    view.addSubview(title)
    view.addSubview(scroll)
    view.addSubview(buttons)
    view.addSubview(spinner)

    let g = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      title.topAnchor.constraint(equalTo: g.topAnchor, constant: 14),
      title.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
      title.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
      scroll.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
      scroll.leadingAnchor.constraint(equalTo: g.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: g.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -8),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
      buttons.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
      buttons.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
      buttons.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -12),
      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    load()
  }

  private func clear() {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
  }

  private func label(_ text: String, size: CGFloat = 17, color: UIColor = .white, weight: UIFont.Weight = .regular)
    -> UILabel
  {
    let l = UILabel()
    l.text = text
    l.numberOfLines = 0
    l.font = .systemFont(ofSize: size, weight: weight)
    l.textColor = color
    l.lineBreakMode = .byCharWrapping
    return l
  }

  /// A tile like the app's `.k2-tile` rows: the bytes' own words.
  private func tile(_ lines: [String]) -> UIView {
    let box = UIView()
    box.backgroundColor = UIColor(white: 1, alpha: 0.08)
    box.layer.cornerRadius = 14
    let text = UILabel()
    text.numberOfLines = 0
    text.lineBreakMode = .byCharWrapping
    text.textColor = .white
    text.font = .systemFont(ofSize: 17)
    text.text = lines.joined(separator: "\n")
    text.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(text)
    NSLayoutConstraint.activate([
      text.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
      text.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -14),
      text.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 16),
      text.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -16),
    ])
    return box
  }

  private func button(_ title: String, style: Int, action: @escaping () -> Void) -> UIButton {
    // style 0: filled blue, 1: plain blue, 2: plain red
    let b = UIButton(type: .system)
    b.setTitle(title, for: .normal)
    b.titleLabel?.font = .systemFont(ofSize: 17, weight: style == 0 ? .semibold : .regular)
    b.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
    b.layer.cornerRadius = 14
    switch style {
    case 0:
      b.backgroundColor = .systemBlue
      b.setTitleColor(.white, for: .normal)
    case 2:
      b.setTitleColor(.systemRed, for: .normal)
    default:
      b.setTitleColor(.systemBlue, for: .normal)
    }
    b.addAction(UIAction { _ in action() }, for: .touchUpInside)
    return b
  }

  private func busy(_ on: Bool) {
    on ? spinner.startAnimating() : spinner.stopAnimating()
    buttons.isUserInteractionEnabled = !on
    buttons.alpha = on ? 0.4 : 1
  }

  private func done(_ o: Outcome, _ detail: String? = nil) {
    guard !finished else { return }
    finished = true
    dismiss(animated: true) { self.finish(o, detail) }
  }

  // MARK: states

  private func load() {
    clear()
    busy(true)
    K2Approvals.get(request) { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        self.busy(false)
        switch result {
        case let .failure(msg): self.showMessage("Couldn't load this request", msg, retry: true)
        case let .success(got): self.show(got)
        }
      }
    }
  }

  private func showMessage(_ head: String, _ body: String, retry: Bool = false, decline: Bool = false) {
    clear()
    stack.addArrangedSubview(label(head, size: 20, weight: .semibold))
    stack.addArrangedSubview(label(body, color: UIColor(white: 1, alpha: 0.7)))
    if retry { buttons.addArrangedSubview(button("Try again", style: 0) { [weak self] in self?.load() }) }
    if decline { buttons.addArrangedSubview(button("Decline", style: 2) { [weak self] in self?.answer(nil) }) }
    buttons.addArrangedSubview(button("Close", style: 1) { [weak self] in self?.done(.closed) })
  }

  private func show(_ got: K2Approvals.Fetched) {
    guard got.state == "waiting" else {
      let words = [
        "approved": "This request was already approved.", "declined": "This request was declined.",
        "expired": "This request expired.", "cancelled": "The request was withdrawn.",
      ]
      return showMessage("Nothing to answer", words[got.state] ?? "This request is \(got.state).")
    }
    let p: K2ApprovalPayload
    do {
      p = try K2ApprovalPayload.parse(got.bytes)
    } catch let r as K2ApprovalRefusal {
      return showMessage(
        "K2 can't show this request",
        "What it asks to approve breaks one of the rules approvals must follow (\(r.code.rawValue)), so it can't be approved on this phone.",
        decline: true)
    } catch {
      return showMessage("K2 can't show this request", "\(error.localizedDescription)", decline: true)
    }
    payload = p
    clear()

    // Which of this phone's keys the request accepts.
    let mine = K2ApproverKeys.current().filter { p.approverKeys.contains($0.keyId) }
    let bio = mine.first { $0.check == .biometric }
    let cred = mine.first { $0.check == .credential }
    let expired = Int64(Date().timeIntervalSince1970) > p.answerByAt

    stack.addArrangedSubview(tile(p.lines))
    let check = bio != nil ? K2ApproverKeys.biometryName() : cred != nil ? "your passcode" : nil
    if let check {
      stack.addArrangedSubview(
        label("Your approval is signed on this iPhone, with \(check).", size: 15, color: UIColor(white: 1, alpha: 0.7)))
    }
    if let agent = got.requestedBy, !agent.isEmpty {
      stack.addArrangedSubview(
        label(
          "K2 says \(agent) asked for this. That name isn't part of what you sign.", size: 15,
          color: UIColor(white: 1, alpha: 0.5)))
    }

    if mine.isEmpty {
      stack.addArrangedSubview(label("This request can only be approved on another device.", weight: .semibold))
    } else if expired {
      stack.addArrangedSubview(label("This request has expired, so it can't be approved now. Ask for a new one from the agent.", weight: .semibold))
    } else {
      if bio != nil {
        buttons.addArrangedSubview(
          button("Approve with \(K2ApproverKeys.biometryName())", style: 0) { [weak self] in self?.approve(.biometric) })
      }
      if cred != nil {
        buttons.addArrangedSubview(
          button(bio == nil ? "Approve with passcode" : "Use passcode instead", style: bio == nil ? 0 : 1) {
            [weak self] in self?.approve(.credential)
          })
      }
    }
    buttons.addArrangedSubview(button("Decline", style: 2) { [weak self] in self?.answer(nil) })
    buttons.addArrangedSubview(button("Decide later", style: 1) { [weak self] in self?.done(.closed) })
  }

  // MARK: answer

  private func approve(_ c: K2ApproverKeys.Check) {
    guard let p = payload, let key = K2ApproverKeys.current().first(where: { $0.check == c }),
      p.approverKeys.contains(key.keyId)
    else { return }
    busy(true)
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let sig = try K2ApproverKeys.sign(c, bytes: p.bytes, reason: p.promptReason)
        let record = K2ApprovalRecord.json(payload: p.bytes, keyId: key.keyId, signatureDER: sig)
        DispatchQueue.main.async { self.answer(record) }
      } catch {
        DispatchQueue.main.async {
          self.busy(false)
          if !K2ApproverKeys.isCancel(error) {
            self.stack.addArrangedSubview(
              self.label("The phone didn't sign: \(error.localizedDescription)", size: 15, color: .systemRed))
          }
        }
      }
    }
  }

  /// `record` nil = decline (unsigned).
  private func answer(_ record: String?) {
    busy(true)
    K2Approvals.answer(request, record: record) { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        self.busy(false)
        switch result {
        case .success:
          if record != nil {
            self.clear()
            self.stack.addArrangedSubview(self.label("Approved", size: 22, weight: .semibold))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.done(.approved) }
          } else {
            self.done(.declined)
          }
        case let .failure(msg):
          self.showMessage("Your answer wasn't sent", msg, retry: false)
          if record != nil {
            self.buttons.insertArrangedSubview(
              self.button("Send again", style: 0) { [weak self] in self?.answer(record) }, at: 0)
          }
        }
      }
    }
  }
}
