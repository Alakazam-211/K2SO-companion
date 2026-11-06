// Debug-only video sources: a moving test picture (I420) and an H.264
// encoder that turns it into Annex-B access units, the way Sew's sink will
// hand them over. K2PiP's `pipTest` and the macOS check use them; release
// builds compile none of this.

#if DEBUG
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// A diagonal grey sweep under a white bar that crosses the picture every
/// 2 s at 30 fps, over shifting colour.
public final class K2TestPattern {
  public let width: Int
  public let height: Int
  private var y: [UInt8]
  private var u: [UInt8]
  private var v: [UInt8]

  public init(width: Int, height: Int) {
    self.width = width
    self.height = height
    let cw = (width + 1) / 2
    let ch = (height + 1) / 2
    y = [UInt8](repeating: 0, count: width * height)
    u = [UInt8](repeating: 128, count: cw * ch)
    v = [UInt8](repeating: 128, count: cw * ch)
  }

  /// Frame `n`, borrowed for `body`.
  public func withFrame<T>(_ n: Int, _ body: (K2I420Frame) throws -> T) rethrows -> T {
    let w = width
    let h = height
    let cw = (w + 1) / 2
    let ch = (h + 1) / 2
    let barW = max(w / 12, 2)
    let barX = (n * w / 60) % w
    for row in 0..<h {
      for x in 0..<w {
        let onBar = x >= barX && x < barX + barW
        y[row * w + x] = onBar ? 235 : UInt8(16 + (x + row + n * 4) % 200)
      }
    }
    for row in 0..<ch {
      for x in 0..<cw {
        u[row * cw + x] = UInt8(truncatingIfNeeded: 128 + (x * 2 + n) % 96 - 48)
        v[row * cw + x] = UInt8(truncatingIfNeeded: 128 + (row * 2 + n) % 96 - 48)
      }
    }
    return try y.withUnsafeBufferPointer { yp in
      try u.withUnsafeBufferPointer { up in
        try v.withUnsafeBufferPointer { vp in
          try body(
            K2I420Frame(
              width: w, height: h, y: yp.baseAddress!, strideY: w, u: up.baseAddress!, strideU: cw,
              v: vp.baseAddress!, strideV: cw))
        }
      }
    }
  }
}

/// VideoToolbox H.264 (baseline, no B-frames) → Annex-B access units: AUD,
/// then SPS and PPS before every keyframe, 4-byte start codes for the first
/// NAL units and 3-byte ones after, as real senders mix them.
public final class K2H264TestEncoder {
  public struct Unit {
    public let annexB: Data
    /// The encoder's own AVCC picture, to compare a repack against.
    public let avcc: Data
    public let keyframe: Bool
  }

  private let session: VTCompressionSession

  public init(width: Int, height: Int) throws {
    var s: VTCompressionSession?
    try check(
      VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &s),
      "encoder")
    session = s!
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 600 as CFNumber)
  }

  deinit {
    VTCompressionSessionInvalidate(session)
  }

  /// One frame, synchronously. Nil when the encoder dropped it.
  public func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, keyframe: Bool) throws -> Unit? {
    var encoded: CMSampleBuffer?
    var failed: OSStatus = noErr
    let props = [kVTEncodeFrameOptionKey_ForceKeyFrame: keyframe] as CFDictionary
    try check(
      VTCompressionSessionEncodeFrame(
        session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid,
        frameProperties: props, infoFlagsOut: nil
      ) { status, _, sample in
        failed = status
        encoded = sample
      },
      "encode")
    try check(VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid), "complete")
    try check(failed, "encode output")
    guard let sample = encoded, let format = CMSampleBufferGetFormatDescription(sample),
      let block = CMSampleBufferGetDataBuffer(sample)
    else { return nil }

    var avcc = Data(count: CMBlockBufferGetDataLength(block))
    try avcc.withUnsafeMutableBytes { buf in
      try check(
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: buf.count, destination: buf.baseAddress!),
        "copy")
    }
    let isKey = K2VideoFrames.isKeyframe(sample)

    var annexB = Data([0, 0, 0, 1, 0x09, 0xF0])  // AUD
    if isKey {
      var count = 0
      try check(
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
          parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil),
        "parameter sets")
      for i in 0..<count {
        var ptr: UnsafePointer<UInt8>?
        var size = 0
        try check(
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil),
          "parameter set")
        annexB += [0, 0, 0, 1]
        annexB.append(ptr!, count: size)
      }
    }
    var offset = 0
    var first = true
    while offset + 4 <= avcc.count {
      let len = avcc[offset..<offset + 4].reduce(0) { $0 << 8 | Int($1) }
      annexB += first ? [0, 0, 0, 1] : [0, 0, 1]
      annexB += avcc[offset + 4..<offset + 4 + len]
      offset += 4 + len
      first = false
    }
    return Unit(annexB: annexB, avcc: avcc, keyframe: isKey)
  }
}
#endif
