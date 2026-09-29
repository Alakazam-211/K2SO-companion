import { STUB_MARK } from "./stubData";

/** Per-row / per-tab STUB chip. shrink-0 so truncation cannot cover it. */
export function StubMark() {
  return (
    <span
      data-stub="true"
      className="shrink-0 text-[var(--warning)] uppercase tracking-widest"
    >
      {STUB_MARK}
    </span>
  );
}
