import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { addField, addItem, getItem, listActive, removeField, removeItem } from "../services/catalogService.js";

/**
 * Styles de champ proposes au staff pour `field-add`. "Quantite" est un choix special :
 * sa reponse alimente automatiquement `OrderItem.quantity` (voir `orderService.addItemFromAnswers`)
 * au lieu d'etre juste affichee comme texte libre sur la facture.
 */
const FIELD_STYLE_CHOICES = [
  { name: "Texte court", value: "SHORT" },
  { name: "Texte long", value: "PARAGRAPH" },
  { name: "Quantité", value: "QUANTITY" },
] as const;

/**
 * `/catalog` : commande d'administration (reservee `ManageGuild`) pour que le staff
 * configure le catalogue de produits/services et les champs que le client devra remplir
 * en commandant chaque article. C'est cette configuration qui pilote le formulaire dynamique
 * genere cote client (voir `handleOrderSelectItem` dans interactionCreate.ts).
 */
export const catalogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("catalog")
    .setDescription("Gérer le catalogue de produits/services")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Ajouter un article au catalogue")
        .addStringOption((opt) => opt.setName("name").setDescription("Nom de l'article").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("Prix").setMinValue(0).setRequired(true))
        .addAttachmentOption((opt) => opt.setName("image").setDescription("Photo de l'article").setRequired(true))
        .addStringOption((opt) => opt.setName("description").setDescription("Description").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Retirer un article du catalogue")
        .addStringOption((opt) => opt.setName("id").setDescription("Identifiant de l'article").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Lister les articles actifs"))
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("Voir le détail d'un article")
        .addStringOption((opt) => opt.setName("id").setDescription("Identifiant de l'article").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("field-add")
        .setDescription("Ajouter un champ à remplir par le client pour cet article (5 max)")
        .addStringOption((opt) => opt.setName("item").setDescription("Identifiant de l'article").setRequired(true))
        .addStringOption((opt) => opt.setName("label").setDescription("Intitulé du champ").setRequired(true))
        .addStringOption((opt) =>
          opt.setName("style").setDescription("Type de champ").setRequired(true).addChoices(...FIELD_STYLE_CHOICES)
        )
        .addBooleanOption((opt) => opt.setName("required").setDescription("Obligatoire ? (par défaut oui)").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("field-remove")
        .setDescription("Retirer un champ")
        .addStringOption((opt) => opt.setName("field-id").setDescription("Identifiant du champ").setRequired(true))
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const name = interaction.options.getString("name", true);
      const price = interaction.options.getInteger("price", true);
      const image = interaction.options.getAttachment("image", true);
      const description = interaction.options.getString("description") ?? undefined;

      const item = await addItem(interaction.guildId, { name, price, imageUrl: image.url, description });
      await interaction.reply({ content: `Article créé : **${item.name}** (id: \`${item.id}\`)`, ephemeral: true });
      return;
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id", true);
      await removeItem(interaction.guildId, id);
      await interaction.reply({ content: "Article retire (s'il existait).", ephemeral: true });
      return;
    }

    if (sub === "list") {
      const items = await listActive(interaction.guildId);
      if (items.length === 0) {
        await interaction.reply({ content: "Catalogue vide.", ephemeral: true });
        return;
      }
      const lines = items.map((i) => `\`${i.id}\` **${i.name}** — ${i.price.toLocaleString("fr-FR")} $`);
      await interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
      return;
    }

    if (sub === "view") {
      const id = interaction.options.getString("id", true);
      const item = await getItem(interaction.guildId, id);
      if (!item) {
        await interaction.reply({ content: "Article introuvable.", ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(item.name)
        .setDescription(item.description ?? null)
        .addFields(
          { name: "Prix", value: `${item.price.toLocaleString("fr-FR")} $`, inline: true },
          {
            name: "Champs client",
            value: item.fields.length ? item.fields.map((f) => `\`${f.id}\` ${f.label} (${f.style})`).join("\n") : "aucun",
          }
        )
        .setColor(0x5865f2);
      if (item.imageUrl) embed.setImage(item.imageUrl);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === "field-add") {
      const itemId = interaction.options.getString("item", true);
      const label = interaction.options.getString("label", true);
      const style = interaction.options.getString("style", true) as "SHORT" | "PARAGRAPH" | "QUANTITY";
      const required = interaction.options.getBoolean("required") ?? true;

      try {
        // addField valide les regles metier (max 5 champs, au plus un QUANTITY) et leve une
        // Error au message deja redige pour l'utilisateur : on le relaie tel quel.
        await addField(interaction.guildId, itemId, { label, style, required });
        await interaction.reply({ content: `Champ ajouté : **${label}**`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: error instanceof Error ? error.message : "Erreur.", ephemeral: true });
      }
      return;
    }

    if (sub === "field-remove") {
      const fieldId = interaction.options.getString("field-id", true);
      await removeField(interaction.guildId, fieldId);
      await interaction.reply({ content: "Champ retire (s'il existait).", ephemeral: true });
    }
  },
};
