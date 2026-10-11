import { version } from "../../package.json";

/** Settings → About values, shared by the old Settings page and Zen
 *  Settings. Version is package.json's marketing version, which
 *  scripts/release.sh bumps together with tauri.conf.json and Info.plist. */
export const ABOUT = {
  app: "K2",
  version,
  engine: "Tauri v2",
} as const;
