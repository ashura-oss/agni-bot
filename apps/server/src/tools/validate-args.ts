/**
 * Argument validation for tool calls: a small checker for the JSON-schema
 * subset the tools declare (type, required, properties, enum, minimum,
 * maximum, minLength, maxLength, minItems, maxItems, items, and
 * `format: "uri"`). Anything outside that subset is ignored rather than
 * guessed at, so a plugin's richer schema (oneOf, $ref, patterns) never
 * rejects a call this checker does not understand.
 *
 * The model writes the arguments, so a failure is a message the model can
 * act on: it names the field and the rule it broke.
 */

type Schema = Record<string, unknown>;

export type NormalizedArgs =
  | { ok: true; args: unknown; notes: string[] }
  | { ok: false; error: string };

/**
 * Repair what the models routinely send, then check the result. The handlers
 * always tolerated these, so refusing them would break calls that worked:
 *   - null for an optional field means "not given" (the field is dropped);
 *   - a numeric string where a number is wanted becomes the number;
 *   - a size-like number (`CLAMPED_FIELDS`) outside minimum/maximum is clamped
 *     to the bound (a note says so); any other out-of-range number is refused;
 *   - one string where an array of strings is wanted becomes a one-item array.
 * A missing or null required field, a value of the wrong type that cannot be
 * repaired, an enum miss and a length breach are still refused.
 */
export function normalizeArgs(schema: unknown, args: unknown): NormalizedArgs {
  const notes: string[] = [];
  const root = isRecord(schema) ? schema : {};
  const repaired = repair(root, args === undefined ? {} : args, "", notes);
  const problem = check(root, repaired, "", true);
  return problem ? { ok: false, error: `invalid arguments: ${problem}` } : { ok: true, args: repaired, notes };
}

/** Null when `args` are acceptable (after repair); otherwise one sentence naming the first problem. */
export function validateArgs(schema: unknown, args: unknown): string | null {
  const result = normalizeArgs(schema, args);
  return result.ok ? null : result.error;
}

/**
 * The only fields whose out-of-range numbers are clamped: knobs for how much
 * to return or how long to wait, where "the most allowed" is what the caller
 * meant. Any other number out of range is refused: moving an id, a score or an
 * offset to the nearest bound would run something the model never asked for.
 */
export const CLAMPED_FIELDS = new Set([
  "limit", "count", "maxResults", "maxChars", "max", "topK", "depth", "timeoutMs", "pageSize", "perPage", "maxItems", "maxTokens",
]);
const NUMERIC = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function repair(schema: Schema, value: unknown, path: string, notes: string[]): unknown {
  const types = typeList(schema.type);
  if (typeof value === "string" && types && !types.includes("string") && (types.includes("number") || types.includes("integer"))) {
    const text = value.trim();
    if (NUMERIC.test(text)) value = Number(text);
  }
  const field = path.replace(/\[\d+\]$/, "").split(".").pop() ?? "";
  if (CLAMPED_FIELDS.has(field) && typeof value === "number" && Number.isFinite(value) && types && (types.includes("number") || (types.includes("integer") && Number.isInteger(value)))) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      notes.push(`"${path}" was ${value}; used the minimum, ${schema.minimum}`);
      return schema.minimum;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      notes.push(`"${path}" was ${value}; used the maximum, ${schema.maximum}`);
      return schema.maximum;
    }
  }
  if (typeof value === "string" && types?.includes("array") && !types.includes("string") && isRecord(schema.items) && schema.items.type === "string") {
    return [value];
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    return value.map((item, index) => repair(schema.items as Schema, item, `${path}[${index}]`, notes));
  }
  if (isRecord(value) && !Array.isArray(value) && isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const copy: Record<string, unknown> = { ...value };
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (!(name in copy) || !isRecord(propertySchema)) continue;
      if (copy[name] === null && !required.includes(name) && !allowsNull(propertySchema)) {
        delete copy[name];
        continue;
      }
      copy[name] = repair(propertySchema, copy[name], join(path, name), notes);
    }
    return copy;
  }
  return value;
}

function allowsNull(schema: Schema): boolean {
  return typeList(schema.type)?.includes("null") ?? false;
}

function check(schema: Schema, value: unknown, path: string, root = false): string | null {
  const label = root ? "arguments" : `"${path}"`;
  const types = typeList(schema.type);
  if (types && !types.some((type) => matchesType(type, value))) {
    return `${label} must be ${describeTypes(types)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value))) {
    return `${label} must be one of: ${schema.enum.map(String).join(", ")}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${label} must be at least ${schema.minimum} (got ${value})`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${label} must be at most ${schema.maximum} (got ${value})`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${label} must be at least ${schema.minLength} characters (got ${value.length})`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${label} must be at most ${schema.maxLength} characters (got ${value.length})`;
    if (schema.format === "uri" && !isURI(value)) return `${label} must be a valid URI`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${label} must have at least ${schema.minItems} items (got ${value.length})`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${label} must have at most ${schema.maxItems} items (got ${value.length})`;
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const problem = check(schema.items, value[index], `${path}[${index}]`);
        if (problem) return problem;
      }
    }
  }
  if (isRecord(value) && !Array.isArray(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name !== "string") continue;
        const given = value[name];
        const spec = properties[name];
        if (given === undefined || (given === null && !(isRecord(spec) && allowsNull(spec)))) return `"${join(path, name)}" is required`;
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (value[name] === undefined || !isRecord(propertySchema)) continue;
      const problem = check(propertySchema, value[name], join(path, name));
      if (problem) return problem;
    }
  }
  return null;
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

function isRecord(value: unknown): value is Schema {
  return typeof value === "object" && value !== null;
}

function typeList(type: unknown): string[] | null {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.every((entry) => typeof entry === "string")) return type as string[];
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value) && !Array.isArray(value);
    case "null": return value === null;
    default: return true; // a type this checker does not know is not a reason to refuse
  }
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string", integer: "an integer", number: "a number", boolean: "a boolean", array: "an array", object: "an object", null: "null",
};

function describeTypes(types: string[]): string {
  return types.map((type) => TYPE_NAMES[type] ?? type).join(" or ");
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (isRecord(a) && isRecord(b) && JSON.stringify(a) === JSON.stringify(b));
}

function isURI(value: string): boolean {
  try { new URL(value); return true; } catch { return false; }
}
