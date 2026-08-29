import { Prisma, type GuildConfig, type TicketCategoryConfig, type TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Ce service centralise la lecture/ecriture de la configuration par serveur (`GuildConfig`)
 * et de son mapping categorie -> type de ticket + roles de gestion (`TicketCategoryConfig`).
 * Chaque fonction est scopee par `guildId`, ce qui garantit l'isolation multi-serveur : le
 * bot ne lit/ecrit jamais que les donnees du serveur sur lequel l'evenement/la commande a eu lieu.
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
 * Retourne la config existante ou en cree une par defaut (categories vides).
 * Utilise en interne par les fonctions d'ecriture ci-dessous, pour ne jamais echouer
 * sur une guilde configuree pour la premiere fois.
 *
 * `upsert` plutot qu'un `findUnique` + `create` separes : deux commandes `/config`
 * lancees quasi simultanement sur une guilde jamais configuree verraient toutes les
 * deux "n'existe pas" avant que l'une des deux n'ait fini d'ecrire, et la seconde
 * `create()` echouerait alors sur la contrainte unique `guildId`. `upsert` reduit la
 * fenetre de course, mais l'`include` de relation force ici Prisma a retomber sur un
 * lire-puis-ecrire non atomique plutot qu'un `INSERT ... ON CONFLICT` natif — une vraie
 * collision (double clic, redelivrance d'une interaction par Discord) reste donc possible,
 * d'ou le catch ci-dessous : si on perd la course, la ligne existe deja, il suffit de la relire.
 */
async function ensureGuildConfig(guildId: string): Promise<GuildConfigWithCategories> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  try {
    const config = await prisma.guildConfig.upsert({
      where: { guildId },
      create: { guildId },
      update: {},
      include: { ticketCategories: true },
    });
    cache.set(guildId, config);
    return config;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return refresh(guildId);
    }
    throw error;
  }
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
 * Definit (ou redefinit) la categorie Discord associee a un type de ticket pour cette guilde.
 * Un seul type = une seule categorie a la fois (pas de sens metier a en avoir plusieurs) :
 * si une autre categorie etait deja mappee a ce type, son mapping est supprime et ses roles
 * de gestion sont repris sur la nouvelle categorie (le role gere le "type" de ticket, pas
 * la categorie Discord en tant que telle, qui n'est qu'un contenant).
 *
 * @param guildId - id de la guilde Discord
 * @param type - RECRUITMENT ou SERVICE
 * @param categoryId - id de la categorie Discord a surveiller pour ce type
 */
export async function setCategoryForType(
  guildId: string,
  type: TicketType,
  categoryId: string
): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const existingForType = config.ticketCategories.find((c) => c.type === type);

  if (existingForType && existingForType.categoryId !== categoryId) {
    await prisma.ticketCategoryConfig.delete({
      where: { guildId_categoryId: { guildId, categoryId: existingForType.categoryId } },
    });
  }

  await prisma.ticketCategoryConfig.upsert({
    where: { guildId_categoryId: { guildId, categoryId } },
    create: { guildId, categoryId, type, managerRoleIds: existingForType?.managerRoleIds ?? [] },
    update: { type },
  });
  return refresh(guildId);
}

/** Retire le mapping d'une categorie pour un type donne (elle redevient ignoree par le bot). */
export async function clearCategoryForType(guildId: string, type: TicketType): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const existing = config.ticketCategories.find((c) => c.type === type);
  if (existing) {
    await prisma.ticketCategoryConfig.delete({ where: { guildId_categoryId: { guildId, categoryId: existing.categoryId } } });
  }
  return refresh(guildId);
}

/**
 * Ajoute un role de gestion a une categorie de ticket. No-op si la categorie n'existe pas
 * (pas encore mappee) ou si le role est deja present.
 */
export async function addCategoryManagerRole(guildId: string, categoryId: string, roleId: string): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const category = config.ticketCategories.find((c) => c.categoryId === categoryId);
  if (!category || category.managerRoleIds.includes(roleId)) return config;

  await prisma.ticketCategoryConfig.update({
    where: { guildId_categoryId: { guildId, categoryId } },
    data: { managerRoleIds: { push: roleId } },
  });
  return refresh(guildId);
}

/** Retire un role de gestion d'une categorie de ticket. */
export async function removeCategoryManagerRole(guildId: string, categoryId: string, roleId: string): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  const category = config.ticketCategories.find((c) => c.categoryId === categoryId);
  if (!category) return config;

  await prisma.ticketCategoryConfig.update({
    where: { guildId_categoryId: { guildId, categoryId } },
    data: { managerRoleIds: category.managerRoleIds.filter((id) => id !== roleId) },
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
 * Definit le salon dedie au suivi des candidatures (recap + boutons Statut/S'assigner).
 * `null` revient au comportement par defaut (recap poste dans le salon du ticket).
 */
export async function setRecruitmentLogChannel(guildId: string, channelId: string | null): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentLogChannelId: channelId },
  });
  return refresh(guildId);
}

/**
 * Ouvre ou ferme les recrutements pour cette guilde. Fermer n'affecte que les nouveaux
 * tickets RECRUITMENT (`onChannelCreate` affiche un message "recrutements fermes" au lieu
 * du bouton de formulaire) — les candidatures deja en cours ne sont pas impactees.
 */
export async function setRecruitmentOpen(guildId: string, open: boolean): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { recruitmentOpen: open },
  });
  return refresh(guildId);
}

/** Definit le salon designe pour les messages permanents du panneau d'administration. */
export async function setPanelChannel(guildId: string, channelId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { panelChannelId: channelId },
  });
  return refresh(guildId);
}

/** Definit le role autorise a accepter/refuser les demandes d'absence. */
export async function setAbsenceApproverRole(guildId: string, roleId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { absenceApproverRoleId: roleId },
  });
  return refresh(guildId);
}

/** Definit le salon de suivi dedie aux demandes d'absence (separe du salon panneau). */
export async function setAbsenceReviewChannel(guildId: string, channelId: string): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { absenceReviewChannelId: channelId },
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

/**
 * Indique si au moins un des roles donnes (typiquement ceux d'un membre) fait partie des
 * roles de gestion de la categorie d'un ticket donne. Remplace l'ancien `isStaffMember`
 * (role staff global) : la gestion est desormais scopee par categorie de ticket, chaque
 * categorie ayant sa propre equipe.
 */
export function isTicketManager(
  config: GuildConfigWithCategories | null,
  categoryId: string,
  memberRoleIds: string[]
): boolean {
  if (!config) return false;
  const category = config.ticketCategories.find((c) => c.categoryId === categoryId);
  if (!category) return false;
  return category.managerRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}

/** Indique si un des roles donnes est le role approbateur des demandes d'absence de cette guilde. */
export function isAbsenceApprover(config: GuildConfigWithCategories | null, memberRoleIds: string[]): boolean {
  if (!config?.absenceApproverRoleId) return false;
  return memberRoleIds.includes(config.absenceApproverRoleId);
}
