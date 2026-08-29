import { prisma } from "../db/prisma.js";

/**
 * Reponses automatiques par mot-cle dans les tickets (generique, independant des flux
 * Recrutement/Service). Concu comme un point d'extension : `AutoReplyMatcher` est une
 * interface pluggable, `keywordMatcher` en est la seule implementation fournie pour
 * l'instant ; un futur matcher IA (ex: appel a l'API Claude) pourrait etre ajoute sans
 * toucher au reste du code (event `messageCreate`, commandes `/autoreply`).
 */
export interface AutoReplyMatcher {
  /** Retourne la reponse a envoyer si le message matche une regle, sinon `null`. */
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

/** Liste les regles d'une guilde (pour le recapitulatif du panneau "FAQ"). */
export async function listRules(guildId: string) {
  return prisma.autoReplyRule.findMany({ where: { guildId }, orderBy: { createdAt: "asc" } });
}

/** Cree une regle de reponse automatique (active par defaut). */
export async function addRule(guildId: string, trigger: string, response: string) {
  return prisma.autoReplyRule.create({ data: { guildId, trigger, response } });
}

/** Supprime une regle. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeRule(guildId: string, id: string) {
  await prisma.autoReplyRule.deleteMany({ where: { id, guildId } });
}

/**
 * Essaie chaque matcher dans l'ordre et retourne la premiere reponse trouvee (ou `null`
 * si aucun matcher ne repond). Utilise par `onMessageCreate` pour repondre automatiquement
 * aux messages du client ouvrant le ticket.
 */
export async function findAutoReply(guildId: string, messageContent: string): Promise<string | null> {
  for (const matcher of matchers) {
    const response = await matcher.match(guildId, messageContent);
    if (response) return response;
  }
  return null;
}
