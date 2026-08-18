import type { MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";

// Desktop `@/components/Markdown/Markdown`: strip javascript/data/vbscript,
// pass everything else through. Phone has no LaunchServices handler —
// http(s)/mailto/tel open in a new window so WKWebView does not navigate
// the app away.

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
}: {
  href?: string;
  children?: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    e.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <a href={href} onClick={onClick} rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function Markdown(props: Options) {
  return (
    <ReactMarkdown
      urlTransform={safeUrlTransform}
      components={{ a: MarkdownLink }}
      {...props}
    />
  );
}
