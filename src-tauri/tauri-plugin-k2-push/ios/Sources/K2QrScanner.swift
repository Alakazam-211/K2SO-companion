// K2 Companion QR scanner — "Pair with a code" (K2 0.46.4
// `companion-pairing-v1`): the desktop's "Pair a phone" shows a QR holding
// `https://<label>.k2.dev/pair#K2P-…`; this reads it without leaving the app.
//
//   scanQr  A full-screen camera view (AVCaptureMetadataOutput, QR only)
//           with a Cancel button. Resolves `{text, cancelled, denied}`
//           (text "" unless a code was read):
//           the first QR's text; cancelled when closed; denied when the
//           camera is off for K2 (Settings). The JS side parses the text.
//
// Camera permission is asked on first use (NSCameraUsageDescription). Only
// one scanner at a time.

import Tauri
import UIKit
import AVFoundation

private func scanResult(_ text: String?, denied: Bool = false) -> [String: Any] {
  ["text": text ?? "", "cancelled": text == nil, "denied": denied]
}

final class K2QrScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private var done = false
  var onFinish: ((String?) -> Void)?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(for: .video),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      finish(nil)
      return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      finish(nil)
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    if output.availableMetadataObjectTypes.contains(.qr) {
      output.metadataObjectTypes = [.qr]
    }

    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer

    let frame = UIView()
    frame.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
    frame.layer.borderWidth = 2
    frame.layer.cornerRadius = 22
    frame.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(frame)

    let hint = UILabel()
    hint.text = "Point at the QR code on your computer"
    hint.textColor = .white
    hint.font = .systemFont(ofSize: 15, weight: .semibold)
    hint.textAlignment = .center
    hint.numberOfLines = 0
    hint.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hint)

    let cancel = UIButton(type: .system)
    cancel.setTitle("Cancel", for: .normal)
    cancel.setTitleColor(.white, for: .normal)
    cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
    cancel.backgroundColor = UIColor.white.withAlphaComponent(0.18)
    cancel.layer.cornerRadius = 22
    cancel.contentEdgeInsets = UIEdgeInsets(top: 0, left: 22, bottom: 0, right: 22)
    cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    cancel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(cancel)

    let g = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      frame.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -20),
      frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.68),
      frame.heightAnchor.constraint(equalTo: frame.widthAnchor),
      hint.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 24),
      hint.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
      hint.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -24),
      cancel.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
      cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      cancel.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let s = session
    DispatchQueue.global(qos: .userInitiated).async {
      if !s.isRunning { s.startRunning() }
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    let s = session
    DispatchQueue.global(qos: .userInitiated).async {
      if s.isRunning { s.stopRunning() }
    }
    // Swiped down (a sheet) or otherwise closed without a code.
    finish(nil)
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !done else { return }
    for obj in metadataObjects {
      if let code = obj as? AVMetadataMachineReadableCodeObject, code.type == .qr,
         let text = code.stringValue, !text.isEmpty {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(text)
        dismiss(animated: true)
        return
      }
    }
  }

  @objc private func cancelTapped() {
    finish(nil)
    dismiss(animated: true)
  }

  private func finish(_ text: String?) {
    if done { return }
    done = true
    onFinish?(text)
  }
}

@available(iOS 14.0, *)
enum K2QrScanner {
  /// The live scanner (one at a time).
  private static var active: K2QrScannerController?

  static func scan(_ invoke: Invoke, root: UIViewController?) {
    DispatchQueue.main.async {
      if active != nil {
        invoke.reject("busy: a scanner is already open")
        return
      }
      let present = {
        guard let presenter = K2PickerIO.presenter(root) else {
          invoke.reject("unsupported: no view controller to present from")
          return
        }
        let vc = K2QrScannerController()
        vc.modalPresentationStyle = .fullScreen
        vc.onFinish = { text in
          active = nil
          invoke.resolve(scanResult(text))
        }
        active = vc
        presenter.present(vc, animated: true)
      }
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        present()
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { granted in
          DispatchQueue.main.async {
            if granted { present() } else { invoke.resolve(scanResult(nil, denied: true)) }
          }
        }
      default:
        invoke.resolve(scanResult(nil, denied: true))
      }
    }
  }
}
