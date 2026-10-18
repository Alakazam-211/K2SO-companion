import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/api/core", () => core);

import {
  PICK_MEDIA_LIMIT,
  PICK_TOTAL_BYTES,
  isIosWebView,
  isUnsupportedPick,
  nativePick,
  nativePickerAvailable,
  pickedToFile,
  skippedMessage,
} from "./nativePicker";
import { MAX_UPLOAD_BYTES } from "../zen/composerAttach";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile";

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReset().mockReturnValue(false);
});

describe("nativePicker platform gate", () => {
  it("iPhone and iPadOS are iOS; a Mac without touch and Android are not", () => {
    expect(isIosWebView({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebView({ userAgent: IPAD, maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebView({ userAgent: IPAD, maxTouchPoints: 0 })).toBe(false);
    expect(isIosWebView({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe(false);
  });

  it("needs the Tauri runtime (browser dev and tests use the web input)", () => {
    expect(nativePickerAvailable()).toBe(false);
    core.isTauri.mockImplementation(() => {
      throw new Error("no runtime");
    });
    expect(nativePickerAvailable()).toBe(false);
  });
});

describe("nativePick", () => {
  it("media: pick_media with the selection and size limits; base64 → File", async () => {
    core.invoke.mockResolvedValue({
      files: [{ name: "IMG_1.jpeg", mime: "image/jpeg", base64: btoa("jpegbytes") }],
      skipped: [],
      cancelled: false,
    });
    const out = await nativePick("media");
    expect(core.invoke).toHaveBeenCalledWith("plugin:k2-push|pick_media", {
      limit: PICK_MEDIA_LIMIT,
      maxBytes: MAX_UPLOAD_BYTES,
      maxTotalBytes: PICK_TOTAL_BYTES,
    });
    expect(out.cancelled).toBe(false);
    expect(out.files).toHaveLength(1);
    const f = out.files[0];
    expect(f).toBeInstanceOf(File);
    expect(f.name).toBe("IMG_1.jpeg");
    expect(f.type).toBe("image/jpeg");
    expect(await f.text()).toBe("jpegbytes");
  });

  it("documents: pick_documents; cancelled and skipped pass through", async () => {
    core.invoke.mockResolvedValue({
      files: [],
      skipped: [{ name: "a.bin", reason: "unreadable" }],
      cancelled: true,
    });
    const out = await nativePick("documents");
    expect(core.invoke).toHaveBeenCalledWith("plugin:k2-push|pick_documents", {
      maxBytes: MAX_UPLOAD_BYTES,
      maxTotalBytes: PICK_TOTAL_BYTES,
    });
    expect(out).toEqual({ files: [], skipped: [{ name: "a.bin", reason: "unreadable" }], cancelled: true });
  });

  it("rejections propagate; `unsupported` is recognisable", async () => {
    core.invoke.mockRejectedValue("unsupported: native attach pickers are iOS-only");
    let err: unknown;
    await nativePick("media").catch((e) => (err = e));
    expect(isUnsupportedPick(err)).toBe(true);
    expect(isUnsupportedPick(new Error("unsupported: x"))).toBe(true);
    expect(isUnsupportedPick("busy: a picker is already open")).toBe(false);
  });
});

describe("pickedToFile / skippedMessage", () => {
  it("binary bytes survive the base64 round trip; missing fields get defaults", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const f = pickedToFile({ name: "", mime: "", base64: btoa(String.fromCharCode(...bytes)) });
    expect(f.name).toBe("attachment");
    expect(f.type).toBe("application/octet-stream");
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes);
  });

  it("names the first skipped file and counts the rest", () => {
    expect(skippedMessage([])).toBeNull();
    expect(skippedMessage([{ name: "big.mov", reason: "too large" }])).toBe(
      '"big.mov" is too large (50 MB max)'
    );
    expect(
      skippedMessage([
        { name: "a.mov", reason: "total size limit" },
        { name: "b.mov", reason: "total size limit" },
      ])
    ).toBe('"a.mov" was left out (100 MB per pick) (+1 more)');
    expect(skippedMessage([{ name: "c", reason: "unreadable" }])).toBe('"c" could not be read');
  });
});
