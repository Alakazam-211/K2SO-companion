import { memo, useMemo, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import Markdown from "../../components/Markdown";
import { FenceBlock } from "./CodeView";
import { fenceLanguage } from "./highlight";
import { looksLikeFileRef } from "../chatLinks";

const REMARK_PLUGINS = [remarkGfm];

function textOf(children: ReactNode): string {
  return String(Array.isArray(children) ? children.join("") : children ?? "");
}

/** Built once per `onFileLink` so ReactMarkdown keeps its tree (and the
 *  text selection) across parent renders (desktop `MARKDOWN_COMPONENTS`). */
const makeComponents = (onFileLink?: (ref: string) => void) => ({
  code({ className, children }: { className?: string; children?: ReactNode }) {
    const match = /language-([\w+#-]+)/.exec(className || "");
    if (match) {
      return <FenceBlock code={textOf(children).replace(/\n$/, "")} lang={fenceLanguage(match[1])} />;
    }
    const text = textOf(children);
    if (!className && onFileLink && looksLikeFileRef(text)) {
      return (
        <button type="button" className="chat-file-ref" onClick={() => onFileLink(text.trim())}>
          {children}
        </button>
      );
    }
    return <code className={className}>{children}</code>;
  },
  // A highlighted fence renders its own <pre>; do not nest it in another.
  pre({ children, node }: { children?: ReactNode; node?: unknown }) {
    const first = (node as { children?: { properties?: { className?: unknown } }[] })
      ?.children?.[0];
    const cls = first?.properties?.className;
    const fenced = Array.isArray(cls) && cls.some((c) => String(c).startsWith("language-"));
    return fenced ? <>{children}</> : <pre>{children}</pre>;
  },
  // Relative images would load from the app bundle: show the alt text.
  img({ src, alt }: { src?: string | Blob; alt?: string }) {
    if (typeof src === "string" && /^https?:\/\//i.test(src)) {
      return <img src={src} alt={alt ?? ""} className="fv-md-img" />;
    }
    return <span className="text-[var(--text-muted)]">[{alt || "image"}]</span>;
  },
});

/** GFM markdown with the chat's `.markdown-content` styles. File links
 *  open the linked file on top of this one. */
export const MarkdownView = memo(function MarkdownView({
  content,
  onFileLink,
}: {
  content: string;
  onFileLink?: (ref: string) => void;
}) {
  const components = useMemo(() => makeComponents(onFileLink), [onFileLink]);
  return (
    <div className="markdown-content fv-markdown" data-testid="file-markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components} onFileLink={onFileLink}>
        {content}
      </Markdown>
    </div>
  );
});
