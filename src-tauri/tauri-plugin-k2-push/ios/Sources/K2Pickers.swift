// K2 Companion native pickers — the composer's attach menu (AttachMenu.tsx).
//
// The web `<input type="file">` makes iOS show its own Photo Library /
// Take Photo / Choose Files menu and drops the keyboard. The composer has
// its own menu instead; its Photo Library and Choose Files rows land here:
//
//   pickMedia      PHPickerViewController, images + videos, multi-select.
//                  Out-of-process picker: no photo-library permission.
//   pickDocuments  UIDocumentPickerViewController (any type, as copies).
//
// Both resolve `{files: [{name, mime, base64}], skipped: [{name, reason}],
// cancelled}`. Files over `maxBytes` (or past `maxTotalBytes` for the whole
// pick, so ten big videos can't exhaust memory over IPC) are skipped and
// reported, never silently dropped. Only one picker at a time.

import Tauri
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import os.log

private func pickerLog(_ message: String) {
  os_log("[K2Picker] %{public}@", log: OSLog(subsystem: "com.alakazamlabs.k2so.companion", category: "k2picker"), type: .default, message)
}

struct PickArgs: Decodable {
  let limit: Int?
  let maxBytes: Int?
  let maxTotalBytes: Int?
}

/// Size budget for one pick, shared by every file it reads.
final class PickBudget {
  let maxBytes: Int
  private let maxTotalBytes: Int
  private var used = 0
  private let lock = NSLock()

  init(_ args: PickArgs) {
    maxBytes = max(1, args.maxBytes ?? 50_000_000)
    maxTotalBytes = max(1, args.maxTotalBytes ?? 100_000_000)
  }

  /// nil = take it; else the skip reason.
  func admit(_ size: Int) -> String? {
    if size > maxBytes { return "too large" }
    lock.lock()
    defer { lock.unlock() }
    if used + size > maxTotalBytes { return "total size limit" }
    used += size
    return nil
  }
}

/// One picked file, or why it was left out.
enum PickOutcome {
  case file(name: String, mime: String, base64: String)
  case skipped(name: String, reason: String)
}

@available(iOS 14.0, *)
enum K2PickerIO {
  static let queue = DispatchQueue(label: "k2.picker.read", qos: .userInitiated)

  /// Read `url` within the budget.
  static func read(_ url: URL, name: String, mime: String, budget: PickBudget) -> PickOutcome {
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
    if size < 0 { return .skipped(name: name, reason: "unreadable") }
    if let reason = budget.admit(size) { return .skipped(name: name, reason: reason) }
    guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
      return .skipped(name: name, reason: "unreadable")
    }
    return .file(name: name, mime: mime, base64: data.base64EncodedString())
  }

  static func mime(for type: UTType?) -> String {
    type?.preferredMIMEType ?? "application/octet-stream"
  }

  static func resolve(_ invoke: Invoke, _ outcomes: [PickOutcome], cancelled: Bool) {
    var files: [JsonObject] = []
    var skipped: [JsonObject] = []
    for o in outcomes {
      switch o {
      case .file(let name, let mime, let base64):
        files.append(["name": name, "mime": mime, "base64": base64])
      case .skipped(let name, let reason):
        skipped.append(["name": name, "reason": reason])
      }
    }
    if !skipped.isEmpty { pickerLog("skipped \(skipped.count) file(s)") }
    invoke.resolve(["files": files, "skipped": skipped, "cancelled": cancelled])
  }

  /// The view controller to present over: the topmost presented one.
  static func presenter(_ root: UIViewController?) -> UIViewController? {
    var vc = root
    if vc == nil {
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      vc = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })?.rootViewController
    }
    while let next = vc?.presentedViewController, !next.isBeingDismissed { vc = next }
    return vc
  }
}

/// Owns one presented picker until it finishes. Resolves its invoke once.
@available(iOS 14.0, *)
final class K2PickerSession: NSObject, PHPickerViewControllerDelegate,
  UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate
{
  private let invoke: Invoke
  private let budget: PickBudget
  private var finished = false
  private let onDone: () -> Void

  init(invoke: Invoke, args: PickArgs, onDone: @escaping () -> Void) {
    self.invoke = invoke
    self.budget = PickBudget(args)
    self.onDone = onDone
  }

  private func finish(_ outcomes: [PickOutcome], cancelled: Bool) {
    DispatchQueue.main.async {
      guard !self.finished else { return }
      self.finished = true
      K2PickerIO.resolve(self.invoke, outcomes, cancelled: cancelled)
      self.onDone()
    }
  }

  // ── Photo Library (PHPicker) ────────────────────────────────────────

  func presentMedia(limit: Int, from presenter: UIViewController) {
    var config = PHPickerConfiguration()
    config.selectionLimit = limit
    config.filter = .any(of: [.images, .videos])
    // JPEG / H.264 where the original is HEIC / HEVC: what the web input
    // gave before, and what agents can read.
    config.preferredAssetRepresentationMode = .compatible
    if #available(iOS 15.0, *) { config.selection = .ordered }
    let picker = PHPickerViewController(configuration: config)
    picker.delegate = self
    picker.presentationController?.delegate = self
    presenter.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    if results.isEmpty {
      finish([], cancelled: true)
      return
    }
    var slots = [PickOutcome?](repeating: nil, count: results.count)
    let group = DispatchGroup()
    let lock = NSLock()
    for (i, result) in results.enumerated() {
      let provider = result.itemProvider
      let fallbackName = provider.suggestedName ?? "attachment-\(i + 1)"
      guard let typeId = Self.preferredType(provider) else {
        lock.lock()
        slots[i] = .skipped(name: fallbackName, reason: "unsupported type")
        lock.unlock()
        continue
      }
      group.enter()
      provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, error in
        // The temp file only lives inside this callback: read it here.
        let type = UTType(typeId)
        var outcome: PickOutcome
        if let url = url {
          let name = Self.fileName(provider.suggestedName, url: url, type: type)
          outcome = K2PickerIO.read(url, name: name, mime: K2PickerIO.mime(for: type), budget: self.budget)
        } else {
          pickerLog("loadFileRepresentation failed: \(error?.localizedDescription ?? "?")")
          outcome = .skipped(name: fallbackName, reason: "unreadable")
        }
        lock.lock()
        slots[i] = outcome
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: K2PickerIO.queue) {
      self.finish(slots.compactMap { $0 }, cancelled: false)
    }
  }

  /// Movie first; for images JPEG / PNG over HEIC when the provider has both.
  static func preferredType(_ provider: NSItemProvider) -> String? {
    let ids = provider.registeredTypeIdentifiers
    let types = ids.compactMap { UTType($0) }
    if let movie = types.first(where: { $0.conforms(to: .movie) }) { return movie.identifier }
    for want in [UTType.jpeg, UTType.png] where ids.contains(want.identifier) {
      return want.identifier
    }
    if let image = types.first(where: { $0.conforms(to: .image) }) { return image.identifier }
    return ids.first
  }

  /// `suggestedName` + the type's extension; else the temp file's name.
  static func fileName(_ suggested: String?, url: URL, type: UTType?) -> String {
    let ext = type?.preferredFilenameExtension ?? url.pathExtension
    guard let base = suggested, !base.isEmpty else { return url.lastPathComponent }
    if ext.isEmpty || base.lowercased().hasSuffix("." + ext.lowercased()) { return base }
    return "\(base).\(ext)"
  }

  // ── Choose Files (UIDocumentPicker) ─────────────────────────────────

  func presentDocuments(from presenter: UIViewController) {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
    picker.allowsMultipleSelection = true
    picker.delegate = self
    picker.presentationController?.delegate = self
    presenter.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    K2PickerIO.queue.async {
      let outcomes: [PickOutcome] = urls.map { url in
        let type = UTType(filenameExtension: url.pathExtension)
        let out = K2PickerIO.read(url, name: url.lastPathComponent, mime: K2PickerIO.mime(for: type), budget: self.budget)
        // asCopy: the copy is ours to remove.
        try? FileManager.default.removeItem(at: url)
        return out
      }
      self.finish(outcomes, cancelled: false)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish([], cancelled: true)
  }

  // Swipe-down dismissal of either sheet.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish([], cancelled: true)
  }
}

/// Entry points used by K2PushPlugin's `pickMedia` / `pickDocuments`.
enum K2Pickers {
  /// The live session (a delegate must outlive its presentation).
  private static var active: NSObject?

  static func pick(_ invoke: Invoke, media: Bool, root: UIViewController?) {
    let args = (try? invoke.parseArgs(PickArgs.self)) ?? PickArgs(limit: nil, maxBytes: nil, maxTotalBytes: nil)
    DispatchQueue.main.async {
      guard #available(iOS 14.0, *) else {
        invoke.reject("unsupported: native pickers need iOS 14")
        return
      }
      if active != nil {
        invoke.reject("busy: a picker is already open")
        return
      }
      guard let presenter = K2PickerIO.presenter(root) else {
        invoke.reject("unsupported: no view controller to present from")
        return
      }
      let session = K2PickerSession(invoke: invoke, args: args) { active = nil }
      active = session
      if media {
        session.presentMedia(limit: min(max(args.limit ?? 10, 1), 10), from: presenter)
      } else {
        session.presentDocuments(from: presenter)
      }
    }
  }
}
