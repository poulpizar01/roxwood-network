import { PermissionFlagsBits, SlashCommandBuilder, ChannelType } from "discord.js";
import type { Command } from "./types.js";
import {
  setTicketCategory,
  addStaffRole,
  setEscalationMinutes,
  setRecruitmentLogChannel,
  setRecruitmentOpen,
} from "../services/guildConfigService.js";

/**
 * `/config` : commande d'administration (reservee `ManageGuild`) pour parametrer le bot sur
 * ce serveur — associer des categories a un type de ticket, definir le staff, regler l'escalade,
 * choisir le salon de suivi des candidatures, ouvrir/fermer les recrutements.
 * Toutes les sous-commandes ecrivent dans le `GuildConfig` de la guilde courante uniquement
 * (voir `guildConfigService.ts`).
 */
export const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configurer la sur-couche de tickets pour ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("add-category")
        .setDescription("Associer une catégorie Discord à un type de ticket (Recrutement ou Service)")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Catégorie Discord utilisée par Ticket Tool")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Type de ticket pour cette catégorie")
            .setRequired(true)
            .addChoices({ name: "Recrutement", value: "RECRUITMENT" }, { name: "Service", value: "SERVICE" })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-staff-role")
        .setDescription("Ajouter un rôle considéré comme staff de support")
        .addRoleOption((opt) => opt.setName("role").setDescription("Rôle staff").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-escalation-timeout")
        .setDescription("Délai (minutes) avant escalade d'un ticket sans réponse staff")
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("0 pour désactiver l'escalade")
            .setMinValue(0)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-recruitment-channel")
        .setDescription("Salon où poster le suivi des candidatures (récap + boutons Statut/S'assigner)")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Salon de suivi (laisser vide pour revenir au salon du ticket)")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-recruitment-open")
        .setDescription("Ouvrir ou fermer les recrutements (formulaire ou message \"fermé\" sur les nouveaux tickets)")
        .addBooleanOption((opt) => opt.setName("open").setDescription("true = ouvert, false = fermé").setRequired(true))
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    // Associe/reassocie une categorie a un type de ticket : c'est ce mapping que
    // `getCategoryType` consulte a chaque `channelCreate` pour decider si un canal
    // doit etre suivi comme ticket, et sous quel flux (recrutement ou service).
    if (sub === "add-category") {
      const category = interaction.options.getChannel("category", true);
      const type = interaction.options.getString("type", true) as "RECRUITMENT" | "SERVICE";
      await setTicketCategory(interaction.guildId, category.id, type);
      const typeLabel = type === "RECRUITMENT" ? "Recrutement" : "Service";
      await interaction.reply({ content: `Catégorie <#${category.id}> associée au type **${typeLabel}**.`, ephemeral: true });
      return;
    }

    if (sub === "set-staff-role") {
      const role = interaction.options.getRole("role", true);
      await addStaffRole(interaction.guildId, role.id);
      await interaction.reply({ content: `Rôle staff ajouté : <@&${role.id}>`, ephemeral: true });
      return;
    }

    // 0 minute = desactive l'escalade (stocke comme `null` en base) plutot que de la
    // regler a un delai de zero seconde, ce qui n'aurait pas de sens metier.
    if (sub === "set-escalation-timeout") {
      const minutes = interaction.options.getInteger("minutes", true);
      await setEscalationMinutes(interaction.guildId, minutes === 0 ? null : minutes);
      await interaction.reply({
        content: minutes === 0 ? "Escalade désactivée." : `Escalade fixée à ${minutes} min sans réponse staff.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "set-recruitment-channel") {
      const channel = interaction.options.getChannel("channel");
      await setRecruitmentLogChannel(interaction.guildId, channel?.id ?? null);
      await interaction.reply({
        content: channel
          ? `Suivi des candidatures posté désormais dans <#${channel.id}>.`
          : "Suivi des candidatures repostera dans le salon de chaque ticket.",
        ephemeral: true,
      });
      return;
    }

    if (sub === "set-recruitment-open") {
      const open = interaction.options.getBoolean("open", true);
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
