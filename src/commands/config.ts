import { PermissionFlagsBits, SlashCommandBuilder, ChannelType } from "discord.js";
import type { Command } from "./types.js";
import { setEscalationMinutes, setRecruitmentLogChannel, setPanelChannel } from "../services/guildConfigService.js";
import { refreshRootPanelMessage } from "../services/panelService.js";

/**
 * `/config` : commande d'administration (reservee `ManageGuild`). La majorite des reglages
 * (categories de tickets, roles de gestion, catalogue, recrutement...) se font desormais via
 * le panneau par boutons (voir `panelService.ts`, `interactionCreate.ts` prefixe `panel:`) —
 * `set-panel-channel` designe justement le salon qui l'accueille. Seuls les reglages pas
 * encore migres vers le panneau restent des commandes slash pour cette phase.
 */
export const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configurer la sur-couche de tickets pour ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("set-panel-channel")
        .setDescription("Salon qui accueille le panneau d'administration par boutons")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Salon du panneau")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
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
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "set-panel-channel") {
      const channel = interaction.options.getChannel("channel", true);
      await setPanelChannel(interaction.guildId, channel.id);
      await refreshRootPanelMessage(interaction.client, interaction.guildId, channel.id);
      await interaction.reply({ content: `Panneau d'administration installé dans <#${channel.id}>.`, ephemeral: true });
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
    }
  },
};
