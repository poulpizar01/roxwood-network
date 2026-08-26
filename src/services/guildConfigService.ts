import type { GuildConfig } from "@prisma/client";
import { prisma } from "../db/prisma.js";

const cache = new Map<string, GuildConfig>();

export async function getGuildConfig(guildId: string): Promise<GuildConfig | null> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const config = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (config) cache.set(guildId, config);
  return config;
}

async function ensureGuildConfig(guildId: string): Promise<GuildConfig> {
  const existing = await getGuildConfig(guildId);
  if (existing) return existing;

  const created = await prisma.guildConfig.create({
    data: { guildId, ticketCategoryIds: [], staffRoleIds: [] },
  });
  cache.set(guildId, created);
  return created;
}

function invalidate(guildId: string, updated: GuildConfig) {
  cache.set(guildId, updated);
}

export async function addTicketCategory(guildId: string, categoryId: string): Promise<GuildConfig> {
  const config = await ensureGuildConfig(guildId);
  if (config.ticketCategoryIds.includes(categoryId)) return config;

  const updated = await prisma.guildConfig.update({
    where: { guildId },
    data: { ticketCategoryIds: { push: categoryId } },
  });
  invalidate(guildId, updated);
  return updated;
}

export async function addStaffRole(guildId: string, roleId: string): Promise<GuildConfig> {
  const config = await ensureGuildConfig(guildId);
  if (config.staffRoleIds.includes(roleId)) return config;

  const updated = await prisma.guildConfig.update({
    where: { guildId },
    data: { staffRoleIds: { push: roleId } },
  });
  invalidate(guildId, updated);
  return updated;
}

export async function setEscalationMinutes(guildId: string, minutes: number | null): Promise<GuildConfig> {
  await ensureGuildConfig(guildId);
  const updated = await prisma.guildConfig.update({
    where: { guildId },
    data: { escalationMinutes: minutes },
  });
  invalidate(guildId, updated);
  return updated;
}

export function isTicketCategory(config: GuildConfig | null, categoryId: string | null): boolean {
  if (!config || !categoryId) return false;
  return config.ticketCategoryIds.includes(categoryId);
}

export function isStaffMember(config: GuildConfig | null, memberRoleIds: string[]): boolean {
  if (!config) return false;
  return config.staffRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}
