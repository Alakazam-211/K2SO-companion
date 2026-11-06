// Checks K2VideoFrames (PiP frame wrapping) on macOS with synthetic frames:
//   cd src-tauri/tauri-plugin-k2-push/ios && swift run PiPCheck
// (a) pixel buffer → sample; (b) H.264 Annex-B → AVCC sample, checked against
// VideoToolbox's own output and decoded back; (c) I420 → NV12 from a pool.
// Debug build only: it uses the debug test pattern and encoder.

import CoreMedia
import CoreVideo
import Foundation
import K2VideoFrames
import VideoToolbox

#if DEBUG
var failures = 0
func expect(_ ok: Bool, _ what: String) {
  if ok {
    print("ok  ", what)
  } else {
    failures += 1
    print("FAIL", what)
  }
}

func dims(_ format: CMFormatDescription?) -> (Int, Int) {
  guard let format = format else { return (0, 0) }
  let d = CMVideoFormatDescriptionGetDimensions(format)
  return (Int(d.width), Int(d.height))
}

func fourCC(_ code: FourCharCode) -> String {
  String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }, encoding: .ascii) ?? "?"
}

/// The NAL types of an AVCC buffer, or nil when the length prefixes don't add up.
func avccTypes(_ data: Data) -> [UInt8]? {
  var types: [UInt8] = []
  var offset = 0
  while offset < data.count {
    guard offset + 4 <= data.count else { return nil }
    let len = data[offset..<offset + 4].reduce(0) { $0 << 8 | Int($1) }
    guard len > 0, offset + 4 + len <= data.count else { return nil }
    types.append(data[offset + 4] & 0x1F)
    offset += 4 + len
  }
  return types
}

func bytes(_ sample: CMSampleBuffer) -> Data {
  let block = CMSampleBufferGetDataBuffer(sample)!
  var d = Data(count: CMBlockBufferGetDataLength(block))
  d.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!) }
  return d
}

func pack(_ packer: K2H264Packer, _ annexB: Data, _ pts: CMTime) throws -> K2H264Packer.Output {
  try annexB.withUnsafeBytes { try packer.pack(annexB: $0, pts: pts) }
}

// ── (c) I420 → NV12 ──────────────────────────────────────────────────
print("(c) I420 → NV12")
do {
  // Odd size, padded strides.
  let w = 321
  let h = 241
  let cw = (w + 1) / 2
  let ch = (h + 1) / 2
  let sy = w + 15
  let sc = cw + 7
  var y = [UInt8](repeating: 0, count: sy * h)
  var u = [UInt8](repeating: 0, count: sc * ch)
  var v = [UInt8](repeating: 0, count: sc * ch)
  for r in 0..<h { for x in 0..<w { y[r * sy + x] = UInt8((x * 3 + r) & 0xFF) } }
  for r in 0..<ch {
    for x in 0..<cw {
      u[r * sc + x] = UInt8((x + 2 * r) & 0xFF)
      v[r * sc + x] = UInt8((255 - x + r) & 0xFF)
    }
  }
  let pool = K2NV12Pool()
  func convert() throws -> CVPixelBuffer {
    try y.withUnsafeBufferPointer { yp in
      try u.withUnsafeBufferPointer { up in
        try v.withUnsafeBufferPointer { vp in
          try pool.pixelBuffer(
            from: K2I420Frame(
              width: w, height: h, y: yp.baseAddress!, strideY: sy, u: up.baseAddress!, strideU: sc,
              v: vp.baseAddress!, strideV: sc))
        }
      }
    }
  }
  let pb = try convert()
  expect(fourCC(CVPixelBufferGetPixelFormatType(pb)) == "420v", "format 420v (NV12 video range)")
  expect(CVPixelBufferGetWidth(pb) == w && CVPixelBufferGetHeight(pb) == h, "size \(w)x\(h)")
  expect(CVPixelBufferGetPlaneCount(pb) == 2, "two planes")
  expect(CVPixelBufferGetIOSurface(pb) != nil, "IOSurface-backed")
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  let py = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
  let pys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
  let puv = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
  let puvs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
  var yOK = true
  for r in 0..<h { for x in 0..<w where py[r * pys + x] != y[r * sy + x] { yOK = false } }
  var uvOK = true
  for r in 0..<ch {
    for x in 0..<cw where puv[r * puvs + 2 * x] != u[r * sc + x] || puv[r * puvs + 2 * x + 1] != v[r * sc + x] {
      uvOK = false
    }
  }
  CVPixelBufferUnlockBaseAddress(pb, .readOnly)
  expect(yOK, "Y plane copied row by row")
  expect(uvOK, "U and V interleaved into the CbCr plane (\(cw)x\(ch))")
  let matrix = CVBufferGetAttachment(pb, kCVImageBufferYCbCrMatrixKey, nil)?.takeUnretainedValue() as? String
  expect(matrix == (kCVImageBufferYCbCrMatrix_ITU_R_601_4 as String), "BT.601 matrix attached")
  let pb2 = try convert()
  expect(pb2 !== pb && pool.width == w, "pool hands a second buffer at the same size")

  var bad = false
  do {
    _ = try y.withUnsafeBufferPointer { yp in
      try pool.pixelBuffer(
        from: K2I420Frame(
          width: w, height: h, y: yp.baseAddress!, strideY: w - 1, u: yp.baseAddress!, strideU: sc,
          v: yp.baseAddress!, strideV: sc))
    }
  } catch K2VideoError.badFrame {
    bad = true
  }
  expect(bad, "a stride shorter than the width is refused")
}

// ── (a) pixel buffer → sample ────────────────────────────────────────
print("(a) pixel buffer → sample")
do {
  let pattern = K2TestPattern(width: 640, height: 360)
  let pool = K2NV12Pool()
  let pb = try pattern.withFrame(7) { try pool.pixelBuffer(from: $0) }
  expect(pool.width == 640 && pool.height == 360, "pool resized to 640x360")
  let pts = CMTime(value: 7, timescale: 30)
  let sample = try K2VideoFrames.sampleBuffer(pixelBuffer: pb, pts: pts)
  expect(CMSampleBufferIsValid(sample) && CMSampleBufferDataIsReady(sample), "valid and ready")
  let format = CMSampleBufferGetFormatDescription(sample)
  expect(format.map { CMFormatDescriptionGetMediaType($0) } == kCMMediaType_Video, "video media type")
  expect(format.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } == "420v", "subtype 420v")
  expect(dims(format) == (640, 360), "dimensions 640x360")
  expect(CMSampleBufferGetPresentationTimeStamp(sample) == pts, "pts 7/30")
  expect(CMSampleBufferGetImageBuffer(sample) === pb, "carries the same pixel buffer (no copy)")
  expect(K2VideoFrames.displaysImmediately(sample), "DisplayImmediately")
}

// ── (b) H.264 Annex-B → AVCC ─────────────────────────────────────────
print("(b) H.264 Annex-B → AVCC")
do {
  // Parsing: 3- and 4-byte start codes, trailing zeros dropped.
  let raw: [UInt8] = [0, 0, 0, 1, 0x09, 0xF0, 0, 0, 1, 0x65, 0xAA, 0xBB, 0, 0, 0, 0, 1, 0x41, 0x01]
  let ranges = raw.withUnsafeBytes { K2VideoFrames.nalUnits(annexB: $0) }
  expect(ranges == [4..<6, 9..<12, 17..<19], "NAL units split on 3- and 4-byte start codes")

  func encodeLoop(_ w: Int, _ h: Int, frames: Int, start: Int) throws -> [K2H264TestEncoder.Unit] {
    let enc = try K2H264TestEncoder(width: w, height: h)
    let pattern = K2TestPattern(width: w, height: h)
    let pool = K2NV12Pool()
    return try (0..<frames).compactMap { i in
      let pb = try pattern.withFrame(start + i) { try pool.pixelBuffer(from: $0) }
      return try enc.encode(pb, pts: CMTime(value: Int64(start + i), timescale: 30), keyframe: i == 0)
    }
  }
  let small = try encodeLoop(320, 240, frames: 6, start: 0)
  let large = try encodeLoop(640, 360, frames: 3, start: 6)
  expect(small.count == 6 && small[0].keyframe && !small[1].keyframe, "encoder: keyframe then P-frames")

  let packer = K2H264Packer()
  var t = 0
  func next() -> CMTime {
    t += 1
    return CMTime(value: Int64(t) * 3000, timescale: 90000)  // RTP clock
  }

  // A P-frame before any keyframe, then a P-frame's slices with no parameter sets.
  if case .dropped(let why) = try pack(packer, small[1].annexB, next()) {
    expect(why == .noParameterSets, "P-frame first: dropped (no parameter sets)")
  } else {
    expect(false, "P-frame first: dropped")
  }

  var decodable: [CMSampleBuffer] = []
  if case .sample(let s, let key) = try pack(packer, small[0].annexB, next()) {
    let pts = CMTime(value: Int64(t) * 3000, timescale: 90000)
    expect(key && K2VideoFrames.isKeyframe(s), "keyframe packed as a sync sample")
    expect(dims(CMSampleBufferGetFormatDescription(s)) == (320, 240), "format from SPS/PPS: 320x240")
    expect(
      CMSampleBufferGetFormatDescription(s).map { fourCC(CMFormatDescriptionGetMediaSubType($0)) } == "avc1",
      "subtype avc1")
    expect(CMSampleBufferGetPresentationTimeStamp(s) == pts, "pts kept (90 kHz)")
    expect(K2VideoFrames.displaysImmediately(s), "DisplayImmediately")
    let data = bytes(s)
    let types = avccTypes(data)
    expect(types != nil, "AVCC length prefixes add up (\(data.count) bytes)")
    expect(types?.contains(5) == true && types?.contains(where: { [7, 8, 9].contains($0) }) == false,
      "IDR kept; SPS, PPS and AUD left out")
    expect(data == small[0].avcc, "bytes equal VideoToolbox's own AVCC")
    var count = 0
    var header: Int32 = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      CMSampleBufferGetFormatDescription(s)!, parameterSetIndex: 0, parameterSetPointerOut: nil,
      parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &header)
    expect(count == 2 && header == 4, "format holds SPS + PPS, 4-byte lengths")
    decodable.append(s)
  } else {
    expect(false, "keyframe packed")
  }
  let firstFormat = packer.format

  for unit in small[1...] {
    if case .sample(let s, let key) = try pack(packer, unit.annexB, next()) {
      expect(!key && !K2VideoFrames.isKeyframe(s) && bytes(s) == unit.avcc, "P-frame packed as NotSync, bytes equal")
      decodable.append(s)
    } else {
      expect(false, "P-frame packed")
    }
  }
  expect(packer.format === firstFormat, "same parameter sets: format description kept")

  // After a flush: drop until a keyframe.
  packer.requireKeyframe()
  if case .dropped(let why) = try pack(packer, small[2].annexB, next()) {
    expect(why == .waitingForKeyframe, "after requireKeyframe: P-frame dropped")
  } else {
    expect(false, "after requireKeyframe: P-frame dropped")
  }

  // Parameter-set change: the 640x360 keyframe.
  if case .sample(let s, let key) = try pack(packer, large[0].annexB, next()) {
    expect(key && dims(CMSampleBufferGetFormatDescription(s)) == (640, 360), "new SPS/PPS: format now 640x360")
    expect(packer.format !== firstFormat, "format description replaced")
  } else {
    expect(false, "640x360 keyframe packed")
  }
  if case .sample(let s, _) = try pack(packer, large[1].annexB, next()) {
    expect(dims(CMSampleBufferGetFormatDescription(s)) == (640, 360), "P-frame after the change: 640x360")
  } else {
    expect(false, "P-frame after the change packed")
  }

  // Parameter sets alone are kept for the next picture.
  let fresh = K2H264Packer()
  let ranges0 = small[0].annexB.withUnsafeBytes { K2VideoFrames.nalUnits(annexB: $0) }
  var paramsOnly = Data()
  var idrOnly = Data()
  for r in ranges0 {
    let nal = small[0].annexB[r]
    let type = nal.first! & 0x1F
    if type == 7 || type == 8 { paramsOnly += [0, 0, 0, 1] + nal } else if type != 9 { idrOnly += [0, 0, 1] + nal }
  }
  if case .dropped(let why) = try pack(fresh, paramsOnly, next()) {
    expect(why == .empty, "SPS/PPS alone: no picture")
  } else {
    expect(false, "SPS/PPS alone: no picture")
  }
  if case .sample(let s, _) = try pack(fresh, idrOnly, next()) {
    expect(bytes(s) == small[0].avcc, "IDR after separate SPS/PPS packs")
  } else {
    expect(false, "IDR after separate SPS/PPS packs")
  }
  let kept = fresh.format
  _ = try pack(fresh, small[0].annexB, next())
  expect(fresh.format === kept, "the same SPS/PPS again (every keyframe): format kept")
  if case .dropped(let why) = try pack(fresh, Data([1, 2, 3, 4, 5]), next()) {
    expect(why == .empty, "no start codes: dropped")
  } else {
    expect(false, "no start codes: dropped")
  }

  // Decode what we packed: the format and AVCC are what VideoToolbox reads.
  var session: VTDecompressionSession?
  let status = VTDecompressionSessionCreate(
    allocator: nil, formatDescription: CMSampleBufferGetFormatDescription(decodable[0])!,
    decoderSpecification: nil, imageBufferAttributes: nil, outputCallback: nil,
    decompressionSessionOut: &session)
  expect(status == noErr, "decoder accepts the format description")
  if let session = session {
    var decoded = 0
    var sizeOK = true
    for s in decodable {
      let st = VTDecompressionSessionDecodeFrame(session, sampleBuffer: s, flags: [], infoFlagsOut: nil) {
        status, _, image, _, _ in
        if status == noErr, let image = image {
          decoded += 1
          if CVPixelBufferGetWidth(image) != 320 || CVPixelBufferGetHeight(image) != 240 { sizeOK = false }
        }
      }
      if st != noErr { print("     decode status", st) }
    }
    VTDecompressionSessionWaitForAsynchronousFrames(session)
    VTDecompressionSessionInvalidate(session)
    expect(decoded == decodable.count && sizeOK, "decoded \(decoded)/\(decodable.count) packed frames at 320x240")
  }
}

print(failures == 0 ? "PiPCheck: all passed" : "PiPCheck: \(failures) failed")
exit(failures == 0 ? 0 : 1)
#else
print("PiPCheck needs the debug build: swift run PiPCheck")
exit(1)
#endif
