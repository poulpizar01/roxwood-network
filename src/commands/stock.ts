import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { getStockForSafe, getTotalStock, listSafes } from "../services/monitoringSafeService.js";

/**
 * `/stock` : accessible a tout le monde (comme `/absence`) — c'est une consultation, pas une
 * action d'administration, et le salon panneau peut etre invisible aux non-staff. Alimente
 * par le ledger de mouvements de coffre (`monitoringSafeService.ts`), lui-meme rempli par
 * l'ingestion des logs webhook FiveM de type SAFE (voir `monitoringService.ts`).
 */
export const stockCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("stock")
    .setDescription("Consulter le stock des coffres d'entreprise")
    .addStringOption((opt) =>
      opt.setName("coffre").setDescription("Coffre précis (laisser vide pour le stock total)").setRequired(false).setAutocomplete(true)
    ) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    const safeId = interaction.options.getString("coffre");

    if (safeId) {
      const safes = await listSafes(interaction.guildId);
      const safe = safes.find((s) => s.id === safeId);
      if (!safe) {
        await interaction.reply({ content: "Coffre introuvable.", ephemeral: true });
        return;
      }

      const stock = await getStockForSafe(safeId);
      const embed = new EmbedBuilder().setTitle(`Stock — ${safe.label ?? safe.positionKey}`).setColor(0x5865f2);
      embed.setDescription(stock.length > 0 ? stock.map((s) => `**${s.itemId}** : ${s.quantity}`).join("\n") : "Aucun stock enregistré.");
      await interaction.reply({ embeds: [embed] });
      return;
    }

    const stock = await getTotalStock(interaction.guildId);
    const embed = new EmbedBuilder().setTitle("Stock total (tous coffres)").setColor(0x5865f2);
    embed.setDescription(stock.length > 0 ? stock.map((s) => `**${s.itemId}** : ${s.quantity}`).join("\n") : "Aucun stock enregistré.");
    await interaction.reply({ embeds: [embed] });
  },

  async autocomplete(interaction) {
    if (!interaction.inGuild()) return;
    const safes = await listSafes(interaction.guildId);
    const focused = interaction.options.getFocused().toLowerCase();
    const filtered = safes.filter((s) => (s.label ?? s.positionKey).toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map((s) => ({ name: (s.label ?? s.positionKey).slice(0, 100), value: s.id })));
  },
};
