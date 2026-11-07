// Checks K2BroadcastFrames (the broadcast extension's frame rules) on macOS:
//   cd src-tauri/tauri-plugin-k2-push/ios && swift run BroadcastCheck
// (a) the turn from RPVideoSampleOrientationKey; (b) the colour by pixel
// format; (c) the planes of real NV12 pixel buffers (padded rows, odd
// sizes) as kfr_producer_push_nv12 takes them; (d) the 15 fps gate; (e) the
// timestamp; (f) what each push answer means and the end sentences.

import CoreVideo
import Foundation
import K2BroadcastFrames

var failures = 0
func expect(_ ok: Bool, _ what: String) {
  if ok {
    print("ok  ", what)
  } else {
    failures += 1
    print("FAIL", what)
  }
}

typealias F = K2BroadcastFrames

// (a) CGImagePropertyOrientation raw values: up 1, upMirrored 2, down 3,
// downMirrored 4, leftMirrored 5, right 6, rightMirrored 7, left 8.
expect(F.rotation(orientation: 1) == 0, "up → 0")
expect(F.rotation(orientation: 6) == 90, "right → 90 (portrait buffer, phone held landscape)")
expect(F.rotation(orientation: 3) == 180, "down → 180")
expect(F.rotation(orientation: 8) == 270, "left → 270")
expect(F.rotation(orientation: 2) == 0 && F.rotation(orientation: 7) == 90, "mirrored turns as plain")
expect(F.rotation(orientation: nil) == 0 && F.rotation(orientation: 0) == 0 && F.rotation(orientation: 99) == 0, "none or unknown → 0")
expect([1, 2, 3, 4, 5, 6, 7, 8].allSatisfy { [0, 90, 180, 270].contains(F.rotation(orientation: UInt32($0))) }, "always a quarter turn")

// (b) Colour.
expect(F.color(pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) == 1, "420v → 1 (BT.709 limited)")
expect(F.color(pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) == 2, "420f → 2 (BT.709 full)")
expect(F.color(pixelFormat: kCVPixelFormatType_32BGRA) == nil, "BGRA → skipped")

// (c) Planes of real pixel buffers.
func buffer(_ w: Int, _ h: Int, _ format: OSType, padTo: Int? = nil) -> CVPixelBuffer? {
  var attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]]
  if let pad = padTo { attrs[kCVPixelBufferBytesPerRowAlignmentKey as String] = pad }
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(kCFAllocatorDefault, w, h, format, attrs as CFDictionary, &pb)
  return pb
}

for (w, h, format, name) in [
  (1170, 2532, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, "iPhone portrait 420f"),
  (2532, 1170, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, "iPhone landscape 420v"),
  (886, 1918, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, "a ReplayKit-scaled 420f"),
] {
  guard let pb = buffer(w, h, format, padTo: 64) else {
    expect(false, "\(name): pixel buffer")
    continue
  }
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  let p = F.planes(pb)
  expect(p != nil, "\(name): planes")
  if let p = p {
    expect(p.width == UInt32(w) && p.height == UInt32(h), "\(name): size \(p.width)x\(p.height)")
    expect(p.yStride >= w && p.uvStride >= w, "\(name): strides cover the width (\(p.yStride), \(p.uvStride))")
    expect(p.yLen == p.yStride * h, "\(name): Y length = bytes per row x height")
    expect(p.uvLen == p.uvStride * ((h + 1) / 2), "\(name): CbCr length = bytes per row x half the height")
    // The last byte of each plane is readable memory of this buffer: the
    // lengths are what the ring may read, no more.
    let lastY = p.y[p.yLen - 1]
    let lastUV = p.uv[p.uvLen - 1]
    expect(lastY == lastY && lastUV == lastUV, "\(name): planes readable to their lengths")
  }
  CVPixelBufferUnlockBaseAddress(pb, .readOnly)
}
if let bgra = buffer(64, 64, kCVPixelFormatType_32BGRA) {
  CVPixelBufferLockBaseAddress(bgra, .readOnly)
  expect(F.planes(bgra) == nil, "BGRA buffer → no planes")
  CVPixelBufferUnlockBaseAddress(bgra, .readOnly)
}

// (d) The gate: 15 fps on average, a quarter interval early allowed.
var gate = F.Gate()
let ms: UInt64 = 1_000_000
expect(gate.admit(1_000 * ms), "first frame kept")
expect(!gate.admit(1_016 * ms), "16 ms later (60 fps) dropped")
expect(!gate.admit(1_049 * ms), "49 ms later dropped")
expect(gate.admit(1_051 * ms), "51 ms later (a quarter early) takes the 66.7 ms slot")
expect(!gate.admit(1_100 * ms), "the next slot is 133 ms after the first, not after 51")
expect(gate.admit(1_130 * ms), "130 ms: kept")
expect(gate.admit(5_000 * ms), "after a gap: kept, the cadence starts again")
expect(!gate.admit(5_010 * ms), "and 10 ms later: dropped")
expect(gate.admit(100 * ms), "a clock that went back a long way: kept")
func keptOver(_ seconds: Int, every period: Double, jitterMs: Double = 0) -> Int {
  var g = F.Gate()
  var kept = 0
  let n = Int(Double(seconds) * 1000 / period)
  for i in 0..<n {
    let wobble = (i % 2 == 0 ? 1.0 : -1.0) * jitterMs
    if g.admit(UInt64((10_000 + Double(i) * period + wobble) * 1_000_000)) { kept += 1 }
  }
  return kept
}
let k60 = keptOver(10, every: 1000 / 60)
expect(k60 >= 149 && k60 <= 151, "60 fps for 10 s keeps 150 (\(k60))")
let k120 = keptOver(10, every: 1000 / 120)
expect(k120 >= 149 && k120 <= 151, "120 fps for 10 s keeps 150 (\(k120))")
let k15 = keptOver(10, every: 1000 / 15, jitterMs: 3)
expect(k15 >= 148, "a jittery 15 fps source keeps nearly all (\(k15) of 150)")
let k10 = keptOver(10, every: 100)
expect(k10 == 100, "10 fps keeps every frame (\(k10))")

// (e) Timestamps.
let now: UInt64 = 5_000 * 1_000_000_000
expect(F.timestamp(ptsSeconds: 4_999.95, now: now) == 4_999_950_000_000, "a host-clock time is passed on")
expect(F.timestamp(ptsSeconds: 12.0, now: now) == 0, "another clock → 0 (now)")
expect(F.timestamp(ptsSeconds: nil, now: now) == 0 && F.timestamp(ptsSeconds: .nan, now: now) == 0, "no time → 0")

// (f) Answers and ends.
expect([0, 1, 2].allSatisfy { F.pushed(Int32($0)) == .fine }, "0/1/2 keep sharing")
expect(F.pushed(-1) == .skip, "-1 skips the frame")
expect(F.pushed(-4) == .broken && F.pushed(-5) == .broken && F.pushed(-6) == .broken, "-4 and below -1 finish")
expect(F.End.stopped.ringReason == 2 && F.End.broken.ringReason == 3 && F.End.attach(-2).ringReason == 3, "finish reasons")
expect(F.End.attach(-2).message.contains("Join a call"), "no ring: join a call first")
expect(!F.End.stopped.message.contains("K2SO"), "the product is K2")

if failures > 0 {
  print("\(failures) failed")
  exit(1)
}
print("all passed")
