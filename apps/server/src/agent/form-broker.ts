/**
 * Forms: the questions an agent puts to the owner.
 *
 * A form is a *choice* — a question with options, one or many of them — or
 * an *email draft* the agent wants the owner to look at before it goes out.
 * The broker writes the durable row, draws the card on the client, and waits
 * for the answer; the answer comes back on the `form.answer` frame and the
 * turn carries on with it.
 *
 * If the owner would rather type than choose, the client answers the form
 * with their own words and sends their message on: the question is dismissed
 * and the message steers the work.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { answerForm, createForm, getForm, type FormEmail, type FormKind } from "../stores/forms";
import { OWNER_WAIT_CEILING_MS, expireCard } from "./pending-cards";
import { entry, multiLine } from "./card-text";

/** Waiters are process-local; the row remains the durable authority. */
const formWaiters = new Map<string, (answer: string) => void>();

export function resolveFormWaiter(requestID: string, answer: string): void {
  formWaiters.get(requestID)?.(answer);
}

/** Resolve a form the owner answered, and wake the turn waiting on it. */
export function answerFormAndWake(db: Database, requestID: string, answer: string): boolean {
  const form = getForm(db, requestID);
  if (!form) return false;
  answerForm(db, requestID, answer);
  resolveFormWaiter(requestID, answer);
  return true;
}

export function waitForFormAnswer(db: Database, requestID: string, signal: AbortSignal): Promise<string | null> {
  const form = getForm(db, requestID);
  if (!form) return Promise.resolve(null);
  if (form.status === "answered" && form.answer) return Promise.resolve(form.answer);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (answer: string | null): void => {
      formWaiters.delete(requestID);
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = (): void => finish(null);
    formWaiters.set(requestID, (answer) => finish(answer));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the update-before-registration race by reading the row again.
    const latest = getForm(db, requestID);
    if (latest?.status === "answered" && latest.answer) finish(latest.answer);
  });
}

export interface FormRequestSpec {
  threadID: string;
  turnID: string | null;
  kind: FormKind;
  question: string;
  options?: string[];
  multiple?: boolean;
  email?: FormEmail;
}

export interface FormBrokerDeps {
  db: Database;
  emit: (body: ServerFrameBody) => void;
  /**
   * Called while the turn waits on the owner's answer; the returned function
   * ends the wait. The turn uses it to stop its clock: the owner's time is
   * not the model's.
   */
  hold?: () => () => void;
  /** The longest the owner is waited for (default 10 minutes); then the form expires. */
  ownerWaitMs?: number;
}

export class FormBroker {
  constructor(private readonly deps: FormBrokerDeps) {}

  /** Puts the question to the owner and waits for the answer. */
  async request(spec: FormRequestSpec, signal: AbortSignal): Promise<string | null> {
    // Everything the model wrote that the owner will read is cleaned first, so
    // the card, its replay after a reconnect and the stored row agree.
    const form = createForm(this.deps.db, {
      threadID: spec.threadID,
      turnID: spec.turnID,
      kind: spec.kind,
      question: multiLine(spec.question),
      options: spec.options?.map((option) => entry(option, 200)),
      multiple: spec.multiple,
      email: spec.email && {
        ...(spec.email.from === undefined ? {} : { from: entry(spec.email.from) }),
        to: entry(spec.email.to),
        subject: entry(spec.email.subject, 300),
        body: multiLine(spec.email.body),
      },
    });
    this.deps.emit({
      type: "form.request",
      requestID: form.id,
      question: form.question,
      options: form.options.length > 0 ? form.options : undefined,
      multiple: form.multiple,
      kind: form.kind,
      email: form.email ?? undefined,
    });
    const release = this.deps.hold?.();
    const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(this.deps.ownerWaitMs ?? OWNER_WAIT_CEILING_MS)]);
    try {
      const answer = await waitForFormAnswer(this.deps.db, form.id, waitSignal);
      // Nobody answered in time (the turn itself was not stopped): the card is dead.
      if (answer === null && !signal.aborted && waitSignal.aborted) expireCard(this.deps.db, "form", form.id, "expired", this.deps.emit);
      return answer;
    } finally {
      release?.();
    }
  }
}
