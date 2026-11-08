import { beforeEach, describe, expect, it, vi } from "vitest";

const ios = { on: true };
vi.mock("./nativePicker", () => ({ isIosWebView: () => ios.on }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { copyPlainText } from "./clipboard";

const REMINDER = "Reminder: **Sterling hasn't accepted** yet.";

describe("copyPlainText", () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    ios.on = true;
    vi.mocked(invoke).mockReset();
    writeText.mockClear();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });

  it("copies through the app's plugin on iOS, not WebKit (URL-like text stays text)", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true });
    expect(await copyPlainText(REMINDER)).toBe("written");
    expect(invoke).toHaveBeenCalledWith("plugin:k2-push|call_op", { op: "copyText", text: REMINDER });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText when the plugin can't (older build, error)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unknown op"));
    expect(await copyPlainText(REMINDER)).toBe("written");
    expect(writeText).toHaveBeenCalledWith(REMINDER);
  });

  it("uses writeText off iOS", async () => {
    ios.on = false;
    expect(await copyPlainText("hello")).toBe("written");
    expect(invoke).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("hello");
  });
});
