import type { NonThreadGuildBasedChannel, PermissionOverwrites } from "discord.js";
import type { Ticket, TicketType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

function guessOpenerId(channel: NonThreadGuildBasedChannel): string | null {
  const botUserId = channel.client.user?.id;
  const overwrites = [...channel.permissionOverwrites.cache.values()] as PermissionOverwrites[];
  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id !== botUserId);
  return memberOverwrite?.id ?? null;
}

export async function trackTicketChannel(
  channel: NonThreadGuildBasedChannel,
  categoryId: string,
  type: TicketType
): Promise<Ticket | null> {
  const existing = await prisma.ticket.findUnique({ where: { channelId: channel.id } });
  if (existing) return null;

  const ticket = await prisma.ticket.create({
    data: {
      guildId: channel.guildId,
      channelId: channel.id,
      categoryId,
      type,
      openerId: guessOpenerId(channel),
    },
  });

  logger.info(`Nouveau ticket suivi (${type}) : ${channel.id} (guild ${channel.guildId})`);

  await dispatchWebhook(channel.guildId, "ticket.created", {
    ticketId: ticket.id,
    channelId: ticket.channelId,
    openerId: ticket.openerId,
    type: ticket.type,
  });

  return ticket;
}

export async function markTicketClosed(channelId: string, guildId: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { channelId } });
  if (!ticket || ticket.status === "CLOSED") return;

  await prisma.ticket.update({
    where: { channelId },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  logger.info(`Ticket ferme : ${channelId} (guild ${guildId})`);

  await dispatchWebhook(guildId, "ticket.closed", { ticketId: ticket.id, channelId });
}

export async function recordActivity(channelId: string): Promise<void> {
  await prisma.ticket.updateMany({
    where: { channelId },
    data: { lastActivityAt: new Date() },
  });
}

export async function recordFirstStaffReply(channelId: string): Promise<void> {
  await prisma.ticket.updateMany({
    where: { channelId, firstStaffReplyAt: null },
    data: { firstStaffReplyAt: new Date() },
  });
}

export async function getTicketByChannel(channelId: string) {
  return prisma.ticket.findUnique({
    where: { channelId },
    include: { tags: true },
  });
}
