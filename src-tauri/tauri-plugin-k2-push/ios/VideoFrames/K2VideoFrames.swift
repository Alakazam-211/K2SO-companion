// Video frames for Picture in Picture (K2PiP), the pure half: no UIKit, so
// the macOS check (PiPCheck) runs the same code.
//   (a) a decoded CVPixelBuffer → CMSampleBuffer (VP8, after Sew's decoder);
//   (b) an H.264 Annex-B access unit → AVCC CMSampleBuffer (K2H264Packer);
//   (c) an I420 frame → NV12 CVPixelBuffer from a pool (K2NV12Pool).
// Every sample is marked DisplayImmediately: live video has no clock to keep,
// a frame shows when it arrives.
//
// Not thread-safe: K2PiP calls all of it from its one queue.

import CoreMedia
import CoreVideo
import Foundation

public enum K2VideoError: Error, Equatable, CustomStringConvertible {
  case status(String, OSStatus)
  case badFrame(String)

  public var description: String {
    switch self {
    case .status(let what, let status): return "\(what): OSStatus \(status)"
    case .badFrame(let why): return "bad frame: \(why)"
    }
  }
}

@inline(__always)
func check(_ status: OSStatus, _ what: String) throws {
  if status != noErr { throw K2VideoError.status(what, status) }
}

public enum K2VideoFrames {
  // ── (a) Decoded frames ─────────────────────────────────────────────

  /// A decoded frame as a sample the display layer shows at once.
  public static func sampleBuffer(pixelBuffer: CVPixelBuffer, pts: CMTime) throws -> CMSampleBuffer {
    var format: CMVideoFormatDescription?
    try check(
      CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer, formatDescriptionOut: &format),
      "image format")
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    try check(
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer, formatDescription: format!,
        sampleTiming: &timing, sampleBufferOut: &sample),
      "image sample")
    markLive(sample!, keyframe: nil)
    return sample!
  }

  // ── Attachments ────────────────────────────────────────────────────

  /// Show on arrival; for compressed samples also say whether it decodes alone.
  static func markLive(_ sample: CMSampleBuffer, keyframe: Bool?) {
    guard let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
      CFArrayGetCount(array) > 0
    else { return }
    let dict = unsafeBitCast(CFArrayGetValueAtIndex(array, 0), to: CFMutableDictionary.self)
    func set(_ key: CFString, _ value: Bool) {
      CFDictionarySetValue(
        dict, Unmanaged.passUnretained(key).toOpaque(),
        Unmanaged.passUnretained(value ? kCFBooleanTrue : kCFBooleanFalse).toOpaque())
    }
    set(kCMSampleAttachmentKey_DisplayImmediately, true)
    if let keyframe = keyframe {
      set(kCMSampleAttachmentKey_NotSync, !keyframe)
      set(kCMSampleAttachmentKey_DependsOnOthers, !keyframe)
    }
  }

  static func attachment(_ sample: CMSampleBuffer, _ key: CFString) -> Bool? {
    guard let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
      CFArrayGetCount(array) > 0
    else { return nil }
    let dict = unsafeBitCast(CFArrayGetValueAtIndex(array, 0), to: CFDictionary.self) as NSDictionary
    return (dict[key] as? NSNumber)?.boolValue
  }

  public static func displaysImmediately(_ sample: CMSampleBuffer) -> Bool {
    attachment(sample, kCMSampleAttachmentKey_DisplayImmediately) == true
  }

  /// A sample without NotSync is a sync (key) frame.
  public static func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
    attachment(sample, kCMSampleAttachmentKey_NotSync) != true
  }

  // ── Annex-B ────────────────────────────────────────────────────────

  /// The NAL units of an Annex-B stream (3- or 4-byte start codes), as byte
  /// ranges without start codes or trailing zeros.
  public static func nalUnits(annexB p: UnsafeRawBufferPointer) -> [Range<Int>] {
    let n = p.count
    var starts: [Int] = []
    var i = 0
    while i + 2 < n {
      if p[i + 2] > 1 {
        i += 3
      } else if p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 {
        starts.append(i + 3)
        i += 3
      } else {
        i += 1
      }
    }
    var units: [Range<Int>] = []
    for (k, start) in starts.enumerated() {
      // The next start code (a 4-byte one leaves its zero behind) or the end.
      var end = k + 1 < starts.count ? starts[k + 1] - 3 : n
      while end > start && p[end - 1] == 0 { end -= 1 }
      if end > start { units.append(start..<end) }
    }
    return units
  }

  /// A format description from one SPS and its PPSs (AVCC, 4-byte lengths).
  public static func h264Format(sps: Data, pps: [Data]) throws -> CMVideoFormatDescription {
    let sets = [sps] + pps
    // One buffer keeps every pointer valid for the call.
    var bytes: [UInt8] = []
    var offsets: [Int] = []
    for set in sets {
      offsets.append(bytes.count)
      bytes += set
    }
    return try bytes.withUnsafeBufferPointer { buf in
      let pointers = offsets.map { buf.baseAddress! + $0 }
      let sizes = sets.map { $0.count }
      var format: CMFormatDescription?
      try check(
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: sets.count, parameterSetPointers: pointers,
          parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &format),
        "h264 format")
      return format!
    }
  }
}

// ── (b) H.264 access units ───────────────────────────────────────────

/// Annex-B access units (one picture each, as RTP depacketizers give them)
/// → AVCC samples. Keeps the parameter sets between keyframes, makes a new
/// format description when they change (a resolution change), and drops
/// everything until a keyframe: at the start, and after `requireKeyframe`
/// (a flushed layer has no reference picture).
public final class K2H264Packer {
  public enum Output {
    case sample(CMSampleBuffer, keyframe: Bool)
    case dropped(Drop)
  }

  public enum Drop: String {
    case empty  // no picture (parameter sets alone are kept)
    case noParameterSets  // a picture before any SPS/PPS
    case waitingForKeyframe
  }

  public private(set) var format: CMVideoFormatDescription?
  public private(set) var needsKeyframe = true
  private var sps: Data?
  private var pps: [Data] = []

  public init() {}

  /// After a flush: drop until the next keyframe.
  public func requireKeyframe() { needsKeyframe = true }

  /// A new stream: forget the parameter sets too.
  public func reset() {
    format = nil
    sps = nil
    pps = []
    needsKeyframe = true
  }

  public func pack(annexB p: UnsafeRawBufferPointer, pts: CMTime) throws -> Output {
    var newSps: Data?
    var newPps: [Data] = []
    var picture: [Range<Int>] = []
    var idr = false
    for unit in K2VideoFrames.nalUnits(annexB: p) {
      switch p[unit.lowerBound] & 0x1F {
      case 7: newSps = Data(UnsafeRawBufferPointer(rebasing: p[unit]))
      case 8: newPps.append(Data(UnsafeRawBufferPointer(rebasing: p[unit])))
      case 9: continue  // access unit delimiter: AVCC has none
      case 5:
        idr = true
        picture.append(unit)
      default: picture.append(unit)  // other slices, SEI
      }
    }

    // Parameter sets: a change (or the first ones) makes a new format.
    if newSps != nil || !newPps.isEmpty {
      let s = newSps ?? sps
      let ps = newPps.isEmpty ? pps : newPps
      if let s = s, !ps.isEmpty, format == nil || s != sps || ps != pps {
        format = try K2VideoFrames.h264Format(sps: s, pps: ps)
        sps = s
        pps = ps
      } else if format == nil {
        sps = s
        pps = ps
      }
    }

    guard !picture.isEmpty else { return .dropped(.empty) }
    guard let format = format else { return .dropped(.noParameterSets) }
    if needsKeyframe {
      guard idr else { return .dropped(.waitingForKeyframe) }
      needsKeyframe = false
    }

    // AVCC: each NAL unit behind a 4-byte big-endian length. Copied, so the
    // caller's bytes are free once this returns.
    let total = picture.reduce(0) { $0 + 4 + $1.count }
    var block: CMBlockBuffer?
    try check(
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: total,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
        dataLength: total, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block),
      "block")
    var dst: UnsafeMutablePointer<CChar>?
    try check(
      CMBlockBufferGetDataPointer(
        block!, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &dst),
      "block pointer")
    let out = UnsafeMutableRawPointer(dst!)
    var offset = 0
    for unit in picture {
      out.storeBytes(of: UInt32(unit.count).bigEndian, toByteOffset: offset, as: UInt32.self)
      (out + offset + 4).copyMemory(from: p.baseAddress! + unit.lowerBound, byteCount: unit.count)
      offset += 4 + unit.count
    }

    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var size = total
    var sample: CMSampleBuffer?
    try check(
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
        sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample),
      "h264 sample")
    K2VideoFrames.markLive(sample!, keyframe: idr)
    return .sample(sample!, keyframe: idr)
  }
}

// ── (c) I420 → NV12 ──────────────────────────────────────────────────

/// One I420 picture (libvpx's output): three planes, borrowed for the call.
public struct K2I420Frame {
  public let width: Int
  public let height: Int
  public let y: UnsafePointer<UInt8>
  public let strideY: Int
  public let u: UnsafePointer<UInt8>
  public let strideU: Int
  public let v: UnsafePointer<UInt8>
  public let strideV: Int

  public init(
    width: Int, height: Int, y: UnsafePointer<UInt8>, strideY: Int, u: UnsafePointer<UInt8>, strideU: Int,
    v: UnsafePointer<UInt8>, strideV: Int
  ) {
    self.width = width
    self.height = height
    self.y = y
    self.strideY = strideY
    self.u = u
    self.strideU = strideU
    self.v = v
    self.strideV = strideV
  }
}

/// I420 → NV12 (video range, BT.601: what VP8 carries), IOSurface-backed so
/// the display layer takes it without a copy. The pool follows the size.
public final class K2NV12Pool {
  public private(set) var width = 0
  public private(set) var height = 0
  private var pool: CVPixelBufferPool?

  public init() {}

  public func pixelBuffer(from f: K2I420Frame) throws -> CVPixelBuffer {
    guard f.width > 0, f.height > 0, f.strideY >= f.width, f.strideU >= (f.width + 1) / 2,
      f.strideV >= (f.width + 1) / 2
    else { throw K2VideoError.badFrame("i420 size \(f.width)x\(f.height)") }
    if pool == nil || f.width != width || f.height != height {
      let attrs: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey: f.width,
        kCVPixelBufferHeightKey: f.height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ]
      var created: CVPixelBufferPool?
      try check(CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &created), "pool")
      pool = created
      width = f.width
      height = f.height
    }
    var out: CVPixelBuffer?
    try check(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool!, &out), "pool buffer")
    let pb = out!

    try check(CVPixelBufferLockBaseAddress(pb, []), "lock")
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
    let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    for row in 0..<f.height {
      (y + row * yStride).update(from: f.y + row * f.strideY, count: f.width)
    }
    let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
    let uvStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    let cw = (f.width + 1) / 2
    for row in 0..<(f.height + 1) / 2 {
      let d = uv + row * uvStride
      let u = f.u + row * f.strideU
      let v = f.v + row * f.strideV
      for x in 0..<cw {
        d[2 * x] = u[x]
        d[2 * x + 1] = v[x]
      }
    }
    CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_601_4, .shouldPropagate)
    return pb
  }
}
