import type { GuildConfig, TicketCategoryConfig, TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Ce service centralise la lecture/ecriture de la configuration par serveur (`GuildConfig`)
 * et de son mapping categorie -> type de ticket (`TicketCategoryConfig`). Chaque fonction
 * est scopee par `guildId`, ce qui garantit l'isolation multi-serveur : le bot ne lit/ecrit
 * jamais que les donnees du serveur sur lequel l'evenement/la commande a eu lieu.
 */

/** GuildConfig avec ses categories de tickets deja chargees (evite un aller-retour DB supplementaire). */
type GuildConfigWithCategories = GuildConfig & { ticketCategories: TicketCategoryConfig[] };

/**
 * Cache memoire (process local) des configs par guilde, pour eviter une requete Postgres
 * a chaque evenement Discord (channelCreate, messageCreate...). Invalide/rafraichi explicitement
 * a chaque ecriture via `refresh()` — pas de TTL, la donnee change rarement (commandes de config).
 */
const cache = new Map<string, GuildConfigWithCategories>();

/**
 * Recupere la config d'une guilde (avec ses categories), en passant par le cache si possible.
 * Retourne `null` si la guilde n'a jamais ete configuree (aucune commande `/config` executee).
 */
export async function getGuildConfig(guildId: string): Promise<GuildConfigWithCategories | null> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const config = await prisma.guildConfig.findUnique({
    where: { guildId },
    include: { ticketCategories: true },
  });
  if (config) cache.set(guildId, config);
  return config;
}

/**
 * Retourne la config existante ou en cree une par defaut (staff/categories vides).
 * Utilise en interne par les fonctions d'ecriture ci-dessous, pour ne jamais echouer
 * sur une guilde configuree pour la premiere fois.
 */
async function ensureGuildConfig(guildId: string): Promise<GuildConfigWithCategories> {
  const existing = await getGuildConfig(guildId);
  if (existing) return existing;

  const created = await prisma.guildConfig.create({
    data: { guildId, staffRoleIds: [] },
    include: { ticketCategories: true },
  });
  cache.set(guildId, created);
  return created;
}

/** Recharge la config depuis Postgres et remet le cache a jour. A appeler apres toute ecriture. */
async function refresh(guildId: string): Promise<GuildConfigWithCategories> {
  const config = await prisma.guildConfig.findUniqueOrThrow({
    where: { guildId },
    include: { ticketCategories: true },
  });
  cache.set(guildId, config);
  return config;
}

/**
 * Associe (ou reassocie) une categorie Discord a un type de ticket pour cette guilde.
 * Upsert sur la paire (guildId, categoryId) : si la categorie etait deja mappee a un autre
 * type, le type est simplement remplace plutot que de creer un doublon.
 *
 * @param guildId - id de la guilde Discord
 * @param categoryId - id de la categorie Discord a surveiller
 * @param type - RECRUITMENT ou SERVICE
 */
export async function setTicketCategory(
  guildId: string,
  categoryId: string,
  type: TicketType
): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.ticketCategoryConfig.upsert({
    where: { guildId_categoryId: { guildId, categoryId } },
    create: { guildId, categoryId, type },
    update: { type },
  });
  return refresh(guildId);
}

/**
 * Ajoute un role a la liste des roles consideres comme "staff" pour cette guilde.
 * No-op si le role est deja present (pas de doublon dans le tableau `staffRoleIds`).
 */
export async function addStaffRole(guildId: string, roleId: string): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  if (config.staffRoleIds.includes(roleId)) return config;

  await prisma.guildConfig.update({
    where: { guildId },
    data: { staffRoleIds: { push: roleId } },
  });
  return refresh(guildId);
}

/**
 * Definit le delai (en minutes) d'inactivite staff avant escalade d'un ticket.
 * `null` desactive l'escalade pour cette guilde (voir `escalationService.ts`).
 */
export async function setEscalationMinutes(guildId: string, minutes: number | null): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { escalationMinutes: minutes },
  });
  return refresh(guildId);
}

/**
 * Determine le type de ticket associe a une categorie Discord donnee, a partir d'une config
 * deja chargee. Retourne `null` si la categorie n'est pas suivie (pas de config, pas d'id,
 * ou categorie non mappee) — dans ce cas le bot doit ignorer completement le canal.
 */
export function getCategoryType(
  config: GuildConfigWithCategories | null,
  categoryId: string | null
): TicketType | null {
  if (!config || !categoryId) return null;
  return config.ticketCategories.find((c) => c.categoryId === categoryId)?.type ?? null;
}

/** Indique si au moins un des roles donnes (typiquement ceux d'un membre) fait partie du staff de la guilde. */
export function isStaffMember(config: GuildConfig | null, memberRoleIds: string[]): boolean {
  if (!config) return false;
  return config.staffRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}
