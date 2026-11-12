import { useState } from "react";
import { approvalStatusLine, openApproval, type ApprovalCardModel } from "./approvals";

/** A signed-approval request on the Thread (K2 signed approvals S1). The
 *  daemon's card says only that an approval is asked for, by whom (as the
 *  daemon reports it) and its status. Review opens the phone's native
 *  screen, which reads the request itself, shows it, and signs it with
 *  Face ID or the passcode. Approving never happens here. */
export function ApprovalCard({
  card,
  server,
  url,
  onClosed,
}: {
  card: ApprovalCardModel;
  server: string;
  url: string;
  /** The native screen closed: re-read the Thread for the new status. */
  onClosed: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = card.status === "waiting";
  const open = async () => {
    setOpening(true);
    setError(null);
    const r = await openApproval(server, url, card.requestId);
    setOpening(false);
    if (r.outcome === "failed") setError("Couldn't open the approval screen.");
    onClosed();
  };
  return (
    <div className="flex flex-col" style={{ gap: 6 }} data-testid="approval-card" data-status={card.status}>
      <p className="text-[15px] font-semibold">Approval requested</p>
      {card.requestedBy ? (
        <p className="text-[13px]" style={{ opacity: 0.7 }} data-testid="approval-requested-by">
          Asked by {card.requestedBy}, as K2 reports it.
        </p>
      ) : null}
      <p className="text-[13px]" style={{ opacity: 0.85 }} data-testid="approval-status">
        {approvalStatusLine(card)}
      </p>
      {waiting ? (
        <button
          type="button"
          disabled={opening || !server || !url}
          onClick={() => void open()}
          className="self-start rounded-full px-3 py-1.5 text-[15px] leading-none border"
          style={{ borderColor: "#fff", background: "#fff", color: "#1c1c1e", opacity: opening ? 0.55 : 1 }}
          data-testid="approval-review"
        >
          {opening ? "Opening…" : "Review"}
        </button>
      ) : null}
      {error ? (
        <p className="text-[12px]" role="alert" style={{ opacity: 0.8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
