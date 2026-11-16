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
