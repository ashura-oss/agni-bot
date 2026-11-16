import type { Database } from "bun:sqlite";

export function positive(db: Database, completion: { content: string }): void {
  const edit = JSON.parse(completion.content) as { id: string; title: string };
  // ruleid: agni-model-json-into-sql
  db.run(`UPDATE threads SET title = '${edit.title}' WHERE id = '${edit.id}'`);
}

export function positiveViaToolArguments(db: Database, toolCall: { arguments: string }): void {
  const args = JSON.parse(toolCall.arguments) as { table: string };
  // ruleid: agni-model-json-into-sql
  db.exec("DELETE FROM " + args.table);
}

export function negativeBound(db: Database, completion: { content: string }): void {
  const edit = JSON.parse(completion.content) as { id: string; title: string };
  // ok: agni-model-json-into-sql
  db.run("UPDATE threads SET title = ? WHERE id = ?", [edit.title, edit.id]);
}

export function negativeNumeric(db: Database, completion: { content: string }): void {
  const edit = JSON.parse(completion.content) as { limit: string };
  // ok: agni-model-json-into-sql
  db.run(`DELETE FROM jobs LIMIT ${Number(edit.limit)}`);
}

export function negativeNotModelOutput(db: Database, version: string): void {
  const pinned = JSON.parse(version) as { n: number };
  // ok: agni-model-json-into-sql
  db.run(`PRAGMA user_version = ${pinned.n}`);
}

export function negativePlaceholders(db: Database, completion: { content: string }): void {
  const ids = JSON.parse(completion.content) as string[];
  const marks = ids.map(() => "?").join(",");
  // ok: agni-model-json-into-sql
  db.run(`DELETE FROM jobs WHERE id IN (${marks})`, ids);
}

declare const sharedDb: Database;

/** The arguments a tool handler receives were chosen by the model. */
export const positiveToolHandlerArgs = {
  name: "purge",
  handler: async (args: { table: string }) => {
    // ruleid: agni-model-json-into-sql
    sharedDb.exec(`DELETE FROM ${args.table}`);
    return { ok: true };
  },
};

export const positiveToolHandlerWithContext = {
  name: "rename",
  handler: async (args: Record<string, unknown>, ctx: { threadID: string }) => {
    // ruleid: agni-model-json-into-sql
    sharedDb.run("UPDATE threads SET title = '" + String(args.title) + "' WHERE id = ?", [ctx.threadID]);
    return { ok: true };
  },
};

export function positiveStoredToolCallArgs(db: Database, call: { args: string }): void {
  const parsed = JSON.parse(call.args) as { column: string };
  // ruleid: agni-model-json-into-sql
  db.query(`SELECT ${parsed.column} FROM tool_calls`).all();
}

export const negativeToolHandlerBound = {
  name: "rename",
  handler: async (args: { id: string; title: string }) => {
    // ok: agni-model-json-into-sql
    sharedDb.run("UPDATE threads SET title = ? WHERE id = ?", [args.title, args.id]);
    return { ok: true };
  },
};

export const negativeToolHandlerNumeric = {
  name: "trim",
  handler: async (args: { keep: string }) => {
    // ok: agni-model-json-into-sql
    sharedDb.run(`DELETE FROM jobs WHERE n > ${Number(args.keep)}`);
    return { ok: true };
  },
};
