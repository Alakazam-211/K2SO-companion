// kessel-frame-ring 0.1's C surface (the producer), from the crate's README.
// Rust functions with the C calling convention, in libk2_broadcast_ring.a
// (src-tauri/broadcast-ring). No C is compiled. Keep in step with the
// crate's version there (and the voice plugin's).
#ifndef KESSEL_FRAME_RING_H
#define KESSEL_FRAME_RING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Not thread-safe: make every call on one producer from one serial queue,
// and kfr_producer_finish last.
typedef struct KfrProducer KfrProducer;

// Attach to the ring the app made at `path`. Null on failure, with *error:
// -1 invalid, -2 no ring (the app isn't in a call), -3 another producer,
// -4 not a matching ring, -5 an OS error, -6 an internal error.
KfrProducer *kfr_producer_attach(const char *path, int32_t *error);
// Before the first push. 0, or -1 (p is null) or -6 (an internal error).
int32_t kfr_producer_start(KfrProducer *p);
// One frame: planes 0 and 1 of a locked 420v/420f CVPixelBuffer.
// rotation: 0, 90, 180, 270 (clockwise to upright). color: 0 BT.601 limited,
// 1 BT.709 limited (420v), 2 BT.709 full (420f). timestamp_ns: on
// kfr_monotonic_ns's clock, or 0 for now. Returns 0 written, 1 dropped (the
// app doesn't want frames now), 2 dropped (too soon for the rate), -1 for
// any argument that doesn't describe a frame, -4 when the ring's file has
// shrunk under the extension (finish the broadcast), or another code below 0.
int32_t kfr_producer_push_nv12(KfrProducer *p,
                               const uint8_t *y, size_t y_len, size_t y_stride,
                               const uint8_t *uv, size_t uv_len, size_t uv_stride,
                               uint32_t width, uint32_t height,
                               uint32_t rotation, uint32_t color,
                               uint64_t timestamp_ns);
// False: skip locking and copying pixel buffers. False too once the ring's
// file has shrunk.
bool kfr_producer_wants_frames(const KfrProducer *p);
// True: the call ended in the app; finish the broadcast. (A shrunk file
// gives false here; the next push returns -4.)
bool kfr_producer_stop_requested(const KfrProducer *p);
// reason: 1 the person stopped (broadcastFinished), 2 closed, 3 failed.
// Frees p. Call it last, once.
void kfr_producer_finish(KfrProducer *p, uint32_t reason);
// The clock timestamps use: mach absolute time in ns (CMClock host time).
uint64_t kfr_monotonic_ns(void);

#endif
