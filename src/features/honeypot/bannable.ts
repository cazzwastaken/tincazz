export interface BanFacts {
  botCanBan: boolean;
  targetIsOwner: boolean;
  /** undefined when the target is not a member (already left). */
  targetHighest?: number;
  botHighest: number;
}

export const banProblems = {
  noPermission: 'I lack Ban Members',
  owner: 'they own the server',
  hierarchy: 'their highest role is at or above mine',
} as const;

export function banProblem(facts: BanFacts): string | undefined {
  if (!facts.botCanBan) return banProblems.noPermission;
  if (facts.targetIsOwner) return banProblems.owner;
  if (facts.targetHighest !== undefined && facts.targetHighest >= facts.botHighest) {
    return banProblems.hierarchy;
  }
  return undefined;
}
