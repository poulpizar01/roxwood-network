import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import { getGuildConfig, getCategoryType } from "../services/guildConfigService.js";
import { trackTicketChannel } from "../services/ticketService.js";
import { createApplication } from "../services/recruitmentService.js";
import { getOrCreateOrder } from "../services/orderService.js";
import { listActive } from "../services/catalogService.js";
import { logger } from "../utils/logger.js";

async function postRecruitmentIntro(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (!channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle("Candidature")
    .setDescription("Merci pour votre interet ! Cliquez sur le bouton ci-dessous pour remplir le formulaire de candidature.")
    .setColor(0x5865f2);

  const button = new ButtonBuilder()
    .setCustomId("recruitment:start-form")
    .setLabel("Remplir le formulaire")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  await channel.send({ embeds: [embed], components: [row] });
}

async function postServiceIntro(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (!channel.isTextBased()) return;

  const items = await listActive(channel.guildId);
  if (items.length === 0) {
    await channel.send("Bienvenue ! Le catalogue n'est pas encore configure, un membre du staff va vous assister.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Catalogue")
    .setDescription("Choisissez un article dans le menu ci-dessous pour passer commande.")
    .setColor(0x5865f2);

  const select = new StringSelectMenuBuilder()
    .setCustomId("order:select-item")
    .setPlaceholder("Choisir un article")
    .addOptions(
      items.slice(0, 25).map((item) => ({
        label: item.name.slice(0, 100),
        description: `${item.price.toLocaleString("fr-FR")} $`,
        value: item.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await channel.send({ embeds: [embed], components: [row] });
}

export async function onChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  const config = await getGuildConfig(channel.guildId);
  const type = getCategoryType(config, channel.parentId);
  if (!type) return;

  try {
    const ticket = await trackTicketChannel(channel, channel.parentId!, type);
    if (!ticket) return;

    if (type === "RECRUITMENT") {
      await createApplication(ticket.id);
      await postRecruitmentIntro(channel);
    } else {
      await getOrCreateOrder(ticket.id);
      await postServiceIntro(channel);
    }
  } catch (error) {
    logger.error(`Erreur lors du suivi du nouveau canal ${channel.id}`, error);
  }
}
