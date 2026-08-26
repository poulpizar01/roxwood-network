import "dotenv/config";
import { z } from "zod";

/**
 * Schema de validation des variables d'environnement attendues par le bot.
 * `DEV_GUILD_ID` est optionnel : s'il est absent, les commandes slash sont enregistrees
 * globalement (propagation jusqu'a ~1h) plutot que sur une seule guilde de dev (instantane).
 */
const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN manquant"),
  CLIENT_ID: z.string().min(1, "CLIENT_ID manquant"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL manquant"),
  DEV_GUILD_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

// Echec rapide et explicite plutot que de laisser le bot demarrer avec une config incomplete.
if (!parsed.success) {
  console.error("Variables d'environnement invalides :", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Variables d'environnement validees et typees, a importer partout ailleurs dans le code. */
export const env = parsed.data;
