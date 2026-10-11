import type { ReactNode } from "react";
import { NO_MESSAGES_TEXT, YOU_PREFIX, type InlineNode, type RowPreview } from "./rowPreview";

/**
 * Line two of an Agents / Home row. Inline spans only, so the parent's
 * `truncate` (nowrap + hidden + ellipsis) keeps it to one line. The base
 * colour is the parent's muted grey; bold and italics sit on top.
 */
export function RowSnippet({ preview }: { preview: RowPreview }) {
  switch (preview.kind) {
    case "loading":
      // Keeps the line's height without placeholder text that then jumps.
      return <span data-testid="row-preview-loading">{" "}</span>;
    case "empty":
      return (
        <span data-testid="row-preview-empty" style={{ opacity: 0.7 }}>
          {NO_MESSAGES_TEXT}
        </span>
      );
    case "label":
      return <>{preview.text}</>;
    case "snippet":
      return (
        <>
          {preview.mine ? YOU_PREFIX : null}
          {renderNodes(preview.nodes)}
        </>
      );
  }
}

function renderNodes(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (typeof n === "string") return n;
    switch (n.tag) {
      case "strong":
        return (
          <strong key={i} style={{ fontWeight: 600 }}>
            {renderNodes(n.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderNodes(n.children)}</em>;
      case "del":
        return <del key={i}>{renderNodes(n.children)}</del>;
      case "link":
        // Plain coloured text: the whole row is the tap target.
        return (
          <span key={i} data-testid="row-preview-link" style={{ color: "var(--accent, #0a84ff)" }}>
            {renderNodes(n.children)}
          </span>
        );
      case "code":
        return (
          <code
            key={i}
            data-testid="row-preview-code"
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.86em",
              padding: "1px 4px",
              borderRadius: 4,
              background: "rgba(255,255,255,0.08)",
            }}
          >
            {n.text}
          </code>
        );
      case "marker":
        return (
          <span key={i} data-testid="row-preview-table" style={{ opacity: 0.7 }}>
            {n.text}
          </span>
        );
    }
  });
}
