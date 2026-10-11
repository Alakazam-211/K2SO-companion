import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { measureTextPx, middleEllipsis } from "./nameEllipsis";

/** A file name that cuts in the middle and keeps its last 10 characters.
 *  Display only: the full name stays in `title` (and `aria-label` on the
 *  row, or here with `labelled`).
 *  Width comes from the span itself (it fills its slot), re-measured on
 *  resize. No `truncate` class: that would paint a second ellipsis. */
export function MiddleEllipsis({
  text,
  className,
  style,
  title,
  measure,
  testId,
  labelled = false,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
  /** Defaults to `text`. */
  title?: string;
  /** Override the text measurer (tests). */
  measure?: (s: string) => number;
  testId?: string;
  /** Also put the full name in `aria-label`. Off when the row around it
   *  already carries one (two labels would read twice). */
  labelled?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [font, setFont] = useState<{ css: string; px: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      setWidth(el.clientWidth || null);
      try {
        const cs = getComputedStyle(el);
        const px = parseFloat(cs.fontSize) || 12;
        const css = cs.font || `${cs.fontWeight || 400} ${px}px ${cs.fontFamily || "sans-serif"}`;
        setFont((f) => (f && f.css === css && f.px === px ? f : { css, px }));
      } catch {
        /* keep the estimate */
      }
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = measure ?? ((s: string) => measureTextPx(s, font?.css ?? "12px sans-serif", font?.px ?? 12));
  // Not measured yet (first paint, or a zero-width test DOM): full name.
  const shown = width ? middleEllipsis(text, width, m) : text;
  const full = title ?? text;
  return (
    <span
      ref={ref}
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${className ?? ""}`.trim()}
      // Fill the slot (never content-sized), or a cut name would shrink
      // the span and cut itself again.
      style={{ width: "100%", ...style }}
      title={full}
      aria-label={labelled ? full : undefined}
      data-testid={testId}
      data-full={text}
    >
      {shown}
    </span>
  );
}
