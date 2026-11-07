// K2 Broadcast Upload Extension: the iPhone screen share in a voice-room
// call. iOS captures the screen only here, in a separate process the person
// starts from iOS's broadcast picker (the call bar's Share screen). This
// process never sees a key and encodes nothing: it copies each screen frame
// into Sew's ring (kessel-frame-ring 0.1, libk2_broadcast_ring.a through
// kessel_frame_ring.h) in the App Group's container, and the app's voice
// plugin reads, encodes, encrypts and publishes it as the call's screen.
//
// Sew's contract (native-voice-sdk.md, "Screen share on iPhone"), on ONE
// serial queue (a producer isn't thread-safe; ReplayKit calls from its own):
//   1. broadcastStarted: attach to <container>/sew-screen.ring (-2: the app
//      isn't in a call; say so and finish), then start.
//   2. each video frame: nothing unless the app wants frames; at most 15 a
//      second (K2BroadcastFrames.Gate); lock the pixel buffer read-only and
//      push planes 0 and 1 with the turn from RPVideoSampleOrientationKey,
//      the colour from the pixel format and the host-clock time; unlock. The
//      ring scales the frame into the app's box (at most 1280 x 720) as it
//      copies: no conversion here, no buffer of our own, nothing allocated
//      per frame (the extension's limit is about 50 MB). -1: skip the frame;
//      -4 or anything below -1: the ring broke, finish.
//   3. stop_requested, on each frame and every 0.5 s (iOS sends frames only
//      when the screen changes): the call ended or Stop sharing in K2;
//      finish.
//   4. broadcastFinished: finish the producer (1), last and once.
// The rules themselves (turn, colour, planes, rate, timestamp, answers,
// sentences) are K2BroadcastFrames.swift, checked on macOS by BroadcastCheck.
//
// iOS ends a suspended process holding a file lock in a shared container
// (0xdead10cc): the producer holds its lock while attached, so it is
// finished as soon as the broadcast ends, whichever side ends it.

import CoreMedia
import CoreVideo
import Foundation
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
  /// Every producer call, one at a time.
  private let queue = DispatchQueue(label: "com.alakazamlabs.k2so.companion.Broadcast.ring", qos: .userInitiated)
  /// The ring while attached (a `KfrProducer *`). Only on `queue`.
  private var producer: OpaquePointer?
  private var gate = K2BroadcastFrames.Gate()
  private var poll: DispatchSourceTimer?

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    queue.sync { self.attach() }
  }

  override func broadcastPaused() {}

  override func broadcastResumed() {}

  override func broadcastFinished() {
    queue.sync { self.release(reason: 1) }
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    // The screen only: no app or microphone audio (the call has its own).
    guard sampleBufferType == .video else { return }
    // In line, never queued: a frame the ring can't take now is dropped,
    // and ReplayKit's buffers are never held past this call.
    queue.sync { self.push(sampleBuffer) }
  }

  // MARK: On `queue`

  private func attach() {
    guard producer == nil else { return }
    guard
      let dir = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: K2BroadcastFrames.appGroupId)
    else { return finish(.noGroup) }
    let path = dir.appendingPathComponent(K2BroadcastFrames.ringFile).path
    var error: Int32 = 0
    guard let p = path.withCString({ kfr_producer_attach($0, &error) }) else {
      return finish(.attach(error))
    }
    guard kfr_producer_start(p) == 0 else {
      kfr_producer_finish(p, 3)
      return finish(.attach(-6))
    }
    producer = p
    gate = K2BroadcastFrames.Gate()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let every = DispatchTimeInterval.milliseconds(Int(K2BroadcastFrames.stopPollSeconds * 1000))
    timer.schedule(deadline: .now() + every, repeating: every, leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in self?.checkStop() }
    timer.resume()
    poll = timer
  }

  private func checkStop() {
    guard let p = producer else { return }
    if kfr_producer_stop_requested(p) { end(.stopped) }
  }

  private func push(_ sample: CMSampleBuffer) {
    guard let p = producer else { return }
    if kfr_producer_stop_requested(p) { return end(.stopped) }
    // The app is away (or the ring shrank: the next push says so): no lock,
    // no copy.
    guard kfr_producer_wants_frames(p) else { return }
    let now = kfr_monotonic_ns()
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    let ts = K2BroadcastFrames.timestamp(ptsSeconds: pts.isValid ? pts.seconds : nil, now: now)
    guard gate.admit(ts == 0 ? now : ts) else { return }
    guard let pb = CMSampleBufferGetImageBuffer(sample),
      let color = K2BroadcastFrames.color(pixelFormat: CVPixelBufferGetPixelFormatType(pb))
    else { return }
    let orientation =
      (CMGetAttachment(sample, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?
      .uint32Value
    let rotation = K2BroadcastFrames.rotation(orientation: orientation)
    guard CVPixelBufferLockBaseAddress(pb, .readOnly) == kCVReturnSuccess else { return }
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let planes = K2BroadcastFrames.planes(pb) else { return }
    let code = kfr_producer_push_nv12(
      p, planes.y, planes.yLen, planes.yStride, planes.uv, planes.uvLen, planes.uvStride,
      planes.width, planes.height, rotation, color, ts)
    if K2BroadcastFrames.pushed(code) == .broken { end(.broken) }
  }

  /// The extension ends the broadcast itself: the producer first, then iOS.
  private func end(_ why: K2BroadcastFrames.End) {
    release(reason: why.ringReason)
    finish(why)
  }

  /// Finishes the producer (its lock on the shared file goes with it), once.
  private func release(reason: UInt32) {
    poll?.cancel()
    poll = nil
    guard let p = producer else { return }
    producer = nil
    kfr_producer_finish(p, reason)
  }

  /// Ends the broadcast with the sentence iOS shows. Off `queue`: iOS may
  /// call broadcastFinished from inside it.
  private func finish(_ why: K2BroadcastFrames.End) {
    let error = NSError(
      domain: "com.alakazamlabs.k2so.companion.Broadcast", code: why.code,
      userInfo: [NSLocalizedDescriptionKey: why.message])
    DispatchQueue.main.async { self.finishBroadcastWithError(error) }
  }
}
