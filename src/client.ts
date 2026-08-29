import { Client, GatewayIntentBits, Partials } from "discord.js";

/**
 * Instance unique du client discord.js, configuree avec les intents/partials necessaires :
 * - `Guilds` : evenements de base (canaux, guildes) et enregistrement des commandes.
 * - `GuildMessages` + `MessageContent` : lire le contenu des messages (reponses auto, detection staff).
 * - `GuildMembers` : resoudre les roles d'un membre (staff, escalade) et son pseudo affiche (factures).
 * - `GuildMessageReactions` : reagir a la reaction "poubelle" sur les messages dedies du panneau
 *   (suppression manuelle, voir `messageReactionAdd.ts`).
 * Les `partials` Channel/Message/Reaction permettent de recevoir des evenements sur des objets non
 * entierement mis en cache (ex: message ou reaction plus vieux que le cache, notamment apres un
 * redemarrage) sans que discord.js les ignore silencieusement.
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});
