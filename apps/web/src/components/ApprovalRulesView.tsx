/**
 * The standing "Always allow" rules: each one lets one bot use one tool on one
 * target without asking. They are listed so the owner can see what has been
 * waved through, and take any of them back.
 */
import { format } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

export function ApprovalRulesView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const rules = snapshot.approvalRules;
  const connected = snapshot.connectionState.kind === "ready";

  if (rules === null) {
    return <span className="settings-note">{connected ? "Loading the rules…" : "Connect to the daemon to see the rules."}</span>;
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
    <ul className="rule-list" aria-label="Always allow rules">
      {rules.map((rule) => {
        const bot = rule.agentName ?? `${rule.agentID} (removed)`;
        const when = format.parseISO(rule.createdAt);
        return (
          <li key={rule.id} className="rule-row">
            <div className="rule-main">
              <div className="rule-title">
                <span className="rule-bot">{bot}</span>
                <span className="rule-tool">{rule.toolName}</span>
              </div>
              <div className="rule-target">{rule.target}</div>
              {when ? <div className="settings-note">Allowed {format.stamp(when)}</div> : null}
            </div>
            <button
              type="button"
              className="btn small danger"
              disabled={!connected}
              aria-label={`Revoke ${rule.toolName} for ${bot}`}
              onClick={() => model.revokeApprovalRule(rule.id)}
            >
              Revoke
            </button>
          </li>
        );
      })}
    </ul>
  );
}
