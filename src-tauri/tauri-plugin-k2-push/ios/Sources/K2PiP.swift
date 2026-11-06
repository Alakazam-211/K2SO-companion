// Picture in Picture for a call's remote video (voice plan M8, "Video on the
// shim"). Fed by Sew's native sink (`open_native_sink(ActiveSpeaker,
// 640×360)`, voice.rs `PipSink`) while the call has video; the debug
// `pipTest` op feeds it too.
//
// Placement: one layer for the call screen and for PiP, never recreated.
// - Hidden spot (default): a small view (64×36 pt) at the BOTTOM of the
//   webview's window, under the root view controller's view. PiP needs the
//   layer in a window and not hidden (isHidden, alpha 0 or no window make
//   `isPictureInPicturePossible` false, and the automatic start needs it
//   "visible"); the webview covers it. Small keeps the compositing cheap.
// - The call screen's tile: `callOp pipFrame {x, y, w, h, visible, radius?}`
//   moves the same view ABOVE the webview at the page's placeholder (points,
//   in the webview's coordinates) with rounded corners; `visible: false`
//   sends it back to the hidden spot. Only its place among the window's
//   subviews changes, so it never leaves the window. PiP's start and restore
//   animations run from wherever it is.
// - The mini tile's snap: `pipFrame`'s `animate` moves the view from where it
//   is now to the new frame on its own, on the render server: a
//   CASpringAnimation per axis with the page's mass, stiffness, damping and
//   release velocity (the page runs the same spring in JS on its tile, so
//   the two stay together), or an ease-out (Reduce Motion). It starts when
//   the page's tile shows the start (`startedAt` + `pageLag`). Any frame
//   without `animate` stops it where it is and puts the view there.
// - Touches: `isUserInteractionEnabled = false`, so every touch goes through
//   to the webview under it (the page's tile takes the tap that starts PiP).
// - Aspect fit (`resizeAspect`), not fill: a shared screen or a portrait
//   camera keeps its edges, and PiP keeps the gravity it always had. The
//   view is clear: before the first frame and in the bars the page's tile
//   shows through (`pip_first_frame` / `pip_cleared` tell it which).
// - A device without PiP (the simulator) still gets the layer, for the tile.
//
// The Rust seam:
// - Frames don't go through `run_mobile_plugin` (JSON on the main run loop:
//   far too slow for video). Swift exports C entry points with `@_cdecl`,
//   which the k2-push crate declares `extern "C"` (`pip::h264`,
//   `pip::pixel_buffer`, `pip::flush`; the plugin's static library is
//   already linked into the app):
//     k2_pip_h264(ptr, len, pts_90k)          — one Annex-B access unit
//     k2_pip_pixel_buffer(cvpixelbuffer, pts) — one decoded VP8 frame
//                                               (Sew's `apple_pixel_buffer`)
//     k2_pip_flush(remove_image)              — Sew's reset, switch or discontinuity
//   (`enqueue(i420:)` is there too, should the planes ever be all we get.)
// - Called on Sew's sink thread (never main). Pointers are borrowed for the
//   call only: `enqueue(h264:)` runs `queue.sync`, copies (the AVCC repack)
//   and returns, so Rust frees or reuses its buffer at once. One memcpy per
//   frame (tens of KB), and no Rust lifetime tied to Core Media. A
//   CVPixelBuffer crosses borrowed, no copy: Swift takes its own retain
//   (`takeUnretainedValue`, held by the queued closure) before returning.
// - pts: Sew's arrival time as CMTime(value, 90_000). Samples are
//   DisplayImmediately, so it only orders; it never delays.
// - Control: `callOp pipLayer {on}` puts the layer in the window when the
//   sink opens (PiP's automatic start needs frames playing inline before
//   the app leaves the screen) and takes it down when it closes; `callOp
//   pip {on}` starts or stops PiP itself. Events go to the UI as `pip` and
//   to Rust: `pip_keyframe` → the sink's keyframe request (after a flush or
//   a start mid-GOP), `pip_render_size` → its `set_max_size`. The page's
//   tile reads `pip_first_frame` (the first frame since a flush),
//   `pip_cleared` (the image went) and `pip_started`/`pip_stopped`.
// - Teardown: Rust closes the sink first, then `pipLayer off`, so no frame
//   races it (a late frame finds no layer and is dropped). `callOp end` and
//   `report ended` tear down too.

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

// ── Rust's entry points (k2-push `pip`), on Sew's sink thread ─────────

/// One H.264 Annex-B access unit, copied before this returns.
@_cdecl("k2_pip_h264")
public func k2PiPH264(_ bytes: UnsafePointer<UInt8>?, _ len: Int, _ pts90k: Int64) {
  guard #available(iOS 15.0, *) else { return }
  guard let bytes = bytes, len > 0 else { return }
  K2PiP.shared.enqueue(
    h264: UnsafeRawBufferPointer(start: bytes, count: len), pts: CMTime(value: pts90k, timescale: 90_000))
}

/// One decoded (VP8) frame's CVPixelBufferRef, borrowed for the call: the
/// queued closure holds its own retain.
@_cdecl("k2_pip_pixel_buffer")
public func k2PiPPixelBuffer(_ buffer: UnsafeMutableRawPointer?, _ pts90k: Int64) {
  guard #available(iOS 15.0, *) else { return }
  guard let buffer = buffer else { return }
  let pixelBuffer = Unmanaged<CVPixelBuffer>.fromOpaque(buffer).takeUnretainedValue()
  K2PiP.shared.enqueue(pixelBuffer: pixelBuffer, pts: CMTime(value: pts90k, timescale: 90_000))
}

/// One decoded I420 frame (kessel-video's software VP8 decoder), read
/// during the call: K2NV12Pool copies it into an NV12 pixel buffer.
@_cdecl("k2_pip_i420")
public func k2PiPI420(
  _ width: UInt32, _ height: UInt32, _ y: UnsafePointer<UInt8>?, _ strideY: UInt32,
  _ u: UnsafePointer<UInt8>?, _ strideU: UInt32, _ v: UnsafePointer<UInt8>?, _ strideV: UInt32, _ pts90k: Int64
) {
  guard #available(iOS 15.0, *) else { return }
  guard let y = y, let u = u, let v = v, width > 0, height > 0 else { return }
  let frame = K2I420Frame(
    width: Int(width), height: Int(height), y: y, strideY: Int(strideY), u: u, strideU: Int(strideU), v: v,
    strideV: Int(strideV))
  K2PiP.shared.enqueue(i420: frame, pts: CMTime(value: pts90k, timescale: 90_000))
}

/// One decoded NV12 frame (Sew's native sink asks the VP8 decoder for
/// NV12), read during the call and copied into a pooled pixel buffer.
@_cdecl("k2_pip_nv12")
public func k2PiPNV12(
  _ width: UInt32, _ height: UInt32, _ y: UnsafePointer<UInt8>?, _ strideY: UInt32,
  _ uv: UnsafePointer<UInt8>?, _ strideUV: UInt32, _ pts90k: Int64
) {
  guard #available(iOS 15.0, *) else { return }
  guard let y = y, let uv = uv, width > 0, height > 0 else { return }
  K2PiP.shared.enqueue(
    nv12: Int(width), Int(height), y: y, strideY: Int(strideY), uv: uv, strideUV: Int(strideUV),
    pts: CMTime(value: pts90k, timescale: 90_000))
}

/// The stream broke or switched: flush, then wait for a keyframe.
@_cdecl("k2_pip_flush")
public func k2PiPFlush(_ removeImage: Bool) {
  guard #available(iOS 15.0, *) else { return }
  K2PiP.shared.flush(removeImage: removeImage)
}

/// `pipFrame`'s `animate`: seconds; a spring (else ease-out); points/s;
/// when the page started it (seconds since 1970).
struct K2TileMotion {
  let duration: Double
  let spring: (mass: Double, stiffness: Double, damping: Double)?
  let velocity: CGVector
  let startedAt: Double?
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

  /// The app's webview: tile rects are in its points. Set by the plugin.
  weak var webView: UIView?

  // Main thread.
  private var view: K2PiPView?
  private var controller: AVPictureInPictureController?
  private var possible: NSKeyValueObservation?
  /// The page's tile (`pipFrame`), nil while it isn't on screen. Kept across
  /// teardown: the next layer goes straight there.
  private var tile: (rect: CGRect, radius: CGFloat)?
  /// The layer shows a frame (`pip_first_frame` since the last clear).
  private var hasFrame = false
  private static let hiddenFrame = CGRect(x: 0, y: 0, width: 64, height: 36)

  // `queue`: every frame goes through it.
  private let queue = DispatchQueue(label: "k2.pip")
  private var layer: AVSampleBufferDisplayLayer?
  private let packer = K2H264Packer()
  private let pool = K2NV12Pool()
  private var lastKeyframeAsk: CFAbsoluteTime = 0
  /// No frame enqueued since the layer came or was last flushed.
  private var awaitingFrame = true

  // ── Window and controller (main) ───────────────────────────────────

  /// The layer in the window and, where the device has PiP, a controller on
  /// it (the call screen's tile shows video either way). False when there is
  /// no window yet.
  @discardableResult
  func prepare() -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    if view != nil { return true }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    guard let window = webView?.window ?? windows.first(where: { $0.isKeyWindow }) ?? windows.first else {
      pipLog("no window")
      return false
    }
    let v = K2PiPView(frame: Self.hiddenFrame)
    v.isUserInteractionEnabled = false
    v.backgroundColor = .clear
    v.layer.masksToBounds = true
    v.displayLayer.videoGravity = .resizeAspect
    window.insertSubview(v, at: 0)
    view = v
    place()

    if AVPictureInPictureController.isPictureInPictureSupported() {
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
      controller = c
    } else {
      pipLog("no PiP on this device: the tile only")
    }
    let layer = v.displayLayer
    queue.async {
      self.layer = layer
      self.packer.reset()
      self.awaitingFrame = true
    }
    return true
  }

  /// `pipFrame`: the page's tile at `rect` (webview points), or nil when it
  /// isn't on screen. Before the layer exists, kept for it. `motion`: get
  /// there from where it is on that curve (only from one tile to another).
  func setTile(_ rect: CGRect?, radius: CGFloat, motion: K2TileMotion? = nil) -> [String: Any] {
    dispatchPrecondition(condition: .onQueue(.main))
    let was = tile != nil
    tile = rect.map { ($0, max(0, radius)) }
    place(motion: was ? motion : nil)
    if was != (tile != nil) {
      pipLog("tile \(tile != nil ? "on" : "off"), possible=\(controller?.isPictureInPicturePossible ?? false)")
    }
    return state()
  }

  /// The view over the webview at the tile, or back in the hidden spot.
  /// Same superview either way: only the order changes, so PiP never sees
  /// the layer leave its window.
  private func place(motion: K2TileMotion? = nil) {
    guard let v = view, let window = v.superview else { return }
    if let t = tile, let web = webView, web.window === window, t.rect.width > 0, t.rect.height > 0 {
      let frame = web.convert(t.rect, to: window)
      if let m = motion, m.duration > 0, v.frame != Self.hiddenFrame {
        move(v, to: frame, m)
      } else {
        stopMotion(v)
        v.frame = frame
      }
      v.layer.cornerRadius = t.radius
      window.bringSubviewToFront(v)
    } else {
      stopMotion(v)
      v.frame = Self.hiddenFrame
      v.layer.cornerRadius = 0
      window.sendSubviewToBack(v)
    }
  }

  private static let motionKeys = ["k2.tile.x", "k2.tile.y", "k2.tile.size"]
  /// How much later than its JS the page's tile reaches the screen: about
  /// one frame (simulator, recorded: started at once, the layer led the
  /// tile by about a frame; started this late, a still release's snap
  /// showed next to no drift). The one constant to tune on a device.
  private static let pageLag: Double = 1.0 / 60

  /// Stop a snap where it is: the next frame set is where the view goes.
  private func stopMotion(_ v: UIView) {
    for key in Self.motionKeys { v.layer.removeAnimation(forKey: key) }
  }

  /// The view to `frame` from where it shows now (mid-snap included), on
  /// `m`'s curve. The model goes straight to `frame`; the animations only
  /// draw the way there, removed when done.
  private func move(_ v: UIView, to frame: CGRect, _ m: K2TileMotion) {
    let layer = v.layer
    let shown = layer.presentation() ?? layer
    let fromPosition = shown.position
    let fromSize = shown.bounds.size
    stopMotion(v)
    v.frame = frame
    let toPosition = layer.position
    let toSize = layer.bounds.size
    // Start it when the page's tile shows the same motion: the page started
    // it `trip` ago, and its frames reach the screen about `pageLag` after
    // its JS runs (WebContent → app → render server), while ours go
    // straight to the render server. Until then the layer holds where it is.
    let trip = m.startedAt.map { Date().timeIntervalSince1970 - $0 } ?? 0
    let delay = min(0.05, max(-0.1, Self.pageLag - trip))
    let begin = layer.convertTime(CACurrentMediaTime() + delay, from: nil)
    func add(_ key: String, _ path: String, from: Any, to: Any, distance: CGFloat, velocity: CGFloat) {
      let a: CABasicAnimation
      if let s = m.spring {
        let spring = CASpringAnimation(keyPath: path)
        spring.mass = CGFloat(s.mass)
        spring.stiffness = CGFloat(s.stiffness)
        spring.damping = CGFloat(s.damping)
        // Core Animation's spring velocity is relative to the distance.
        spring.initialVelocity = abs(distance) >= 0.5 ? velocity / distance : 0
        a = spring
      } else {
        a = CABasicAnimation(keyPath: path)
        a.timingFunction = CAMediaTimingFunction(name: .easeOut)
      }
      a.fromValue = from
      a.toValue = to
      a.duration = m.duration
      a.beginTime = begin
      a.fillMode = .backwards
      layer.add(a, forKey: key)
    }
    let dx = toPosition.x - fromPosition.x
    let dy = toPosition.y - fromPosition.y
    if abs(dx) >= 0.25 {
      add(
        "k2.tile.x", "position.x", from: NSNumber(value: Double(fromPosition.x)),
        to: NSNumber(value: Double(toPosition.x)), distance: dx, velocity: m.velocity.dx)
    }
    if abs(dy) >= 0.25 {
      add(
        "k2.tile.y", "position.y", from: NSNumber(value: Double(fromPosition.y)),
        to: NSNumber(value: Double(toPosition.y)), distance: dy, velocity: m.velocity.dy)
    }
    if abs(fromSize.width - toSize.width) >= 0.25 || abs(fromSize.height - toSize.height) >= 0.25 {
      add(
        "k2.tile.size", "bounds.size", from: NSValue(cgSize: fromSize), to: NSValue(cgSize: toSize), distance: 0,
        velocity: 0)
    }
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
      "tile": tile != nil,
      "frame": hasFrame,
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
      if let layer = self.layer { self.flush(layer, removeImage: true) }
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

  /// (d) then (a): one decoded NV12 frame, read only during the call.
  func enqueue(
    nv12 w: Int, _ h: Int, y: UnsafePointer<UInt8>, strideY: Int, uv: UnsafePointer<UInt8>, strideUV: Int, pts: CMTime
  ) {
    queue.sync {
      guard layer != nil else { return }
      do {
        pushPixelBuffer(
          try pool.pixelBuffer(nv12: w, h, y: y, strideY: strideY, uv: uv, strideUV: strideUV), pts: pts)
      } catch {
        pipLog("nv12: \(error)")
      }
    }
  }

  /// (a) A decoded frame the caller already holds as a pixel buffer.
  func enqueue(pixelBuffer: CVPixelBuffer, pts: CMTime) {
    queue.async { self.pushPixelBuffer(pixelBuffer, pts: pts) }
  }

  /// A break in the stream (Sew's reset, switch or discontinuity): drop what
  /// the layer holds and take nothing until the next keyframe, which Sew
  /// sends next. `removeImage` when there's nobody left to show.
  func flush(removeImage: Bool) {
    queue.sync {
      guard let layer = layer else { return }
      flush(layer, removeImage: removeImage)
      packer.requireKeyframe()
    }
  }

  // ── Frames (queue) ─────────────────────────────────────────────────

  private func pushH264(_ bytes: UnsafeRawBufferPointer, pts: CMTime) {
    guard let layer = layer else { return }
    recover(layer)
    do {
      switch try packer.pack(annexB: bytes, pts: pts) {
      case .sample(let sample, _):
        Self.enqueue(sample, on: layer)
        shown()
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
      shown()
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
    flush(layer, removeImage: false)
    packer.requireKeyframe()
    askKeyframe()
  }

  /// A flush on the queue. The next frame is a first frame again; without
  /// its image the layer is clear and the page's tile shows through.
  private func flush(_ layer: AVSampleBufferDisplayLayer, removeImage: Bool) {
    Self.flush(layer, removeImage: removeImage)
    awaitingFrame = true
    if removeImage {
      DispatchQueue.main.async { self.hasFrame = false }
      emit(["event": "pip_cleared"])
    }
  }

  /// A frame went to the layer: the first since the last flush tells the page.
  private func shown() {
    guard awaitingFrame else { return }
    awaitingFrame = false
    DispatchQueue.main.async { self.hasFrame = true }
    emit(["event": "pip_first_frame"])
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

  /// Back to the app: PiP shrinks back into the layer, the call screen's
  /// tile when it's on screen.
  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(true)
  }
}
