import type { GuildConfig, TicketCategoryConfig, TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";

type GuildConfigWithCategories = GuildConfig & { ticketCategories: TicketCategoryConfig[] };

const cache = new Map<string, GuildConfigWithCategories>();

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

async function refresh(guildId: string): Promise<GuildConfigWithCategories> {
  const config = await prisma.guildConfig.findUniqueOrThrow({
    where: { guildId },
    include: { ticketCategories: true },
  });
  cache.set(guildId, config);
  return config;
}

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

export async function addStaffRole(guildId: string, roleId: string): Promise<GuildConfigWithCategories> {
  const config = await ensureGuildConfig(guildId);
  if (config.staffRoleIds.includes(roleId)) return config;

  await prisma.guildConfig.update({
    where: { guildId },
    data: { staffRoleIds: { push: roleId } },
  });
  return refresh(guildId);
}

export async function setEscalationMinutes(guildId: string, minutes: number | null): Promise<GuildConfigWithCategories> {
  await ensureGuildConfig(guildId);
  await prisma.guildConfig.update({
    where: { guildId },
    data: { escalationMinutes: minutes },
  });
  return refresh(guildId);
}

export function getCategoryType(
  config: GuildConfigWithCategories | null,
  categoryId: string | null
): TicketType | null {
  if (!config || !categoryId) return null;
  return config.ticketCategories.find((c) => c.categoryId === categoryId)?.type ?? null;
}

export function isStaffMember(config: GuildConfig | null, memberRoleIds: string[]): boolean {
  if (!config) return false;
  return config.staffRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}
