import { useSyncExternalStore } from "react";
import { lightBlurOn, setLightBlur, subscribeLightBlur } from "../lib/lightBlur";
import { Switch } from "./ZenSettings";

const MUTED = "#8e8e93";

/** Diagnostics → Light blur: A/B the two-layer header / footer blur
 *  against the shipped four-layer one (lib/lightBlur.ts). */
export function LightBlurRow() {
  const on = useSyncExternalStore(subscribeLightBlur, lightBlurOn, lightBlurOn);
  const labelId = "light-blur-label";
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: "0 16px" }}
      data-testid="server-settings-light-blur"
    >
      <span id={labelId} className="flex-1 text-[15px]" style={{ minHeight: 40, lineHeight: "40px", color: MUTED }}>
        Light blur (2 layers)
      </span>
      <Switch on={on} disabled={false} onToggle={() => setLightBlur(!on)} labelledBy={labelId} />
    </div>
  );
}
