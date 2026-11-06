// The broadcast upload extension's frame rules (K2Broadcast's SampleHandler),
// no ReplayKit or UIKit, so the macOS check runs them too:
//   cd src-tauri/tauri-plugin-k2-push/ios && swift run BroadcastCheck
// ONE source: project.yml adds this file to the K2Broadcast target.
//
// The extension copies nothing itself: kessel-frame-ring's push copies the
// NV12 planes into the ring, scaled down to fit the app's box (at most
// 1280 x 720, either way round) with a box filter. ReplayKit's buffers are
// already NV12 (`420f`, sometimes `420v`), so there is no conversion and no
// second buffer: the extension stays far under its 50 MB. These are the
// rules around that push: the turn, the colour, the planes, the rate, the
// timestamp, what each answer means, and the sentences ReplayKit shows.

import CoreVideo
import Foundation

public enum K2BroadcastFrames {
  /// The App Group the app and the extension share; the ring is in its
  /// container (the app's voice plugin makes it once a call is connected).
  public static let appGroupId = "group.com.alakazamlabs.k2so.companion"
  /// The ring's file in that container (Sew's `screen_ring::RING_FILE`).
  public static let ringFile = "sew-screen.ring"
  /// The share's highest rate (the ring drops faster frames anyway; this
  /// skips locking and copying them).
  public static let maxFps: UInt64 = 15
  /// How often the extension asks the ring whether the app wants it to stop
  /// when no frames come (iOS sends screen frames only when the screen
  /// changes).
  public static let stopPollSeconds = 0.5

  // ── The turn ────────────────────────────────────────────────────────

  /// `RPVideoSampleOrientationKey`'s value (a `CGImagePropertyOrientation`
  /// raw value) → the ring's rotation: the clockwise quarter turns that
  /// stand the frame upright. `.up` 0, `.right` 90, `.down` 180, `.left`
  /// 270 (Sew's contract); a mirrored one turns as its plain one (ReplayKit
  /// never mirrors the screen); none or unknown: 0.
  public static func rotation(orientation raw: UInt32?) -> UInt32 {
    switch raw {
    case 1, 2: return 0  // up, upMirrored
    case 3, 4: return 180  // down, downMirrored
    case 6, 7: return 90  // right, rightMirrored
    case 8, 5: return 270  // left, leftMirrored
    default: return 0
    }
  }

  // ── The colour ──────────────────────────────────────────────────────

  /// The ring's colour for a pixel format: `420v` 1 (BT.709 limited),
  /// `420f` 2 (BT.709 full). `nil`: not NV12, skip the frame.
  public static func color(pixelFormat: OSType) -> UInt32? {
    switch pixelFormat {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: return 1
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange: return 2
    default: return nil
    }
  }

  // ── The planes ──────────────────────────────────────────────────────

  /// What `kfr_producer_push_nv12` takes from a locked pixel buffer: each
  /// plane's base, its bytes per row and its length (bytes per row x the
  /// plane's rows).
  public struct Planes {
    public let y: UnsafePointer<UInt8>
    public let yLen: Int
    public let yStride: Int
    public let uv: UnsafePointer<UInt8>
    public let uvLen: Int
    public let uvStride: Int
    public let width: UInt32
    public let height: UInt32
  }

  /// The planes of a pixel buffer locked read-only, or `nil` when it isn't
  /// two-plane NV12 or a plane has no memory. Valid until it is unlocked.
  public static func planes(_ pb: CVPixelBuffer) -> Planes? {
    guard color(pixelFormat: CVPixelBufferGetPixelFormatType(pb)) != nil,
      CVPixelBufferIsPlanar(pb), CVPixelBufferGetPlaneCount(pb) == 2,
      let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0),
      let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)
    else { return nil }
    let width = CVPixelBufferGetWidth(pb)
    let height = CVPixelBufferGetHeight(pb)
    guard width > 0, height > 0, width <= Int(UInt32.max), height <= Int(UInt32.max) else { return nil }
    let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    let uvStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    return Planes(
      y: UnsafePointer(y.assumingMemoryBound(to: UInt8.self)),
      yLen: yStride * CVPixelBufferGetHeightOfPlane(pb, 0),
      yStride: yStride,
      uv: UnsafePointer(uv.assumingMemoryBound(to: UInt8.self)),
      uvLen: uvStride * CVPixelBufferGetHeightOfPlane(pb, 1),
      uvStride: uvStride,
      width: UInt32(width),
      height: UInt32(height))
  }

  // ── The rate ────────────────────────────────────────────────────────

  /// At most `fps` frames a second on average, by their timestamps: each
  /// kept frame books the next slot one interval after the last slot (not
  /// after the frame), and a frame up to a quarter interval early takes it,
  /// so a jittery 15 fps source isn't halved and a 60 fps one gives 15. A
  /// gap resets the cadence; so does a clock that went back a long way.
  public struct Gate {
    public let interval: UInt64
    public private(set) var nextDue: UInt64?

    public init(fps: UInt64 = K2BroadcastFrames.maxFps) {
      interval = 1_000_000_000 / max(fps, 1)
    }

    public mutating func admit(_ ns: UInt64) -> Bool {
      guard let due = nextDue, ns.addingReportingOverflow(2 * interval).partialValue >= due else {
        nextDue = ns &+ interval
        return true
      }
      if ns &+ interval / 4 < due { return false }
      nextDue = ns > due &+ interval ? ns &+ interval : due &+ interval
      return true
    }
  }

  // ── The timestamp ───────────────────────────────────────────────────

  /// The frame's presentation time for the ring, in ns on the host clock
  /// (`kfr_monotonic_ns`, which is CMClock's host time), when it looks like
  /// one: within 2 s of `now`. Otherwise (no time, another clock) 0, which
  /// the ring reads as "now"; the push happens as the frame arrives anyway.
  public static func timestamp(ptsSeconds: Double?, now: UInt64) -> UInt64 {
    guard let s = ptsSeconds, s.isFinite, s > 0 else { return 0 }
    let ns = s * 1_000_000_000
    guard ns < Double(UInt64.max) else { return 0 }
    let t = UInt64(ns)
    let window: UInt64 = 2_000_000_000
    let gap = t > now ? t - now : now - t
    return gap <= window ? t : 0
  }

  // ── The answers ─────────────────────────────────────────────────────

  public enum Pushed: Equatable {
    /// Written, or dropped (the app doesn't want frames now, or too soon).
    case fine
    /// This frame didn't describe itself (-1): skip it, keep sharing.
    case skip
    /// The ring is broken (-4: it shrank under the extension; or any other
    /// code below -1): finish the broadcast.
    case broken
  }

  /// What a `kfr_producer_push_nv12` answer means.
  public static func pushed(_ code: Int32) -> Pushed {
    switch code {
    case 0, 1, 2: return .fine
    case -1: return .skip
    default: return code < -1 ? .broken : .fine
    }
  }

  /// Why the extension finishes the broadcast itself (or never starts).
  public enum End: Equatable {
    /// `kfr_producer_attach` failed with this code.
    case attach(Int32)
    /// The App Group's container isn't there (a signing problem).
    case noGroup
    /// The app asked it to stop: Stop sharing in K2, or the call ended.
    case stopped
    /// The ring broke mid-share.
    case broken

    /// `kfr_producer_finish`'s reason: 2 closed (the app's stop), 3 failed.
    public var ringReason: UInt32 {
      self == .stopped ? 2 : 3
    }

    /// The sentence iOS shows when the broadcast ends ("… stopped due to: ").
    public var message: String {
      switch self {
      case .attach(-2): return "Join a call in K2 first, then share your screen."
      case .attach(-3): return "Your screen is already being shared."
      case .attach(-4): return "Update K2 to share your screen."
      case .attach, .noGroup: return "K2 couldn't share your screen. Try again from the call."
      case .stopped: return "You stopped sharing your screen in K2, or the call ended."
      case .broken: return "Screen sharing stopped. Share again from the call."
      }
    }

    /// The error's code (`attach`: the ring's own).
    public var code: Int {
      switch self {
      case .attach(let c): return Int(c)
      case .noGroup: return -100
      case .stopped: return 1
      case .broken: return -101
      }
    }
  }
}
