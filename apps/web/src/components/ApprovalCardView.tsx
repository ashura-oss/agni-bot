/**
 * The approval card: who is asking, what the call is (the whole preview, scrollable, never cut by
 * this app), how long it has left, and the buttons the daemon offered. A card the daemon marked
 * `truncated` hides part of the call or is too long to take in at a glance: Allow stays locked
 * (aria-disabled, still focusable) until the owner has opened the full text. Deny always works.
 *
 * The daemon writes the source line, the risk line and the "Always allow is off" line into the
 * preview itself, so they are shown there and not drawn a second time from `source` or `tier`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Hand } from "lucide-react";
import {
  READ_FIRST,
  allowLocked,
  decisionTitle,
  expiryOf,
  safeLine,
  safeText,
  type ApprovalRow,
} from "@agni/client";
import { useDialog } from "./use-dialog";

/** Re-reads the clock while a card has a deadline, so "Expires in 9 min" counts down and the card expires on time. */
function useClock(active: boolean): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((value) => value + 1), 10_000);
    return () => clearInterval(timer);
  }, [active]);
  return Date.now();
}

function decisionLabel(decision: string): string {
  return decision === "reject" ? "Deny" : decisionTitle(decision);
}

export function ApprovalCard({
  approval,
  requester,
  onAnswer,
  onOpenFull,
}: {
  approval: ApprovalRow;
  /** The bot that asked, or null when the frames did not say: never the product's name. */
  requester: string | null;
  onAnswer: (decision: string) => void;
  onOpenFull: () => void;
}) {
  const ids = useId();
  const headingID = `${ids}-heading`;
  const hintID = `${ids}-hint`;
  const [dialogOpen, setDialogOpen] = useState(false);
  const viewButton = useRef<HTMLButtonElement>(null);
  const now = useClock(Boolean(approval.expiresAt));
  const expiry = expiryOf(approval.expiresAt, now);
  const locked = allowLocked(approval);
  const heading = requester ? `${requester} wants to run something` : "A bot wants to run something";
  const who = requester ?? "A bot";
  const full = approval.full;

  const openFull = (): void => {
    setDialogOpen(true);
    if (full?.state !== "open") onOpenFull();
  };

  const answer = (decision: string): void => {
    if (decision !== "reject" && locked) {
      // Allow is not available yet: the way forward is the full text.
      viewButton.current?.focus();
      return;
    }
    onAnswer(decision);
  };

  if (expiry.kind === "expired") {
    return (
      <div className="approval-card expired" role="group" aria-labelledby={headingID}>
        <div className="card-heading">
          <Hand size={12} color="var(--ember)" />
          <span id={headingID}>{heading}</span>
        </div>
        <div className="approval-action">{safeLine(approval.action, 800)}</div>
        <p className="approval-expired" role="status">
          Expired. Not run.
          <br />
          {who} was told no. Ask again in the chat if you still want it.
        </p>
      </div>
    );
  }

  return (
    <div className="approval-card" role="group" aria-labelledby={headingID} data-tier={approval.tier ?? undefined}>
      <div className="card-heading" title={approval.tier ? `Risk tier ${approval.tier}` : undefined}>
        <Hand size={12} color="var(--ember)" />
        <span id={headingID}>{heading}</span>
        <span className="spacer" />
        {expiry.kind === "left" ? <span className="approval-expiry">{expiry.text}</span> : null}
      </div>
      <div className="approval-action">{safeLine(approval.action, 800)}</div>
      {approval.preview.length > 0 ? (
        <div className="approval-preview" role="region" aria-label={`Preview of what ${who} wants to run`} tabIndex={0}>
          {safeText(approval.preview)}
        </div>
      ) : null}
      {approval.truncated ? (
        <div className="approval-full-row">
          <span id={hintID} className="approval-full-hint">
            {locked ? READ_FIRST : "You have opened the full text."}
          </span>
          <button
            ref={viewButton}
            type="button"
            className="btn small approval-view-full"
            onClick={openFull}
          >
            {full?.state === "open" ? "View full text again" : "View full text"}
          </button>
        </div>
      ) : null}
      {approval.notice ? (
        <p className="approval-notice" role="alert">
          {approval.notice}
        </p>
      ) : null}
      <div className="card-actions">
        {approval.decisions.map((decision) => (
          <DecisionButton
            key={decision}
            decision={decision}
            heading={heading}
            locked={decision !== "reject" && locked}
            hintID={hintID}
            onClick={() => answer(decision)}
          />
        ))}
      </div>
      {dialogOpen ? (
        <FullTextDialog
          approval={approval}
          heading={heading}
          locked={locked}
          onTryAgain={onOpenFull}
          onAnswer={(decision) => {
            if (decision !== "reject" && locked) return;
            setDialogOpen(false);
            onAnswer(decision);
          }}
          onClose={() => {
            setDialogOpen(false);
            // The dialog hands focus back to what opened it; do it here too so a click that never focused the button still lands there.
            queueMicrotask(() => viewButton.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}

function DecisionButton({
  decision,
  heading,
  locked,
  hintID,
  onClick,
}: {
  decision: string;
  heading: string;
  locked: boolean;
  hintID: string;
  onClick: () => void;
}) {
  const label = decisionLabel(decision);
  return (
    <button
      type="button"
      className={`btn small approval-decision${decision === "once" ? " primary" : ""}`}
      aria-label={`${label}: ${heading}`}
      aria-disabled={locked ? "true" : undefined}
      aria-describedby={locked ? hintID : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** The whole call in a dialog: the owner reads it, then can allow or deny from here, or close and decide on the card. */
function FullTextDialog({
  approval,
  heading,
  locked,
  onTryAgain,
  onAnswer,
  onClose,
}: {
  approval: ApprovalRow;
  heading: string;
  locked: boolean;
  onTryAgain: () => void;
  onAnswer: (decision: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleID = useId();
  const hintID = `${titleID}-hint`;
  useDialog(ref, onClose, ".approval-full-title");
  const full = approval.full;
  const body =
    full?.state === "open" ? (
      <pre className="approval-full-text">{safeText(full.text)}</pre>
    ) : full?.state === "failed" ? (
      <div className="approval-full-status" role="alert">
        <p>Could not load the full text. Check the connection and try again.</p>
        <button type="button" className="btn small" onClick={onTryAgain}>
          Try again
        </button>
      </div>
    ) : (
      <p className="approval-full-status" role="status">
        Loading the full text…
      </p>
    );
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog wide approval-full-dialog" role="dialog" aria-modal="true" aria-labelledby={titleID} ref={ref}>
        <p id={hintID} className="visually-hidden">
          {READ_FIRST}
        </p>
        <h2 id={titleID} className="approval-full-title" tabIndex={-1}>
          Full text: {heading}
        </h2>
        {full?.state === "open" && full.cut ? (
          <p className="approval-notice" role="alert">
            Even this text is cut: the call is longer than the daemon will send. Allow stays off; Deny works.
          </p>
        ) : null}
        <div className="approval-full-body" role="region" aria-label="Full text of the call" tabIndex={0}>
          {body}
        </div>
        <div className="dialog-actions approval-full-actions">
          {approval.decisions
            .filter((decision) => decision !== "always")
            .map((decision) => (
              <DecisionButton
                key={decision}
                decision={decision}
                heading={heading}
                locked={decision !== "reject" && locked}
                hintID={hintID}
                onClick={() => onAnswer(decision)}
              />
            ))}
          <span className="spacer" />
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
