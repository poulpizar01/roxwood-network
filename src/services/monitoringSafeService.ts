import { prisma } from "../db/prisma.js";

/**
 * Ledger des mouvements de coffre d'entreprise (`MonitoringSafe`/`MonitoringSafeMovement`),
 * alimente par `monitoringService.ingestMonitoringMessage` sur les logs de type SAFE. Pas de
 * lecture cote Discord (l'ancienne commande `/stock` a ete retiree — accessible a tout membre
 * du serveur sans role requis, jugee trop exposee pour une donnee d'entreprise) : le stock
 * n'est aujourd'hui consultable que via le webhook sortant `monitoring.safe` (voir
 * `webhookDispatcher.ts`), cote site externe.
 */

/**
 * Retrouve le coffre correspondant a une position (le cree s'il n'existe pas encore — premier
 * mouvement observe sur ce coffre).
 */
async function findOrCreateSafe(guildId: string, positionKey: string) {
  return prisma.monitoringSafe.upsert({
    where: { guildId_positionKey: { guildId, positionKey } },
    create: { guildId, positionKey },
    update: {},
  });
}

/** Enregistre un mouvement (depot positif ou retrait negatif) sur le coffre identifie par sa position. */
export async function recordSafeMovement(
  guildId: string,
  positionKey: string,
  itemId: string,
  quantity: number,
  player: { discordId?: string; name?: string }
) {
  const safe = await findOrCreateSafe(guildId, positionKey);
  return prisma.monitoringSafeMovement.create({
    data: {
      safeId: safe.id,
      itemId,
      quantity,
      playerDiscordId: player.discordId,
      playerName: player.name,
    },
  });
}

/** Liste les coffres connus d'une guilde. */
export async function listSafes(guildId: string) {
  return prisma.monitoringSafe.findMany({ where: { guildId }, orderBy: { positionKey: "asc" } });
}

/** Stock courant (par item) d'un coffre precis. */
export async function getStockForSafe(safeId: string): Promise<{ itemId: string; quantity: number }[]> {
  const rows = await prisma.monitoringSafeMovement.groupBy({
    by: ["itemId"],
    where: { safeId },
    _sum: { quantity: true },
  });
  return rows.map((r) => ({ itemId: r.itemId, quantity: r._sum.quantity ?? 0 })).filter((r) => r.quantity !== 0);
}

/** Stock courant (par item), tous coffres de la guilde confondus. */
export async function getTotalStock(guildId: string): Promise<{ itemId: string; quantity: number }[]> {
  const safes = await listSafes(guildId);
  if (safes.length === 0) return [];

  const rows = await prisma.monitoringSafeMovement.groupBy({
    by: ["itemId"],
    where: { safeId: { in: safes.map((s) => s.id) } },
    _sum: { quantity: true },
  });
  return rows.map((r) => ({ itemId: r.itemId, quantity: r._sum.quantity ?? 0 })).filter((r) => r.quantity !== 0);
}
