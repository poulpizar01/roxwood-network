import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder } from "discord.js";

/**
 * Contrat commun a toutes les commandes slash du bot (voir src/commands/*.ts).
 * `data` decrit la commande pour l'enregistrement aupres de l'API Discord (nom, description,
 * sous-commandes/options), `execute` contient la logique declenchee quand un utilisateur
 * l'invoque. Chaque fichier de commande exporte un objet conforme a cette interface, et
 * `src/commands/index.ts` les rassemble dans un registre unique.
 */
export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
