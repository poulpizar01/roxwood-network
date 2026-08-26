import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN manquant"),
  CLIENT_ID: z.string().min(1, "CLIENT_ID manquant"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL manquant"),
  DEV_GUILD_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Variables d'environnement invalides :", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
