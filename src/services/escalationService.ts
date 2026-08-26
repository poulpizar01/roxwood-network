import cron from "node-cron";
import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

async function checkStaleTickets(client: Client): Promise<void> {
  const configs = await prisma.guildConfig.findMany({
    where: { escalationMinutes: { not: null } },
  });

  for (const config of configs) {
    if (!config.escalationMinutes) continue;

    const threshold = new Date(Date.now() - config.escalationMinutes * 60_000);

    const staleTickets = await prisma.ticket.findMany({
      where: {
        guildId: config.guildId,
        status: "OPEN",
        firstStaffReplyAt: null,
        escalatedAt: null,
        lastActivityAt: { lt: threshold },
      },
    });

    for (const ticket of staleTickets) {
      try {
        const channel = await client.channels.fetch(ticket.channelId);
        if (!channel || channel.type !== ChannelType.GuildText) continue;

        const mentions = config.staffRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
        if (mentions) {
          await channel.send(`⚠️ Ticket sans reponse depuis plus de ${config.escalationMinutes} min. ${mentions}`);
        }

        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { escalatedAt: new Date() },
        });

        await dispatchWebhook(config.guildId, "ticket.escalated", {
          ticketId: ticket.id,
          channelId: ticket.channelId,
        });
      } catch (error) {
        logger.error(`Echec escalade du ticket ${ticket.channelId}`, error);
      }
    }
  }
}

export function startEscalationJob(client: Client): void {
  // toutes les 5 minutes
  cron.schedule("*/5 * * * *", () => {
    checkStaleTickets(client).catch((error) => logger.error("Erreur job d'escalade", error));
  });
  logger.info("Job d'escalade demarre (toutes les 5 min)");
}
