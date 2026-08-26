import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import type { Command } from "./types.js";
import { prisma } from "../db/prisma.js";
import { getTicketByChannel } from "../services/ticketService.js";

const PRIORITY_CHOICES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

async function buildTicketSummary(channelId: string) {
  const ticket = await getTicketByChannel(channelId);
  if (!ticket) return null;

  return new EmbedBuilder()
    .setTitle("Ticket")
    .addFields(
      { name: "Statut", value: ticket.status, inline: true },
      { name: "Priorite", value: ticket.priority, inline: true },
      { name: "Ouvert par", value: ticket.openerId ? `<@${ticket.openerId}>` : "inconnu", inline: true },
      { name: "Tags", value: ticket.tags.length ? ticket.tags.map((t) => t.tag).join(", ") : "aucun" },
      {
        name: "1ere reponse staff",
        value: ticket.firstStaffReplyAt ? `<t:${Math.floor(ticket.firstStaffReplyAt.getTime() / 1000)}:R>` : "en attente",
      }
    )
    .setColor(0x5865f2);
}

export const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Gerer le ticket courant")
    .addSubcommand((sub) => sub.setName("info").setDescription("Afficher le statut du ticket courant"))
    .addSubcommand((sub) =>
      sub
        .setName("priority")
        .setDescription("Definir la priorite du ticket courant")
        .addStringOption((opt) =>
          opt
            .setName("level")
            .setDescription("Niveau de priorite")
            .setRequired(true)
            .addChoices(...PRIORITY_CHOICES.map((p) => ({ name: p, value: p })))
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("tag")
        .setDescription("Gerer les tags du ticket courant")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Ajouter un tag")
            .addStringOption((opt) => opt.setName("tag").setDescription("Nom du tag").setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Retirer un tag")
            .addStringOption((opt) => opt.setName("tag").setDescription("Nom du tag").setRequired(true))
        )
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const ticket = await getTicketByChannel(interaction.channelId);
    if (!ticket) {
      await interaction.reply({ content: "Ce canal n'est pas suivi comme ticket.", ephemeral: true });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group && sub === "info") {
      const embed = await buildTicketSummary(interaction.channelId);
      await interaction.reply({ embeds: embed ? [embed] : [] });
      return;
    }

    if (!group && sub === "priority") {
      const level = interaction.options.getString("level", true) as (typeof PRIORITY_CHOICES)[number];
      await prisma.ticket.update({ where: { id: ticket.id }, data: { priority: level } });
      await interaction.reply(`Priorite mise a jour : **${level}**`);
      return;
    }

    if (group === "tag") {
      const tagName = interaction.options.getString("tag", true).toLowerCase().trim();

      if (sub === "add") {
        await prisma.ticketTag.upsert({
          where: { ticketId_tag: { ticketId: ticket.id, tag: tagName } },
          create: { ticketId: ticket.id, tag: tagName },
          update: {},
        });
        await interaction.reply(`Tag ajoute : \`${tagName}\``);
        return;
      }

      if (sub === "remove") {
        await prisma.ticketTag.deleteMany({ where: { ticketId: ticket.id, tag: tagName } });
        await interaction.reply(`Tag retire : \`${tagName}\``);
      }
    }
  },
};
