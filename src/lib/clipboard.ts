import { invoke } from "@tauri-apps/api/core";
import { isIosWebView } from "./nativePicker";
import { writeClipboard, type ClipboardWriteResult } from "./oscClipboard";

// Copy text as plain text only. On iOS, WebKit's `writeText` also puts any
// text that parses as a URL on the pasteboard as an NSURL, so a message that
// starts with `Reminder:` pasted elsewhere as `reminder:%20…`. The app's own
// plugin sets `UIPasteboard.general.string` instead (string only, no
// user-gesture rule); elsewhere, or if that fails, `writeClipboard`.

export async function copyPlainText(text: string): Promise<ClipboardWriteResult> {
  if (isIosWebView()) {
    const r = await invoke<{ ok?: boolean }>("plugin:k2-push|call_op", { op: "copyText", text }).catch(
      () => null
    );
    if (r?.ok) return "written";
  }
  return writeClipboard(text);
}
