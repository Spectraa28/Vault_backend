export interface PolicyStatement {
  id: string;
  effect: 'permit' | 'forbid' | 'require_approval';
  principal: { type: string; id: string };
  action: { type: string; eq?: string; in?: string[] };
  resource: { type: string; [key: string]: unknown };
  conditions: { field: string; op: string; value: unknown }[];
}
export interface PolicyProfile {
  schemaVersion: 'armor.policy.v1';
  kind: 'PolicyProfile';
  metadata: { name: string; description: string };
  defaults: { decision: 'allow' | 'deny' | 'hold'; conflictResolution: 'deny_overrides' };
  statements: PolicyStatement[];
}
export function validatePolicyIr(policy: unknown): { ok: boolean; errors: string[]; policy?: PolicyProfile };
export function evaluatePolicyIr(input: { policy: unknown; toolName: string; toolParams?: Record<string, unknown> }): { allowed: boolean; reason?: string; matchedRule?: PolicyStatement };
export function canonicalPolicyHash(policy: unknown): string;
