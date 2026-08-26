import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { prisma } from "../db/prisma.js";

export const statsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des tickets")
    .addSubcommand((sub) => sub.setName("overview").setDescription("Vue d'ensemble des tickets")) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const [open, closed, escalated] = await Promise.all([
      prisma.ticket.count({ where: { guildId: interaction.guildId, status: "OPEN" } }),
      prisma.ticket.count({ where: { guildId: interaction.guildId, status: "CLOSED" } }),
      prisma.ticket.count({ where: { guildId: interaction.guildId, escalatedAt: { not: null } } }),
    ]);

    const respondedTickets = await prisma.ticket.findMany({
      where: { guildId: interaction.guildId, firstStaffReplyAt: { not: null } },
      select: { createdAt: true, firstStaffReplyAt: true },
    });

    const avgResponseMinutes =
      respondedTickets.length > 0
        ? Math.round(
            respondedTickets.reduce(
              (sum, t) => sum + (t.firstStaffReplyAt!.getTime() - t.createdAt.getTime()) / 60_000,
              0
            ) / respondedTickets.length
          )
        : null;

    const embed = new EmbedBuilder()
      .setTitle("Statistiques des tickets")
      .addFields(
        { name: "Ouverts", value: String(open), inline: true },
        { name: "Fermes", value: String(closed), inline: true },
        { name: "Escalades", value: String(escalated), inline: true },
        {
          name: "Temps de reponse moyen (staff)",
          value: avgResponseMinutes !== null ? `${avgResponseMinutes} min` : "pas de donnees",
        }
      )
      .setColor(0x5865f2);

    await interaction.reply({ embeds: [embed] });
  },
};
