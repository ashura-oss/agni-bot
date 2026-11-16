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

/** Null when `args` satisfy `schema`; otherwise one sentence naming the first problem. */
export function validateArgs(schema: unknown, args: unknown): string | null {
  const problem = check(isRecord(schema) ? schema : {}, args === undefined ? {} : args, "", true);
  return problem ? `invalid arguments: ${problem}` : null;
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
        if (typeof name === "string" && value[name] === undefined) return `"${join(path, name)}" is required`;
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
