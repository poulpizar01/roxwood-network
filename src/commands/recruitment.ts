import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { setRecruitmentOpen } from "../services/guildConfigService.js";

/**
 * `/recruitment` : commande d'administration (reservee `ManageGuild`) pour l'etat global
 * du programme de recrutement sur ce serveur. Ne pas confondre avec le statut d'une
 * candidature individuelle (En attente/Entretien/Accepte/Refuse), pilote par les boutons
 * "Statut" sur le message de suivi (voir `interactionCreate.ts`) — ici c'est un interrupteur
 * unique pour toute la guilde : ferme, les nouveaux tickets RECRUITMENT affichent un message
 * "fermé" au lieu du bouton de formulaire (les candidatures deja en cours ne sont pas affectees).
 */
export const recruitmentCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("recruitment")
    .setDescription("Gérer l'état des recrutements pour ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Ouvrir ou fermer les recrutements")
        .addStringOption((opt) =>
          opt
            .setName("etat")
            .setDescription("Nouvel état")
            .setRequired(true)
            .addChoices({ name: "Ouvert", value: "OPEN" }, { name: "Fermé", value: "CLOSED" })
        )
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const etat = interaction.options.getString("etat", true) as "OPEN" | "CLOSED";
      const open = etat === "OPEN";
      await setRecruitmentOpen(interaction.guildId, open);
      await interaction.reply({
        content: open
          ? "Recrutements ouverts : les nouveaux tickets affichent le formulaire de candidature."
          : "Recrutements fermés : les nouveaux tickets afficheront un message \"fermé\" au lieu du formulaire.",
        ephemeral: true,
      });
    }
  },
};
