import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerScope } from "../../api/scope";
import { onForegroundLater } from "../../lib/foreground";
import { subscribeAppEvents } from "../ticketEvents";
import { buildFrameDoc } from "./frameDoc";
import { createFrameHost, type FrameHost, type StopReason, type VerbAnswer } from "./frameHost";
import {
  callGardenVerb,
  fetchGardenFrame,
  fetchGardenSourceChanges,
  isSourcesChanged,
  refusalEndsGardens,
  reportGardenFrame,
  type GardenFrameBody,
  type GardenRefusal,
} from "./gardensApi";
import { answerHostVerb, themeOf, layoutOf, type HostContext, type SwitchLimit } from "./hostVerbs";
import { createSourcesFeed, type SourcesFeed } from "./sourcesFeed";

const REPORTED_REFUSALS = new Set(["not_bound", "cap_not_granted", "rate_limited"]);

const STOP_COPY: Record<StopReason, string> = {
  "no-ready": "This widget didn't start.",
  "not-responding": "This widget stopped responding.",
  "keeps-failing": "This widget keeps failing.",
  "rate-limited": "This widget was stopped: too many requests.",
};

function refusalCopy(r: GardenRefusal, label: string): string {
  if (r.code === "widget_broken") return "This widget is broken on your computer.";
  if (r.code === "airgapped") return `This server can't download a library ${label} needs.`;
  if (r.code === "lib_mismatch") return `A library for ${label} didn't check, so it wasn't loaded.`;
  if (r.code === "unreachable") return "Can't reach this server.";
  return r.hint || `${label} couldn't load.`;
}

/**
 * One custom widget. The frame gets `sandbox="allow-scripts"` and nothing else
 * (§4.3): no token, no app state, no bridge. It talks through one
 * `MessageChannel` port; this page never listens on its own window.
 */
export function GardenFrame({
  scope,
  gardenId,
  placement,
  label,
  scheme,
  visible,
  viewport,
  frameVersion,
  context,
  onSize,
  onEnded,
  onStaleWidget,
}: {
  scope: ServerScope;
  gardenId: string;
  placement: string;
  label: string;
  scheme: string;
  visible: boolean;
  /** CSS px of the visible area under the chrome. */
  viewport: { width: number; height: number };
  /** Reload when it changes (rev 2 §C); `hash` on a daemon before it. */
  frameVersion?: string;
  context: HostContext;
  onSize?(height: number): void;
  /** The session ended or this login may not see Gardens (§9). */
  onEnded(code: string, hint: string): void;
  onStaleWidget?(): void;
}) {
  const [generation, setGeneration] = useState(0);
  const [doc, setDoc] = useState<{ srcdoc: string; frame: GardenFrameBody } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<FrameHost | null>(null);
  const sourcesRef = useRef<SourcesFeed | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const callbacks = useRef({ onSize, onEnded, onStaleWidget });
  callbacks.current = { onSize, onEnded, onStaleWidget };
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setProblem(null);
    void (async () => {
      const read = await fetchGardenFrame(scope, gardenId, placement, scheme);
      if (cancelled) return;
      if (!read.ok) {
        if (refusalEndsGardens(read.refusal.code)) callbacks.current.onEnded(read.refusal.code, read.refusal.hint);
        else if (read.refusal.code === "stale_widget") callbacks.current.onStaleWidget?.();
        setProblem(refusalCopy(read.refusal, label));
        return;
      }
      const built = await buildFrameDoc(scope, read.data);
      if (cancelled) return;
      if (!built.ok) {
        setProblem(refusalCopy(built.refusal, label));
        return;
      }
      setDoc({ srcdoc: built.data, frame: read.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, gardenId, placement, scheme, label, generation, frameVersion]);

  useEffect(() => {
    hostRef.current?.setVisible(visible);
    sourcesRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    hostRef.current?.setViewport(viewport);
  }, [viewport]);

  useEffect(
    () => () => {
      hostRef.current?.stop();
      hostRef.current = null;
    },
    []
  );

  const onLoad = useMemo(
    () => () => {
      const win = iframeRef.current?.contentWindow;
      if (!win || !doc) return;
      hostRef.current?.stop();
      const { frame } = doc;
      const channel = new MessageChannel();
      const port = channel.port1;
      const limit: SwitchLimit = { loadedAt: Date.now(), lastAt: null };
      const identity = { garden: frame.garden, placement: frame.placement, hash: frame.hash };
      const refused = ({ code, hint, cap, room, feature }: GardenRefusal): VerbAnswer => {
        if (refusalEndsGardens(code)) callbacks.current.onEnded(code, hint);
        if (code === "stale_widget") setGeneration((n) => n + 1);
        return { ok: false, error: { code, message: hint, cap, room, feature } };
      };
      const forward = async (verb: string, args: unknown[]): Promise<VerbAnswer> => {
        const r = await callGardenVerb(scope, { ...identity, verb, args });
        return r.ok ? { ok: true, value: r.data.result } : refused(r.refusal);
      };
      const sources = createSourcesFeed({
        readView: (address) => forward("sources.read", [address]),
        readChanges: async (since) => {
          const r = await fetchGardenSourceChanges(scope, identity, since);
          return r.ok ? { ok: true, value: r.data } : refused(r.refusal);
        },
        watch: (onChange) => {
          const events = subscribeAppEvents(scope, isSourcesChanged, onChange);
          const off = onForegroundLater(`garden-sources-${frame.garden}-${frame.placement}`, onChange);
          return () => {
            events.stop();
            off();
          };
        },
        visible: visibleRef.current,
      });
      sourcesRef.current = sources;
      const host = createFrameHost({
        post: (message, transfer) => port.postMessage(message, transfer ?? []),
        forward,
        hostVerb: (verb, args, pressed) =>
          answerHostVerb(contextRef.current, limit, verb, args, pressed, Date.now()),
        subscribe: (verb, args, push, fail) => {
          if (verb === "sources.subscribe") {
            if (typeof args[0] !== "string") return { code: "bad_args" };
            return sources.subscribe(args[0], push, fail);
          }
          // Fixed for the page on screen; live updates come with the next
          // milestone (§6: event + re-read).
          if (verb === "theme.changed") {
            push(themeOf(contextRef.current));
            return () => {};
          }
          if (verb === "layout.subscribe") {
            push(layoutOf(contextRef.current));
            return () => {};
          }
          return { code: "verb_unavailable" };
        },
        onReady: () => reportGardenFrame(scope, { ...identity, event: "ready" }),
        onError: (e) => reportGardenFrame(scope, { ...identity, event: "error", ...e }),
        onRefusal: (verb, code) => {
          if (REPORTED_REFUSALS.has(code)) reportGardenFrame(scope, { ...identity, event: "refusal", verb, code });
        },
        onSize: (height) => callbacks.current.onSize?.(height),
        onStop: (reason) => {
          port.close();
          setProblem(STOP_COPY[reason]);
          setDoc(null);
        },
      });
      hostRef.current = host;
      host.setVisible(visibleRef.current);
      port.onmessage = (e) => host.onMessage(e.data);
      // `viewport` is the one hello field the phone adds (rev 2 §B.1). An
      // older runtime drops fields it doesn't know.
      win.postMessage({ ...frame.hello, viewport: viewportRef.current }, "*", [channel.port2]);
    },
    [doc, scope]
  );

  if (problem) {
    return (
      <div
        className="h-full flex items-center justify-center text-center text-[14px]"
        style={{ padding: 20, color: "#8e8e93" }}
        data-testid="garden-frame-problem"
      >
        {problem}
      </div>
    );
  }
  if (!doc) {
    return <div className="h-full" data-testid="garden-frame-loading" />;
  }
  return (
    <iframe
      ref={iframeRef}
      title={label}
      sandbox="allow-scripts"
      srcDoc={doc.srcdoc}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      data-testid="garden-frame"
      style={{ display: "block", width: "100%", height: "100%", border: 0, background: "transparent" }}
    />
  );
}
