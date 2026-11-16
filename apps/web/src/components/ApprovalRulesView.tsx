/**
 * The standing "Always allow" rules: each one lets one bot use one tool on one
 * target without asking. They are listed so the owner can see what has been
 * waved through, and take any of them back.
 */
import { useEffect, useRef } from "react";
import { format, safeLine } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

export function ApprovalRulesView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const rules = snapshot.approvalRules;
  const connected = snapshot.connectionState.kind === "ready";
  const list = useRef<HTMLUListElement>(null);
  const count = rules?.length ?? 0;
  const previousCount = useRef(count);

  // The list changes behind the page's back (an "Always allow" answered in chat, a revoke on
  // another device): ask again whenever it is opened.
  useEffect(() => {
    model.refreshApprovalRules();
  }, [model]);

  // When Revoke removes a row, its button is gone: keyboard focus would fall to the page.
  // Send it to the Revoke button now in that place, or to the heading when none are left.
  useEffect(() => {
    if (count < previousCount.current) {
      const buttons = list.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      const index = Math.min(removedIndex.current, (buttons?.length ?? 1) - 1);
      const target = buttons && buttons.length > 0 ? buttons[Math.max(0, index)] : document.querySelector<HTMLElement>(".settings-heading h1");
      if (target) {
        if (!target.hasAttribute("tabindex") && target.tagName === "H1") target.setAttribute("tabindex", "-1");
        target.focus();
      }
    }
    previousCount.current = count;
  }, [count]);
  const removedIndex = useRef(0);

  if (rules === null) {
    return (
      <span className="settings-note" role="status" aria-live="polite">
        {connected ? "Loading the rules…" : "Connect to the daemon to see the rules."}
      </span>
    );
  }
  if (rules.length === 0) {
    return (
      <div className="empty-note">
        <strong>Nothing is always allowed</strong>
        <span>When you choose “Always allow” on an approval, the rule is listed here and can be revoked.</span>
      </div>
    );
  }
  return (
    <ul className="rule-list" aria-label="Always allow rules" ref={list}>
      {rules.map((rule) => {
        const bot = safeLine(rule.agentName ?? `${rule.agentID} (removed)`, 80);
        const when = format.parseISO(rule.createdAt);
        return (
          <li key={rule.id} className="rule-row">
            <div className="rule-main">
              <div className="rule-title">
                <span className="rule-bot">{bot}</span>
                <span className="rule-tool">{safeLine(rule.toolName, 80)}</span>
              </div>
              <div className="rule-target">{safeLine(rule.target, 320)}</div>
              {when ? <div className="settings-note">Allowed {format.stamp(when)}</div> : null}
            </div>
            <button
              type="button"
              className="btn small danger"
              disabled={!connected}
              aria-label={`Revoke ${rule.toolName} for ${bot}`}
              onClick={() => {
                removedIndex.current = rules.findIndex((candidate) => candidate.id === rule.id);
                model.revokeApprovalRule(rule.id);
              }}
            >
              Revoke
            </button>
          </li>
        );
      })}
    </ul>
  );
}
