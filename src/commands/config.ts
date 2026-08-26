import { PermissionFlagsBits, SlashCommandBuilder, ChannelType } from "discord.js";
import type { Command } from "./types.js";
import { addTicketCategory, addStaffRole, setEscalationMinutes } from "../services/guildConfigService.js";

export const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configurer la sur-couche de tickets pour ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("set-ticket-category")
        .setDescription("Ajouter une categorie surveillee comme categorie de tickets")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Categorie Discord utilisee par Ticket Tool")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-staff-role")
        .setDescription("Ajouter un role considere comme staff de support")
        .addRoleOption((opt) => opt.setName("role").setDescription("Role staff").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-escalation-timeout")
        .setDescription("Delai (minutes) avant escalade d'un ticket sans reponse staff")
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("0 pour desactiver l'escalade")
            .setMinValue(0)
            .setRequired(true)
        )
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "set-ticket-category") {
      const category = interaction.options.getChannel("category", true);
      await addTicketCategory(interaction.guildId, category.id);
      await interaction.reply({ content: `Categorie de tickets ajoutee : <#${category.id}>`, ephemeral: true });
      return;
    }

    if (sub === "set-staff-role") {
      const role = interaction.options.getRole("role", true);
      await addStaffRole(interaction.guildId, role.id);
      await interaction.reply({ content: `Role staff ajoute : <@&${role.id}>`, ephemeral: true });
      return;
    }

    if (sub === "set-escalation-timeout") {
      const minutes = interaction.options.getInteger("minutes", true);
      await setEscalationMinutes(interaction.guildId, minutes === 0 ? null : minutes);
      await interaction.reply({
        content: minutes === 0 ? "Escalade desactivee." : `Escalade fixee a ${minutes} min sans reponse staff.`,
        ephemeral: true,
      });
    }
  },
};
