//! kessel-frame-ring's producer, as the broadcast upload extension links it:
//! a static library whose only exports are the crate's C surface
//! (`kfr_producer_attach`, `kfr_producer_start`, `kfr_producer_push_nv12`,
//! `kfr_producer_wants_frames`, `kfr_producer_stop_requested`,
//! `kfr_producer_finish`, `kfr_monotonic_ns`), declared for Swift in
//! `gen/apple/K2Broadcast/kessel_frame_ring.h`. Nothing of K2's own: the
//! crate is linked in whole so its `#[no_mangle]` functions land in the
//! archive.
//!
//! The tests drive that C surface the way K2Broadcast's SampleHandler does
//! (attach, start, push NV12 planes with a stride and a rotation, poll stop,
//! finish) against the app's side of the ring, the consumer the voice
//! plugin makes.

pub use kessel_frame_ring;

#[cfg(test)]
mod tests {
    use std::ffi::CString;

    use kessel_frame_ring::ffi::{
        kfr_monotonic_ns, kfr_producer_attach, kfr_producer_finish, kfr_producer_push_nv12, kfr_producer_start,
        kfr_producer_stop_requested, kfr_producer_wants_frames,
    };
    use kessel_frame_ring::{Color, Consumer, EndReason, Layout, ProducerState};

    /// The ring's file name in the App Group container (the plugin's
    /// `screen_ring::RING_FILE`; SampleHandler.swift's `ringFile`).
    const RING_FILE: &str = "sew-screen.ring";

    fn ring_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("k2-broadcast-ring-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A ReplayKit-shaped NV12 frame: rows padded past the width (a
    /// CVPixelBuffer's bytes per row), Y then interleaved CbCr.
    struct Planes {
        y: Vec<u8>,
        uv: Vec<u8>,
        y_stride: usize,
        uv_stride: usize,
        width: u32,
        height: u32,
    }

    fn planes(width: u32, height: u32, pad: usize) -> Planes {
        let (w, h) = (width as usize, height as usize);
        let y_stride = w + pad;
        let uv_stride = w + pad;
        let mut y = vec![0u8; y_stride * h];
        for row in 0..h {
            for col in 0..w {
                y[row * y_stride + col] = ((row + col) % 200) as u8 + 16;
            }
        }
        let uv = vec![128u8; uv_stride * h / 2];
        Planes { y, uv, y_stride, uv_stride, width, height }
    }

    fn push(p: *mut kessel_frame_ring::Producer, f: &Planes, rotation: u32, color: u32) -> i32 {
        push_at(p, f, rotation, color, 0)
    }

    /// `ts`: the host clock in ns (`kfr_monotonic_ns`), or 0 for now.
    fn push_at(p: *mut kessel_frame_ring::Producer, f: &Planes, rotation: u32, color: u32, ts: u64) -> i32 {
        unsafe {
            kfr_producer_push_nv12(
                p,
                f.y.as_ptr(),
                f.y.len(),
                f.y_stride,
                f.uv.as_ptr(),
                f.uv.len(),
                f.uv_stride,
                f.width,
                f.height,
                rotation,
                color,
                ts,
            )
        }
    }

    #[test]
    fn no_ring_is_minus_two_the_apps_not_in_a_call() {
        let dir = ring_dir("none");
        let path = CString::new(dir.join(RING_FILE).to_str().unwrap()).unwrap();
        let mut err = 0;
        let p = unsafe { kfr_producer_attach(path.as_ptr(), &mut err) };
        assert!(p.is_null());
        assert_eq!(err, -2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_padded_portrait_frame_arrives_whole_scaled_into_the_box_with_its_turn() {
        let dir = ring_dir("frame");
        let mut ring = Consumer::create(dir.join(RING_FILE), Layout::hd720()).unwrap();
        ring.touch();
        let path = CString::new(dir.join(RING_FILE).to_str().unwrap()).unwrap();
        let mut err = 0;
        let p = unsafe { kfr_producer_attach(path.as_ptr(), &mut err) };
        assert!(!p.is_null(), "attach failed with {err}");
        assert_eq!(unsafe { kfr_producer_start(p) }, 0);
        assert!(unsafe { kfr_producer_wants_frames(p) });
        assert!(!unsafe { kfr_producer_stop_requested(p) });
        assert_eq!(ring.producer().unwrap(), ProducerState::Running);

        // An iPhone's screen held sideways: 1170 x 2532 landscape-left
        // buffer, bytes per row padded to 64, turned 90 clockwise to upright.
        let f = planes(1170, 2532, 46);
        let t0 = unsafe { kfr_monotonic_ns() };
        assert_eq!(push_at(p, &f, 90, 2, t0), 0);
        let mut buf = Vec::new();
        let info = ring.try_read(&mut buf).expect("a frame");
        assert_eq!(info.rotation, 90);
        assert_eq!(info.color, Color::Bt709Full);
        // Scaled down to fit 1280 x 720 either way round, aspect kept.
        assert!(info.width <= 720 && info.height <= 1280, "{}x{}", info.width, info.height);
        assert!(info.height > info.width);
        assert_eq!(buf.len(), info.len());
        // The padding never reached the ring: the top-left Y is the frame's.
        assert_eq!(buf[0], 16);

        // Too soon for 15 fps (10 ms later): dropped (2), never blocked.
        assert_eq!(push_at(p, &f, 90, 2, t0 + 10_000_000), 2);
        // Not a frame (a stride narrower than the width): -1, skip it.
        let bad = Planes { y_stride: 10, ..planes(64, 64, 0) };
        assert_eq!(push(p, &bad, 0, 1), -1);
        // A rotation that isn't a quarter turn: -1 too.
        assert_eq!(push(p, &planes(64, 64, 0), 45, 1), -1);

        // The app stops the share: the extension sees it and finishes.
        ring.request_stop();
        assert!(unsafe { kfr_producer_stop_requested(p) });
        unsafe { kfr_producer_finish(p, 2) };
        assert_eq!(ring.producer().unwrap(), ProducerState::Ended(EndReason::SourceClosed));
        assert!(unsafe { kfr_monotonic_ns() } > 0);
        drop(ring);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_shrunk_ring_answers_minus_four_finish_the_broadcast() {
        let dir = ring_dir("shrunk");
        let ring = Consumer::create(dir.join(RING_FILE), Layout::hd720()).unwrap();
        ring.touch();
        let path = CString::new(dir.join(RING_FILE).to_str().unwrap()).unwrap();
        let mut err = 0;
        let p = unsafe { kfr_producer_attach(path.as_ptr(), &mut err) };
        assert!(!p.is_null());
        assert_eq!(unsafe { kfr_producer_start(p) }, 0);
        std::fs::OpenOptions::new().write(true).open(dir.join(RING_FILE)).unwrap().set_len(64).unwrap();
        assert!(!unsafe { kfr_producer_wants_frames(p) });
        assert_eq!(push(p, &planes(64, 64, 0), 0, 1), -4);
        unsafe { kfr_producer_finish(p, 3) };
        drop(ring);
        let _ = std::fs::remove_dir_all(dir);
    }
}
