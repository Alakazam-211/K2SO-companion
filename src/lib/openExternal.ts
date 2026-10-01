import { invoke } from "@tauri-apps/api/core";
import { isWebUrl } from "../zen/chatLinks";

/** Open http(s)/mailto/tel in the system browser. iOS uses a native
 *  command because `window.open` is a no-op in WKWebView. Vite preview
 *  falls back to `window.open`. */
export async function openExternal(url: string): Promise<void> {
  const u = url.trim();
  if (!isWebUrl(u)) return;
  try {
    await invoke("open_external_url", { url: u });
  } catch {
    window.open(u, "_blank", "noopener,noreferrer");
  }
}
