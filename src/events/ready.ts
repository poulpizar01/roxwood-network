import { REST, Routes, type Client } from "discord.js";
import { env } from "../config/env.js";
import { commands } from "../commands/index.js";
import { startEscalationJob } from "../services/escalationService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler `ClientReady`, declenche une seule fois quand le bot est connecte a la gateway.
 * Enregistre les commandes slash aupres de l'API Discord, puis demarre le job d'escalade.
 *
 * L'enregistrement se fait soit sur une seule guilde de dev (`DEV_GUILD_ID`, propagation
 * instantanee — pratique en developpement), soit globalement (propagation jusqu'a ~1h,
 * a utiliser en production). Un echec d'enregistrement est logge mais ne bloque pas le
 * demarrage : le bot reste fonctionnel pour tout ce qui ne depend pas des commandes slash.
 */
export async function onReady(readyClient: Client<true>): Promise<void> {
  logger.info(`Connecte en tant que ${readyClient.user.tag}`);

  const rest = new REST().setToken(env.DISCORD_TOKEN);
  const body = commands.map((c) => c.data.toJSON());

  try {
    if (env.DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.DEV_GUILD_ID), { body });
      logger.info(`Commandes slash enregistrees sur la guilde de dev ${env.DEV_GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(env.CLIENT_ID), { body });
      logger.info("Commandes slash enregistrees globalement (peut prendre jusqu'a 1h)");
    }
  } catch (error) {
    logger.error("Echec de l'enregistrement des commandes slash", error);
  }

  startEscalationJob(readyClient);
}
