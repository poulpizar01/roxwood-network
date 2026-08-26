import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { getTicketByChannel } from "../services/ticketService.js";
import { setStatus, assignRecruiter } from "../services/recruitmentService.js";

/** Etapes du pipeline de recrutement, dans l'ordre attendu (voir enum Prisma `ApplicationStatus`). */
const STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "Entretien", value: "INTERVIEW" },
  { name: "Accepte", value: "ACCEPTED" },
  { name: "Refuse", value: "REJECTED" },
] as const;

/**
 * `/recruitment` : commande staff pour piloter le pipeline d'une candidature (avancer son
 * statut, se l'assigner). Utilisable uniquement dans le salon d'un ticket de type RECRUITMENT
 * — c'est le ticket courant qui determine implicitement de quelle candidature il s'agit,
 * pas d'identifiant a fournir en parametre.
 */
export const recruitmentCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("recruitment")
    .setDescription("Gerer la candidature du ticket courant")
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Changer l'etape de la candidature")
        .addStringOption((opt) =>
          opt.setName("etape").setDescription("Nouvelle etape").setRequired(true).addChoices(...STATUS_CHOICES)
        )
    )
    .addSubcommand((sub) => sub.setName("claim").setDescription("S'assigner cette candidature")) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const ticket = await getTicketByChannel(interaction.channelId);
    if (!ticket || ticket.type !== "RECRUITMENT") {
      await interaction.reply({ content: "Ce salon n'est pas rattache a une candidature.", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const etape = interaction.options.getString("etape", true) as (typeof STATUS_CHOICES)[number]["value"];
      await setStatus(ticket.id, etape);
      const label = STATUS_CHOICES.find((c) => c.value === etape)?.name ?? etape;
      await interaction.reply(`Candidature mise a jour : **${label}**`);
      return;
    }

    if (sub === "claim") {
      await assignRecruiter(ticket.id, interaction.user.id);
      await interaction.reply(`Candidature assignee a <@${interaction.user.id}>`);
    }
  },
};
