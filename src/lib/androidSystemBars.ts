// Android's status bar and nav buttons follow the palette on screen: dark
// icons over a light palette (Veil), light icons over a dark one. The
// palette stamps its scheme on <html> (`data-scheme`, theme/palettes.ts),
// under Light, Dark and Auto alike, so this watches that one attribute and
// tells MainActivity.kt (K2Insets.setLightBars). iOS does the same through
// set_appearance (theme/nativeAppearance.ts).

type Bridge = { setLightBars?(light: boolean): void };

/** Keep the system bars' icons readable on the current palette. */
export function installAndroidSystemBars(root: HTMLElement = document.documentElement): void {
  const bridge = (window as unknown as { K2Insets?: Bridge }).K2Insets;
  if (!bridge?.setLightBars) return;
  let last: boolean | null = null;
  const sync = () => {
    const light = root.getAttribute("data-scheme") === "light";
    if (light === last) return;
    last = light;
    try {
      bridge.setLightBars?.(light);
    } catch {
      last = null;
    }
  };
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-scheme"] });
}
