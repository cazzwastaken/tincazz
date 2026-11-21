export interface AuthorFacts {
  isBot: boolean;
  isWebhook: boolean;
  isSystem: boolean;
  isSelf: boolean;
  isStaff: boolean;
  isOwner: boolean;
}

export type AuthorDecision = 'ignore' | 'notify' | 'softban';

/** Notify exempt people, but ignore automated messages entirely. */
export function classifyAuthor(facts: AuthorFacts): AuthorDecision {
  if (facts.isBot || facts.isWebhook || facts.isSystem || facts.isSelf) return 'ignore';
  return facts.isStaff || facts.isOwner ? 'notify' : 'softban';
}
