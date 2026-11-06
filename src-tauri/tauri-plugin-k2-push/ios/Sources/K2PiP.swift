// Picture in Picture for a call's remote video (voice plan M8, "Video on the
// shim"). Groundwork: Sew's `open_native_sink(track | ActiveSpeaker,
// max_size)` doesn't exist yet. Until it does, only the debug `pipTest` op
// feeds this.
//
// Placement: the display layer lives in a small view (64×36 pt) inserted at
// the BOTTOM of the app's key window, under the root view controller's view.
// PiP needs the layer in a window and not hidden (isHidden, alpha 0 or no
// window make `isPictureInPicturePossible` false, and the automatic start
// needs it "visible"), but the user should never see it inline: the webview
// covers it. Small keeps the hidden compositing cheap. When the app grows an
// in-call video view, move this view there instead: PiP's start and restore
// animations run from the layer's frame.
//
// Rust seam (when `open_native_sink` lands):
// - Frames don't go through `run_mobile_plugin` (JSON on the main run loop:
//   far too slow for video). Swift exports C entry points with `@_cdecl`,
//   which the k2-push crate declares `extern "C"` (the plugin's static
//   library is already linked into the app):
//     k2_pip_h264(ptr, len, pts_90k)              — one Annex-B access unit
//     k2_pip_i420(w, h, y, sy, u, su, v, sv, pts) — one decoded VP8 frame
//     k2_pip_pixel_buffer(cvpixelbuffer_ref, pts) — +1 retained, if Sew's
//                                                   decoder ever hands one
// - Called on Sew's sink thread (never main). Pointers are borrowed for the
//   call only: `enqueue(h264:)` and `enqueue(i420:)` run `queue.sync`, copy
//   (AVCC repack / I420 → NV12, both copies anyway) and return, so Rust
//   frees or reuses its buffer at once. That costs one memcpy per frame
//   (tens of KB for H.264, ~0.3 MB for 640×360 I420) and never ties a Rust
//   lifetime to Core Media. A CVPixelBuffer crosses with its retain
//   (`Unmanaged.takeRetainedValue`), no copy.
// - pts: the RTP timestamp as CMTime(value, 90_000). Samples are
//   DisplayImmediately, so it only orders; it never delays.
// - Control stays on `callOp` (`pip`) and events: `pip_render_size` →
//   Sew's `max_size`, `pip_keyframe` → Sew's keyframe request (PLI) after a
//   flush or a start mid-GOP; `pip_started`/`pip_stopped` → the sink's
//   ActiveSpeaker on or off. Today these reach the UI as the `pip` event;
//   voice.rs ignores unknown shim events, so sending them to Rust later is
//   safe.
// - Teardown: `callOp end` (or `report ended`) closes PiP and drops the
//   layer; Rust closes the sink first so no frame races the teardown (a
//   late frame finds no layer and is dropped).

import AVFoundation
import AVKit
import CoreMedia
import K2VideoFrames
import UIKit
import os.log

private func pipLog(_ message: String) {
  os_log("[K2PiP] %{public}@", log: OSLog(subsystem: "com.alakazamlabs.k2so.companion", category: "k2pip"), type: .default, message)
}

/// The call ended: close PiP (callOp `end` / `report ended`).
func k2PiPCallEnded() {
  if #available(iOS 15.0, *) { K2PiP.shared.teardown() }
}

/// A view whose own layer is the display layer.
private final class K2PiPView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

@available(iOS 15.0, *)
final class K2PiP: NSObject {
  static let shared = K2PiP()

  /// `{"event": "pip_…"}` for the UI. Set once by the plugin.
  var onEvent: (([String: Any]) -> Void)?

  // Main thread.
  private var view: K2PiPView?
  private var controller: AVPictureInPictureController?
  private var possible: NSKeyValueObservation?

  // `queue`: every frame goes through it.
  private let queue = DispatchQueue(label: "k2.pip")
  private var layer: AVSampleBufferDisplayLayer?
  private let packer = K2H264Packer()
  private let pool = K2NV12Pool()
  private var lastKeyframeAsk: CFAbsoluteTime = 0

  // ── Window and controller (main) ───────────────────────────────────

  /// The layer in the window and a controller on it. False when the device
  /// has no PiP or there is no window yet.
  @discardableResult
  func prepare() -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    if controller != nil { return true }
    guard AVPictureInPictureController.isPictureInPictureSupported() else {
      pipLog("not supported on this device")
      return false
    }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    guard let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first else {
      pipLog("no window")
      return false
    }
    let v = K2PiPView(frame: CGRect(x: 0, y: 0, width: 64, height: 36))
    v.isUserInteractionEnabled = false
    v.backgroundColor = .black
    v.displayLayer.videoGravity = .resizeAspect
    window.insertSubview(v, at: 0)

    let source = AVPictureInPictureController.ContentSource(
      sampleBufferDisplayLayer: v.displayLayer, playbackDelegate: self)
    let c = AVPictureInPictureController(contentSource: source)
    c.delegate = self
    c.canStartPictureInPictureAutomaticallyFromInline = true
    // Live: no skip buttons, no scrubbing.
    c.requiresLinearPlayback = true
    possible = c.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] c, _ in
      self?.emit(["event": "pip_possible", "possible": c.isPictureInPicturePossible])
    }
    view = v
    controller = c
    let layer = v.displayLayer
    queue.async {
      self.layer = layer
      self.packer.reset()
    }
    return true
  }

  /// `pip {on?}`: start or stop it now; no `on` just answers the state.
  func op(on: Bool?) -> [String: Any] {
    dispatchPrecondition(condition: .onQueue(.main))
    switch on {
    case true?:
      if prepare(), let c = controller, c.isPictureInPicturePossible, !c.isPictureInPictureActive {
        c.startPictureInPicture()
      }
    case false?:
      controller?.stopPictureInPicture()
    case nil:
      break
    }
    return state()
  }

  func state() -> [String: Any] {
    [
      "ok": true,
      "supported": AVPictureInPictureController.isPictureInPictureSupported(),
      "prepared": controller != nil,
      "possible": controller?.isPictureInPicturePossible ?? false,
      "active": controller?.isPictureInPictureActive ?? false,
    ]
  }

  /// The call ended: PiP closes, the layer goes. Any thread.
  func teardown() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { self.teardown() }
      return
    }
    #if DEBUG
    stopTestPattern()
    #endif
    guard controller != nil || view != nil else { return }
    controller?.stopPictureInPicture()
    possible = nil
    controller = nil
    view?.removeFromSuperview()
    view = nil
    queue.async {
      if let layer = self.layer { Self.flush(layer, removeImage: true) }
      self.layer = nil
      self.packer.reset()
    }
    pipLog("torn down")
  }

  // ── Frames (any thread) ────────────────────────────────────────────

  /// (b) One H.264 Annex-B access unit, read only during the call.
  func enqueue(h264 bytes: UnsafeRawBufferPointer, pts: CMTime) {
    queue.sync { pushH264(bytes, pts: pts) }
  }

  /// (c) then (a): one decoded I420 frame, read only during the call.
  func enqueue(i420 frame: K2I420Frame, pts: CMTime) {
    queue.sync { pushI420(frame, pts: pts) }
  }

  /// (a) A decoded frame the caller already holds as a pixel buffer.
  func enqueue(pixelBuffer: CVPixelBuffer, pts: CMTime) {
    queue.async { self.pushPixelBuffer(pixelBuffer, pts: pts) }
  }

  // ── Frames (queue) ─────────────────────────────────────────────────

  private func pushH264(_ bytes: UnsafeRawBufferPointer, pts: CMTime) {
    guard let layer = layer else { return }
    recover(layer)
    do {
      switch try packer.pack(annexB: bytes, pts: pts) {
      case .sample(let sample, _):
        Self.enqueue(sample, on: layer)
      case .dropped(.waitingForKeyframe), .dropped(.noParameterSets):
        askKeyframe()
      case .dropped(.empty):
        break
      }
    } catch {
      pipLog("h264: \(error)")
      packer.requireKeyframe()
      askKeyframe()
    }
  }

  private func pushI420(_ frame: K2I420Frame, pts: CMTime) {
    guard layer != nil else { return }
    do {
      pushPixelBuffer(try pool.pixelBuffer(from: frame), pts: pts)
    } catch {
      pipLog("i420: \(error)")
    }
  }

  private func pushPixelBuffer(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
    guard let layer = layer else { return }
    recover(layer)
    // Every decoded frame stands alone: when the layer is behind, drop it.
    guard Self.ready(layer) else { return }
    do {
      Self.enqueue(try K2VideoFrames.sampleBuffer(pixelBuffer: pixelBuffer, pts: pts), on: layer)
    } catch {
      pipLog("frame: \(error)")
    }
  }

  /// A failed layer (or one the system interrupted) takes nothing until it
  /// is flushed; after the flush, H.264 needs a keyframe.
  private func recover(_ layer: AVSampleBufferDisplayLayer) {
    let failed = Self.status(layer) == .failed
    guard failed || Self.needsFlush(layer) else { return }
    pipLog(failed ? "layer failed (\(Self.error(layer).map { "\($0)" } ?? "?")): flush" : "flush to resume")
    Self.flush(layer, removeImage: false)
    packer.requireKeyframe()
    askKeyframe()
  }

  /// At most one keyframe request a second.
  private func askKeyframe() {
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastKeyframeAsk > 1 else { return }
    lastKeyframeAsk = now
    emit(["event": "pip_keyframe"])
  }

  private func emit(_ event: [String: Any]) {
    onEvent?(event)
  }

  // ── The layer's renderer (iOS 17 moved it to `sampleBufferRenderer`) ──

  private static func enqueue(_ sample: CMSampleBuffer, on layer: AVSampleBufferDisplayLayer) {
    if #available(iOS 17.0, *) { layer.sampleBufferRenderer.enqueue(sample) } else { layer.enqueue(sample) }
  }

  private static func status(_ layer: AVSampleBufferDisplayLayer) -> AVQueuedSampleBufferRenderingStatus {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.status }
    return layer.status
  }

  private static func error(_ layer: AVSampleBufferDisplayLayer) -> Error? {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.error }
    return layer.error
  }

  private static func needsFlush(_ layer: AVSampleBufferDisplayLayer) -> Bool {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.requiresFlushToResumeDecoding }
    return layer.requiresFlushToResumeDecoding
  }

  private static func ready(_ layer: AVSampleBufferDisplayLayer) -> Bool {
    if #available(iOS 17.0, *) { return layer.sampleBufferRenderer.isReadyForMoreMediaData }
    return layer.isReadyForMoreMediaData
  }

  private static func flush(_ layer: AVSampleBufferDisplayLayer, removeImage: Bool) {
    if #available(iOS 17.0, *) {
      layer.sampleBufferRenderer.flush(removingDisplayedImage: removeImage, completionHandler: nil)
    } else if removeImage {
      layer.flushAndRemoveImage()
    } else {
      layer.flush()
    }
  }

  // ── Debug test pattern ─────────────────────────────────────────────

  #if DEBUG
  private var pattern: DispatchSourceTimer?
  private var ownSession = false

  /// `pipTest {on, state?}`: a moving picture through the path Sew's frames
  /// will take, at 30 fps. Raw (default): I420 → NV12 pool → sample. `state:
  /// "h264"`: two loops pre-encoded with VideoToolbox (640×360, then 480×270,
  /// 2 s each) replayed as Annex-B access units, so the keyframe start and a
  /// resolution change run too. Pre-encoded because the hardware encoder
  /// stops in the background and PiP is all about the background.
  /// Without a call, plays its own `.playback` audio session: PiP needs an
  /// active one (a call has CallKit's).
  func startTestPattern(h264: Bool, callActive: Bool) -> [String: Any] {
    dispatchPrecondition(condition: .onQueue(.main))
    stopTestPattern()
    guard prepare() else { return ["ok": false, "error": "pip_unavailable"] }
    if !callActive {
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .moviePlayback)
        try session.setActive(true)
        ownSession = true
      } catch {
        pipLog("test session: \(error)")
      }
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    queue.async {
      var units: [Data] = []
      if h264 {
        do {
          units = try Self.encodeLoop(640, 360, start: 0) + Self.encodeLoop(480, 270, start: 60)
        } catch {
          pipLog("test encoder: \(error); raw frames instead")
        }
      }
      let raw = K2TestPattern(width: 640, height: 360)
      var n = 0
      timer.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(3))
      timer.setEventHandler { [weak self] in
        guard let self = self else { return }
        let pts = CMTime(value: Int64(n) * 3000, timescale: 90_000)
        if units.isEmpty {
          raw.withFrame(n) { self.pushI420($0, pts: pts) }
        } else {
          units[n % units.count].withUnsafeBytes { self.pushH264($0, pts: pts) }
        }
        n += 1
      }
      timer.resume()
    }
    pattern = timer
    pipLog("test pattern on (\(h264 ? "h264" : "raw"))")
    return state().merging(["mode": h264 ? "h264" : "raw"]) { $1 }
  }

  func stopTestPattern() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let timer = pattern else { return }
    timer.cancel()
    pattern = nil
    if ownSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      ownSession = false
    }
    pipLog("test pattern off")
  }

  /// 60 frames (2 s at 30 fps), keyframe first.
  private static func encodeLoop(_ w: Int, _ h: Int, start: Int) throws -> [Data] {
    let encoder = try K2H264TestEncoder(width: w, height: h)
    let pattern = K2TestPattern(width: w, height: h)
    let pool = K2NV12Pool()
    return try (0..<60).compactMap { i in
      let pb = try pattern.withFrame(start + i) { try pool.pixelBuffer(from: $0) }
      return try encoder.encode(pb, pts: CMTime(value: Int64(i), timescale: 30), keyframe: i == 0)?.annexB
    }
  }
  #endif
}

// ── PiP's delegates ──────────────────────────────────────────────────

@available(iOS 15.0, *)
extension K2PiP: AVPictureInPictureSampleBufferPlaybackDelegate {
  /// Live: there's nothing to pause.
  func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}

  /// Live content: an unbounded range (PiP shows no scrubber).
  func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
    CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool {
    false
  }

  /// The PiP window's pixels: what Sew's `max_size` should become.
  func pictureInPictureController(
    _ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions
  ) {
    emit(["event": "pip_render_size", "width": Int(newRenderSize.width), "height": Int(newRenderSize.height)])
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime,
    completion completionHandler: @escaping () -> Void
  ) {
    completionHandler()
  }

  /// The call's audio keeps going while PiP is up.
  func pictureInPictureControllerShouldProhibitBackgroundAudioPlayback(
    _ controller: AVPictureInPictureController
  ) -> Bool {
    false
  }
}

@available(iOS 15.0, *)
extension K2PiP: AVPictureInPictureControllerDelegate {
  func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
    emit(["event": "pip_started"])
  }

  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    emit(["event": "pip_stopped"])
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error
  ) {
    pipLog("failed to start: \(error)")
    emit(["event": "pip_failed", "error": "\(error.localizedDescription)"])
  }

  /// Back to the app: there's no inline view to restore into yet.
  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(true)
  }
}
