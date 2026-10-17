import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { bootInfoFor, ensureBootStatus, type ServerScope } from "../api/scope";
import { useBackHandler } from "../lib/androidBack";
import { openExternal } from "../lib/openExternal";
import { hostLabel, useServersStore } from "../stores/servers";
import {
  AGENTS_WARNING,
  AIRGAP_NOTE,
  availableCopy,
  confirmCopy,
  forbiddenCopy,
  isTerminal,
  jobDetail,
  jobHeadline,
  newerNoArtifactCopy,
  releaseNotesUrl,
  upToDateCopy,
  type CheckOutcome,
  type UpdateJob,
} from "./serverUpdate";
import {
  autoCheckIfDue,
  dismissServerUpdate,
  runUpdateCheck,
  startServerUpdate,
  useServerUpdateStore,
} from "./serverUpdateStore";
import "./serverUpdate.css";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
const RED = "#ef4444";
const GREEN = "#30d158";
const BLUE = "#0a84ff";
const AMBER = "#f59e0b";

export interface ServerUpdateSectionProps {
  serverId: string;
  scope: ServerScope;
  /** whoami role: "owner" | "admin" | "member", or null while unknown.
   *  Only owner / admin get update controls. */
  role: string | null;
}

type AvailableOutcome = Extract<CheckOutcome, { kind: "available" }>;

/** Server settings → K2 version + remote update (daemon contract v0.46.0).
 *  Everyone sees "K2 <version>" (`/boot-status`). An Owner or Admin login
 *  on a server without air-gap also gets Check for updates → confirm →
 *  progress → comeback. The job lives in `serverUpdateStore`, so the page
 *  is safe to leave mid-update. */
export function ServerUpdateSection({ serverId, scope, role }: ServerUpdateSectionProps) {
  const [version, setVersion] = useState<string | null>(
    () => bootInfoFor(serverId)?.version ?? null
  );
  const [airgap, setAirgap] = useState(() => bootInfoFor(serverId)?.airgap === true);
  const [checked, setChecked] = useState(() => bootInfoFor(serverId) !== null);
  const job = useServerUpdateStore((s) => s.jobs[serverId] ?? null);
  const outcome = useServerUpdateStore((s) => s.outcome[serverId] ?? null);
  const allowed = role === "owner" || role === "admin";

  useEffect(() => {
    let live = true;
    setVersion(bootInfoFor(serverId)?.version ?? null);
    void ensureBootStatus(scope).then((info) => {
      if (!live) return;
      setVersion(info?.version ?? null);
      setAirgap(info?.airgap === true);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [serverId, scope]);

  // The comeback recorded fresh boot info: show the new version.
  const finished = job?.stage === "done";
  useEffect(() => {
    if (finished) setVersion(bootInfoFor(serverId)?.version ?? null);
  }, [finished, serverId]);

  const airgapped = airgap || outcome?.kind === "airgap";
  const controls = allowed && checked && !airgapped;

  useEffect(() => {
    if (controls) autoCheckIfDue(scope);
  }, [controls, scope]);

  return (
    <div data-testid="server-update-section">
      <div
        className="flex items-center justify-between text-[17px]"
        style={{ minHeight: 44, padding: "11px 16px", gap: 12 }}
      >
        <span data-testid="server-version">
          {version ? `K2 ${version}` : checked ? "K2" : "K2 …"}
        </span>
        {!version && checked ? (
          <span className="text-[15px]" style={{ color: MUTED }}>
            Version unknown
          </span>
        ) : null}
      </div>
      {allowed && checked && airgapped ? (
        <Block>
          <span className="text-[13px]" style={{ color: MUTED }} data-testid="server-update-airgap">
            {AIRGAP_NOTE}
          </span>
        </Block>
      ) : null}
      {controls ? <UpdateControls serverId={serverId} scope={scope} job={job} outcome={outcome} /> : null}
    </div>
  );
}

function Block({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="flex flex-col"
      style={{ padding: "11px 16px", borderTop: HAIRLINE, gap: 8 }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function RowButton({
  label,
  onClick,
  testId,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`text-[15px] ${primary ? "font-semibold" : "k2-tile"}`}
      style={{
        minHeight: 36,
        padding: "0 14px",
        borderRadius: 10,
        color: "#fff",
        background: primary ? BLUE : undefined,
        opacity: disabled ? 0.5 : 1,
      }}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function useHostNames(serverId: string, fallback: string): { host: string; hostname: string } {
  const entry = useServersStore((s) => s.servers.find((x) => x.id === serverId));
  if (!entry) return { host: fallback, hostname: "" };
  const hostname = hostLabel(entry.url);
  return { host: entry.nickname || hostname, hostname };
}

function UpdateControls({
  serverId,
  scope,
  job,
  outcome,
}: {
  serverId: string;
  scope: ServerScope;
  job: UpdateJob | null;
  outcome: CheckOutcome | null;
}) {
  const checking = useServerUpdateStore((s) => s.checking[serverId] === true);
  const { host, hostname } = useHostNames(serverId, scope.label);
  const [confirm, setConfirm] = useState<AvailableOutcome | null>(null);

  if (job) return <JobView job={job} scope={scope} />;

  const check = () => void runUpdateCheck(scope);

  if (checking) {
    return (
      <Block testId="server-update-checking">
        <span className="text-[15px]" style={{ color: MUTED }}>
          Checking for updates…
        </span>
      </Block>
    );
  }

  if (!outcome) {
    return (
      <Block>
        <div>
          <RowButton label="Check for updates" onClick={check} testId="server-update-check" />
        </div>
      </Block>
    );
  }

  switch (outcome.kind) {
    case "up-to-date":
      return (
        <Block>
          <span className="text-[15px]" data-testid="server-update-result">
            {upToDateCopy(outcome.current)}
          </span>
          <div>
            <RowButton label="Check again" onClick={check} testId="server-update-check" />
          </div>
        </Block>
      );
    case "no-artifact":
      return (
        <Block>
          <span className="text-[15px]" style={{ color: MUTED }} data-testid="server-update-result">
            {newerNoArtifactCopy(host, outcome.latest, outcome.platform)}
          </span>
          <div>
            <RowButton label="Check again" onClick={check} testId="server-update-check" />
          </div>
        </Block>
      );
    case "forbidden":
      return (
        <Block>
          <span className="text-[15px]" style={{ color: MUTED }} data-testid="server-update-result">
            {forbiddenCopy(host)}
          </span>
        </Block>
      );
    case "airgap":
      return null;
    case "error":
      return (
        <Block>
          <span className="text-[15px]" style={{ color: RED }} data-testid="server-update-error">
            Couldn't check for updates: {outcome.message}
          </span>
          <div>
            <RowButton label="Retry" onClick={check} testId="server-update-retry" />
          </div>
        </Block>
      );
    case "available":
      return (
        <Block>
          <span className="text-[15px]" data-testid="server-update-result">
            {availableCopy(outcome.current, outcome.latest)}
          </span>
          <div className="flex items-center" style={{ gap: 10 }}>
            <RowButton
              label="Update"
              primary
              onClick={() => setConfirm(outcome)}
              testId="server-update-update"
            />
            <button
              type="button"
              className="text-[15px]"
              style={{ color: BLUE, minHeight: 36 }}
              data-testid="server-update-notes"
              onClick={() => void openExternal(releaseNotesUrl(outcome.latest))}
            >
              Release notes
            </button>
          </div>
          {confirm ? (
            <ConfirmSheet
              host={host}
              hostname={hostname}
              outcome={confirm}
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                setConfirm(null);
                void startServerUpdate(scope, {
                  host,
                  current: confirm.current,
                  latest: confirm.latest,
                  installKind: confirm.installKind,
                });
              }}
            />
          ) : null}
        </Block>
      );
  }
}

function JobView({ job, scope }: { job: UpdateJob; scope: ServerScope }) {
  if (!isTerminal(job)) {
    return (
      <Block testId="server-update-job">
        <span className="text-[15px] font-semibold" data-testid="server-update-headline">
          {jobHeadline(job)}
        </span>
        <span className="text-[13px]" style={{ color: MUTED, lineHeight: 1.35 }} data-testid="server-update-detail">
          {jobDetail(job)}
        </span>
        <div className="k2-update-bar" role="progressbar" aria-label="Updating" data-testid="server-update-bar" />
      </Block>
    );
  }
  if (job.stage === "done") {
    return (
      <Block testId="server-update-job">
        {job.outcome === "updated" ? (
          <span className="text-[15px]" style={{ color: GREEN }} data-testid="server-update-headline">
            Updated to {job.finalVersion ?? job.latest}
          </span>
        ) : (
          <span className="text-[15px]" style={{ color: AMBER }} data-testid="server-update-headline">
            {job.error}
          </span>
        )}
        <div>
          <RowButton label="Done" onClick={() => dismissServerUpdate(job.serverId)} testId="server-update-dismiss" />
        </div>
      </Block>
    );
  }
  return (
    <Block testId="server-update-job">
      <span className="text-[15px]" style={{ color: RED, lineHeight: 1.35 }} data-testid="server-update-headline">
        {job.error}
      </span>
      {job.stillOn ? (
        <span className="text-[13px]" style={{ color: MUTED }} data-testid="server-update-still-on">
          Still on {job.current}
        </span>
      ) : null}
      <div>
        <RowButton
          label="Check again"
          onClick={() => {
            dismissServerUpdate(job.serverId);
            void runUpdateCheck(scope);
          }}
          testId="server-update-dismiss"
        />
      </div>
    </Block>
  );
}

function ConfirmSheet({
  host,
  hostname,
  outcome,
  onCancel,
  onConfirm,
}: {
  host: string;
  hostname: string;
  outcome: AvailableOutcome;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Android Back = Cancel.
  useBackHandler(true, onCancel);
  const copy = confirmCopy(host, hostname, outcome.latest, outcome.installKind);
  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="server-update-confirm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, var(--safe-bottom))",
          gap: 12,
          color: "#fff",
        }}
      >
        <h2 className="text-[17px] font-semibold text-center" data-testid="server-update-confirm-title">
          {copy.title}
        </h2>
        <div
          role="alert"
          className="text-[15px] font-semibold"
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(245,158,11,.14)",
            border: `1px solid ${AMBER}`,
            color: "#fbbf24",
            lineHeight: 1.35,
          }}
          data-testid="server-update-confirm-warning"
        >
          {AGENTS_WARNING}
        </div>
        <p className="text-[13px]" style={{ color: MUTED, lineHeight: 1.4 }} data-testid="server-update-confirm-body">
          {copy.message}
        </p>
        <div className="flex" style={{ gap: 10 }}>
          <button
            type="button"
            className="flex-1 text-[17px] k2-tile"
            style={{ minHeight: 44, borderRadius: 12, color: "#fff" }}
            data-testid="server-update-confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex-1 text-[17px] font-semibold"
            style={{ minHeight: 44, borderRadius: 12, color: "#fff", background: RED }}
            data-testid="server-update-confirm-go"
            onClick={onConfirm}
          >
            {copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
