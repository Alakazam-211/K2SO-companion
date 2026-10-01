import type { MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import { openExternal } from "../lib/openExternal";
import {
  classifyHref,
  fileRefFromHref,
  looksLikeFileRef,
} from "../zen/chatLinks";

// Desktop `@/components/Markdown/Markdown`: strip javascript/data/vbscript.
// http(s)/mailto/tel open in the system browser (native on iOS). A file
// path mention calls onFileLink so the overlay can open it in the file stage.

function safeUrlTransform(url: string): string {
  const lower = url.trim().toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:")
  ) {
    return "";
  }
  return url;
}

function MarkdownLink({
  href,
  children,
  onFileLink,
}: {
  href?: string;
  children?: ReactNode;
  onFileLink?: (ref: string) => void;
}) {
  const kind = classifyHref(href);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href || kind === "none") return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "web") void openExternal(href);
    else if (kind === "file") onFileLink?.(fileRefFromHref(href));
  };
  if (kind === "none") {
    return <span>{children}</span>;
  }
  return (
    <a
      href={href}
      onClick={onClick}
      rel="noopener noreferrer"
      data-testid={kind === "web" ? "chat-web-link" : "chat-file-link"}
    >
      {children}
    </a>
  );
}

function MarkdownCode({
  className,
  children,
  onFileLink,
}: {
  className?: string;
  children?: ReactNode;
  onFileLink?: (ref: string) => void;
}) {
  const text = String(children ?? "");
  const inlineFile =
    !className && looksLikeFileRef(text) && typeof onFileLink === "function";
  if (inlineFile) {
    return (
      <button
        type="button"
        className="chat-file-ref"
        data-testid="chat-file-ref"
        onClick={() => onFileLink(text.trim())}
      >
        {children}
      </button>
    );
  }
  return <code className={className}>{children}</code>;
}

export default function Markdown({
  onFileLink,
  components,
  ...props
}: Options & { onFileLink?: (ref: string) => void }) {
  return (
    <ReactMarkdown
      urlTransform={safeUrlTransform}
      components={{
        a: (p) => (
          <MarkdownLink href={p.href} onFileLink={onFileLink}>
            {p.children}
          </MarkdownLink>
        ),
        code: (p) => (
          <MarkdownCode className={p.className} onFileLink={onFileLink}>
            {p.children}
          </MarkdownCode>
        ),
        ...components,
      }}
      {...props}
    />
  );
}
