# Sur-couche Ticket Tool

Bot Discord (Node.js + TypeScript + discord.js + Prisma/PostgreSQL) qui observe les tickets crees par Ticket Tool et ajoute : priorites/tags, escalade automatique, reponses automatiques par mot-cle, et des webhooks sortants pour brancher des systemes externes.

Ticket Tool n'a pas d'API publique : la detection se fait en ecoutant les evenements Discord (creation/suppression/renommage de canal dans la categorie configuree).

## Demarrage (dev local)

1. `npm install`
2. Copier `.env.example` en `.env` et renseigner `DISCORD_TOKEN`, `CLIENT_ID`, `DATABASE_URL` (et `DEV_GUILD_ID` en dev pour un enregistrement instantane des commandes slash).
3. `npx prisma migrate dev` pour creer le schema PostgreSQL.
4. `npm run dev` pour lancer le bot.

## Deploiement VPS (Docker)

Le bot tourne en production via `docker-compose.yml` (2 services : `bot` et `db` Postgres). Sur le VPS :

1. `git clone` puis `cd` dans le repo.
2. Creer un fichier `.env` (jamais commite) avec au minimum : `DISCORD_TOKEN`, `CLIENT_ID`, `POSTGRES_PASSWORD` (mot de passe dedie, different du dev local). Voir `.env.example` pour la liste complete des variables Docker.
3. `docker compose up -d --build`

Au demarrage du conteneur `bot`, `docker/entrypoint.sh` applique automatiquement les migrations Prisma (`prisma migrate deploy`) avant de lancer le bot — aucune commande manuelle a lancer sur le VPS pour les migrations.

Pour mettre a jour apres un push sur GitHub : sur le VPS, `git pull` puis `docker compose up -d --build`.

Aucun port n'est expose publiquement (le bot ne fait que des connexions sortantes vers Discord et les webhooks configures) ; Postgres n'est accessible que depuis le reseau Docker interne.

## Configuration sur un serveur

- `/config set-ticket-category` : indique quelle categorie Discord Ticket Tool utilise pour ouvrir les tickets.
- `/config set-staff-role` : role(s) considere(s) comme staff (pour le temps de premiere reponse et les pings d'escalade).
- `/config set-escalation-timeout` : delai en minutes avant qu'un ticket sans reponse staff declenche une escalade (0 = desactive).

## Commandes disponibles

- `/ticket info` — resume du ticket courant (statut, priorite, tags, opener).
- `/ticket priority <level>` — LOW / NORMAL / HIGH / URGENT.
- `/ticket tag add|remove <tag>`.
- `/autoreply add|remove|list` — regles de reponse automatique mot-cle.
- `/stats overview` — tickets ouverts/fermes/escalades, temps de reponse moyen.

## Points d'extension

- `src/services/autoReplyService.ts` : interface `AutoReplyMatcher`, un seul matcher mot-cle fourni. Ajouter un matcher IA (ex: Claude API) ici sans toucher au reste.
- `src/services/webhookDispatcher.ts` : webhooks sortants signes HMAC (header `X-Signature-256`) sur les evenements `ticket.created`, `ticket.closed`, `ticket.escalated` — point de branchement generique pour un CRM/site externe.

## A verifier sur le vrai serveur

Le signal de fermeture de ticket differe selon la configuration Ticket Tool (suppression du canal, renommage avec un prefixe, ou deplacement de categorie). Le bot couvre la suppression (`channelDelete`) et un renommage avec prefixe `closed-`/`ferme-` (`channelUpdate`, voir `src/events/channelUpdate.ts`) — a ajuster une fois observe en conditions reelles.
