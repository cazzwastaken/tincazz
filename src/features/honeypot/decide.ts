export interface AuthorFacts {
  isBot: boolean;
  isWebhook: boolean;
  isSystem: boolean;
  isSelf: boolean;
  isStaff: boolean;
  isOwner: boolean;
}

export type AuthorDecision = 'ignore' | 'softban';

/** Exempt authors are left alone; everyone else who posts in the honeypot is softbanned. */
export function classifyAuthor(facts: AuthorFacts): AuthorDecision {
  return Object.values(facts).some(Boolean) ? 'ignore' : 'softban';
}
