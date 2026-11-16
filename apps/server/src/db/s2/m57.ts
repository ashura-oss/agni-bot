import type { Migration } from "../migrations";

/**
 * 57: approval rules by resource pattern, and what a card remembers (S2-08).
 * `resource_pattern` is set on a rule that matches by pattern instead of one
 * exact target (still one bot and one tool). `approvals.card_meta` holds the
 * source, tier, expiry and truncated flag the card was raised with, so a card
 * replayed on reconnect is the same card.
 */
export const migration: Migration | null = {
  id: 57,
  name: "approval_rule_resource_pattern_and_card_meta",
  sql: `
    ALTER TABLE approval_rules ADD COLUMN resource_pattern TEXT;
    ALTER TABLE approvals ADD COLUMN card_meta TEXT;
  `,
};
