import cron from "node-cron";
import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

/**
 * Job planifie qui ping le staff sur les tickets restes trop longtemps sans reponse.
 * Ne fait rien pour les guildes qui n'ont pas configure `escalationMinutes` (voir
 * `guildConfigService.setEscalationMinutes`).
 */

/**
 * Parcourt toutes les guildes ayant une escalade active et, pour chacune, escalade
 * (ping + marque `escalatedAt`) les tickets ouverts sans reponse staff depuis plus
 * longtemps que le seuil configure. `escalatedAt` deja renseigne = deja escalade,
 * on ne ping donc jamais deux fois le meme ticket.
 */
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

/**
 * Demarre le job d'escalade (verification toutes les 5 minutes). A appeler une seule fois
 * au demarrage du bot (voir `onReady`), en lui passant le client Discord deja connecte
 * (necessaire pour recuperer les canaux et y poster les pings).
 */
export function startEscalationJob(client: Client): void {
  // toutes les 5 minutes
  cron.schedule("*/5 * * * *", () => {
    checkStaleTickets(client).catch((error) => logger.error("Erreur job d'escalade", error));
  });
  logger.info("Job d'escalade demarre (toutes les 5 min)");
}
