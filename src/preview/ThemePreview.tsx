// Theme preview (development only; served by preview/vite.config.ts, never
// in the app build). Real screens with fixture data, under any palette and
// accent, at iPhone size, with no server:
//
//   /preview/theme.html?palette=obsidian|veil|yellow&accent=<hex|yellow>&screen=thread|home|settings|themes|home-chat|home-chat-channel|home-chat-menu|home-chat-members
//
// Extras: `jump=1` scrolls the Thread up so the jump pill shows; `chrome=0`
// hides the fake status bar and home indicator. Open it at 393×852 (device
// mode) or use scripts/theme-shots.mjs. `window.__previewReady` turns true
// once the screen has settled.

import "./netStub";
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../styles/index.css";
import { initZenFont } from "../zen/zenFont";
import { applyTheme, paletteById, writeAccent, writeSelection, DEFAULT_SELECTION, type PaletteId } from "../theme/palettes";
import { parseAccentChoice } from "../theme/styleAccent";
import { useThemeStore } from "../theme/themeStore";
import { Zen } from "../pages/Zen";
import { ZenSettings } from "../zen/ZenSettings";
import { ThemesPage } from "../zen/ThemesPage";
import { HOME_ROWS_SCREENS, PREVIEW_SCREENS, seedDraft, seedHomeGroups, seedHomeRows, seedStores, type PreviewScreen } from "./fixtures";
import { askHome } from "../zen/homeChat/HomeConfirmSheet";
import { samePersonCopy } from "../zen/homeChat/homeChatRows";

const params = new URLSearchParams(location.search);
const palette: PaletteId = paletteById(params.get("palette"))?.id ?? "obsidian";
const accent = parseAccentChoice(params.get("accent"));
const screen: PreviewScreen = PREVIEW_SCREENS.find((s) => s === params.get("screen")) ?? "thread";
const jump = params.get("jump") === "1";
const chrome = params.get("chrome") !== "0";

// iPhone 15/16 Pro insets (portrait): the status bar and the home indicator.
const SAFE = { top: 59, bottom: 34, left: 0, right: 0 };
for (const [side, px] of Object.entries(SAFE)) {
  document.documentElement.style.setProperty(`--preview-safe-${side}`, `${px}px`);
}

// iOS scrollbars overlay and fade; desktop WebKit's would take a gutter.
const noScrollbars = document.createElement("style");
noScrollbars.textContent = "*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none; } * { scrollbar-width: none; }";
document.head.appendChild(noScrollbars);

// The theme, as Settings → Themes would leave it: this palette on its side,
// shown, with this accent.
const p = paletteById(palette)!;
const selection = { ...DEFAULT_SELECTION, mode: p.scheme, [p.scheme]: p.id };
writeSelection(selection, false);
writeAccent(p.id, accent);
useThemeStore.setState({
  ...selection,
  shown: p.id,
  accents: { obsidian: null, veil: null, yellow: null, [p.id]: accent },
});
applyTheme(p.id, accent);
initZenFont();

seedStores(screen);
if (screen === "thread") seedDraft();
if (screen === "home-groups" || screen === "home-groups-sheet") seedHomeGroups(screen === "home-groups-sheet");
if (HOME_ROWS_SCREENS.includes(screen)) seedHomeRows(screen);

/** What a People and channels screen opens once Home is up: Add to Home
 *  (its tab is seeded), a person row's hold menu, or "Same person?". */
async function openChatExtras(): Promise<void> {
  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  if (screen === "add-to-home" || screen === "add-to-home-channels" || screen === "add-to-home-new") {
    document.querySelector<HTMLElement>('[aria-label="Add to Home"]')?.click();
    await wait(150);
    if (screen === "add-to-home-new") {
      document.querySelector<HTMLElement>("[data-testid=add-channels-mode-new]")?.click();
      await wait(100);
      const name = document.querySelector<HTMLInputElement>("[data-testid=new-channel-name]");
      if (name) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(name, "launch-notes");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        name.blur();
      }
      document.querySelector<HTMLElement>('[data-testid="new-channel-member-k2:connect:ana"]')?.click();
    }
  } else if (screen === "home-people-menu") {
    const row = document.querySelector<HTMLElement>('[data-testid="home-chat-person-k2:connect:ben"]');
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  } else if (screen === "home-same-person") {
    const copy = samePersonCopy("Ana R.", "Ana Ruiz", "Studio");
    void askHome({
      title: copy.title,
      body: copy.body,
      choices: [
        { id: "same", label: "Same person", primary: true },
        { id: "different", label: "Different person" },
      ],
      testId: "same-person",
    });
  }
}

/** The phone's status bar and home indicator, in the palette's text colour. */
function PhoneChrome() {
  if (!chrome) return null;
  const ink = "var(--color-text-primary, #fff)";
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147483000 }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: SAFE.top,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 30px 0 46px",
          color: ink,
          font: "600 17px -apple-system, system-ui, sans-serif",
        }}
      >
        <span>9:41</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <svg width="18" height="12" viewBox="0 0 18 12" fill={ink}>
            <rect x="0" y="8" width="3" height="4" rx="1" />
            <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
            <rect x="10" y="3" width="3" height="9" rx="1" />
            <rect x="15" y="0" width="3" height="12" rx="1" />
          </svg>
          <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
            <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke={ink} opacity="0.4" />
            <rect x="2" y="2" width="20" height="9" rx="2" fill={ink} />
            <rect x="25" y="4.5" width="1.5" height="4" rx="0.75" fill={ink} opacity="0.4" />
          </svg>
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: "50%",
          width: 134,
          height: 5,
          marginLeft: -67,
          borderRadius: 3,
          background: ink,
        }}
      />
    </div>
  );
}

/** Re-seed after the screen's mount effects (their loads never answer, but
 *  some clear the stores first), then say ready. */
function Settle({ children }: { children: ReactNode }) {
  useEffect(() => {
    const timers: number[] = [];
    const reseed = () => seedStores(screen);
    reseed();
    timers.push(window.setTimeout(reseed, 120), window.setTimeout(reseed, 500));
    timers.push(
      window.setTimeout(async () => {
        if (HOME_ROWS_SCREENS.includes(screen)) await openChatExtras();
        // Home chat: open the hold menu on Maya's newest message (and, on
        // the DM, pick Reply so the chip shows), or the members sheet.
        if (screen === "home-chat" || screen === "home-chat-menu") {
          const bubbles = document.querySelectorAll<HTMLElement>("[data-message-hold]");
          const theirs = Array.from(bubbles).filter((b) => !b.closest("[data-mine]"));
          const target = theirs[theirs.length - 1];
          target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
          if (screen === "home-chat") {
            await new Promise((r) => window.setTimeout(r, 50));
            document.querySelector<HTMLElement>("[data-testid=menu-reply]")?.click();
          }
        }
        if (screen === "home-chat-members") {
          document.querySelector<HTMLElement>("[data-testid=home-chat-title-button]")?.click();
        }
        if (jump) {
          const list = document.querySelector<HTMLElement>("[data-testid=thread-scroller]");
          if (list) {
            list.scrollTop = Math.max(0, list.scrollTop - 260);
            list.dispatchEvent(new Event("scroll"));
          }
        }
        await document.fonts?.ready;
        window.setTimeout(() => (window.__previewReady = true), 600);
      }, 700)
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return <>{children}</>;
}

function Screen() {
  if (screen === "settings" || screen === "themes") {
    return (
      <div className="zen-font" style={{ position: "fixed", inset: 0 }}>
        {screen === "settings" ? <ZenSettings onClose={() => {}} /> : <ThemesPage onBack={() => {}} />}
      </div>
    );
  }
  return <Zen />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/zen"]}>
      <Settle>
        <Screen />
      </Settle>
    </MemoryRouter>
    <PhoneChrome />
  </StrictMode>
);
