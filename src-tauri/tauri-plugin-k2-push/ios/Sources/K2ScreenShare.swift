// The iPhone screen share's app side (the call screen's Share screen):
//   - `callOp appGroup` → `{ok, path}`: the App Group's container, which
//     Rust hands to the voice plugin (`screen_share_ring`) once a call is
//     connected. The plugin makes its ring there (`sew-screen.ring`) and the
//     broadcast extension (K2Broadcast) attaches to the same file.
//   - `callOp broadcastPicker` → `{ok}`: iOS's broadcast picker, with K2's
//     extension chosen. A broadcast can only start from the person's tap on
//     RPSystemBroadcastPickerView: this taps the picker's own button on
//     their behalf, from their tap on Share screen. The share starts with
//     the extension's first frame (the plugin's `screen_share_changed`), not
//     here: the person may still cancel iOS's sheet.

import Foundation
#if canImport(ReplayKit) && os(iOS)
  import ReplayKit
  import UIKit
#endif

enum K2ScreenShare {
  static let appGroupId = "group.com.alakazamlabs.k2so.companion"
  /// K2Broadcast's bundle id (project.yml), the picker's preferred extension.
  static let extensionId = "com.alakazamlabs.k2so.companion.Broadcast"

  /// The App Group's container, or nil (the entitlement is missing).
  static func containerPath() -> String? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?.path
  }

  #if canImport(ReplayKit) && os(iOS)
    /// The picker, kept in the key window (iOS presents its sheet from a
    /// picker in the view hierarchy). Main thread only.
    private static var picker: RPSystemBroadcastPickerView?

    /// Opens iOS's broadcast sheet with K2's extension chosen. Main thread.
    static func showPicker() -> Bool {
      guard
        let window = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .flatMap({ $0.windows })
          .first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first
      else { return false }
      let view = picker ?? RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
      view.preferredExtension = extensionId
      view.showsMicrophoneButton = false
      view.alpha = 0.011  // in the hierarchy, invisible, still "visible" to UIKit
      view.isUserInteractionEnabled = false
      if view.superview !== window { window.addSubview(view) }
      picker = view
      guard let button = view.subviews.compactMap({ $0 as? UIButton }).first else { return false }
      button.sendActions(for: .touchUpInside)
      return true
    }

    /// Closes iOS's broadcast sheet once the share started or stopped: it
    /// has no close button of its own. Only a presented controller that is
    /// ReplayKit's picker (its class name says so); anything else stays.
    /// Main thread. True when it closed one.
    static func closePicker() -> Bool {
      guard let sheet = presentedPicker() else { return false }
      sheet.dismiss(animated: true)
      return true
    }

    /// Stop sharing without iOS's "stopped due to" alert: the same sheet,
    /// where the person taps Stop Broadcast (an app that ends the broadcast
    /// itself always gets the alert). `done(true)` once the sheet is gone,
    /// whether they stopped or closed it; `done(false)`: it didn't open.
    /// Main thread.
    static func showPickerUntilClosed(_ done: @escaping (Bool) -> Void) {
      guard showPicker() else { return done(false) }
      var seen = false
      var waited = 0.0
      func check() {
        DispatchQueue.main.asyncAfter(deadline: .now() + pollSeconds) {
          waited += pollSeconds
          if presentedPicker() != nil {
            seen = true
          } else if seen || waited >= appearSeconds {
            return done(true)
          }
          if waited >= giveUpSeconds { return done(true) }
          check()
        }
      }
      check()
    }

    private static let pollSeconds = 0.25
    /// A sheet that never showed (its class not recognised): stop waiting.
    private static let appearSeconds = 1.5
    private static let giveUpSeconds = 600.0

    private static func presentedPicker() -> UIViewController? {
      let roots = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .flatMap({ $0.windows })
        .compactMap({ $0.rootViewController })
      for root in roots {
        var top = root
        while let next = top.presentedViewController {
          if isPicker(next) { return next }
          top = next
        }
      }
      return nil
    }

    private static func isPicker(_ vc: UIViewController) -> Bool {
      let name = NSStringFromClass(type(of: vc))
      return name.hasPrefix("RP") && name.contains("Broadcast")
    }
  #endif
}
