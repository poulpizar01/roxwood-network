import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { prisma } from "../db/prisma.js";

/**
 * `/autoreply` : commande d'administration (reservee `ManageGuild`) pour gerer les regles
 * de reponse automatique par mot-cle (voir `autoReplyService.ts`), declenchees quand le
 * client ouvrant un ticket ecrit un message contenant le mot-cle configure.
 */
export const autoreplyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("autoreply")
    .setDescription("Gerer les regles de reponse automatique")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Ajouter une regle de reponse automatique")
        .addStringOption((opt) => opt.setName("trigger").setDescription("Mot-cle declencheur").setRequired(true))
        .addStringOption((opt) => opt.setName("response").setDescription("Reponse envoyee").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Supprimer une regle")
        .addStringOption((opt) => opt.setName("id").setDescription("Identifiant de la regle").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Lister les regles actives")) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const trigger = interaction.options.getString("trigger", true);
      const response = interaction.options.getString("response", true);
      const rule = await prisma.autoReplyRule.create({
        data: { guildId: interaction.guildId, trigger, response },
      });
      await interaction.reply({ content: `Regle creee (id: \`${rule.id}\`)`, ephemeral: true });
      return;
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id", true);
      await prisma.autoReplyRule.deleteMany({ where: { id, guildId: interaction.guildId } });
      await interaction.reply({ content: "Regle supprimee (si elle existait).", ephemeral: true });
      return;
    }

    if (sub === "list") {
      const rules = await prisma.autoReplyRule.findMany({ where: { guildId: interaction.guildId } });
      if (rules.length === 0) {
        await interaction.reply({ content: "Aucune regle configuree.", ephemeral: true });
        return;
      }
      const lines = rules.map((r) => `\`${r.id}\` [${r.enabled ? "on" : "off"}] "${r.trigger}" -> "${r.response}"`);
      await interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
    }
  },
};
