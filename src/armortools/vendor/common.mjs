// The two helpers policy-ir.mjs needs, copied unchanged from ArmorClaude's scripts/lib/common.mjs (MIT).
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}
