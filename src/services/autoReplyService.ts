import { prisma } from "../db/prisma.js";

export interface AutoReplyMatcher {
  match(guildId: string, messageContent: string): Promise<string | null>;
}

/** Compare le message a chaque regle mot-cle active de la guilde (recherche simple, insensible a la casse). */
export const keywordMatcher: AutoReplyMatcher = {
  async match(guildId, messageContent) {
    const rules = await prisma.autoReplyRule.findMany({ where: { guildId, enabled: true } });
    const normalized = messageContent.toLowerCase();

    const rule = rules.find((r) => normalized.includes(r.trigger.toLowerCase()));
    return rule?.response ?? null;
  },
};

// Point d'extension : ajouter un matcher IA ici (ex: AiMatcher) et le pousser dans ce tableau.
// Le premier matcher a repondre gagne.
const matchers: AutoReplyMatcher[] = [keywordMatcher];

export async function findAutoReply(guildId: string, messageContent: string): Promise<string | null> {
  for (const matcher of matchers) {
    const response = await matcher.match(guildId, messageContent);
    if (response) return response;
  }
  return null;
}
