# Roxwood Network

Bot Discord (Node.js + TypeScript + discord.js + Prisma/PostgreSQL) qui ajoute une sur-couche a Ticket Tool pour des serveurs GTA RP, sur deux usages :

- **Recrutement** : formulaire de candidature (bouton -> modal) rempli par le candidat des l'ouverture du ticket, pipeline de suivi pour le staff (etape, recruteur assigne).
- **Service client** : catalogue de produits/services (photo + champs personnalises par article, configure par le staff), commande composee **par le client lui-meme** (menu deroulant + formulaire), le staff n'a qu'a confirmer le paiement — ce qui genere automatiquement une facture en image.

Plus les fonctions generiques de la base : priorites/tags, escalade automatique, reponses automatiques par mot-cle, webhooks sortants pour brancher des systemes externes.

Ticket Tool n'a pas d'API publique : la detection se fait en ecoutant les evenements Discord (creation/suppression/renommage de canal dans la categorie configuree, associee a un type Recrutement ou Service via `/config add-category`).

## Secrets : qui a acces a quoi

Le token du bot de **production** (celui utilise sur le vrai serveur Discord) vit uniquement dans le `.env` du VPS, configure par la personne qui a acces au VPS. Il n'est jamais commite, jamais partage sur GitHub, et les contributeurs qui n'ont acces qu'au repo n'y ont pas acces.

Pour developper/tester en local sans ce token, creer une application Discord **personnelle et separee** sur https://discord.com/developers/applications (gratuit) :
1. New Application → Bot → copier le token → c'est ton `DISCORD_TOKEN` de dev local.
2. Recuperer le Client ID dans "General Information" → `CLIENT_ID`.
3. Inviter ce bot de test sur un serveur Discord perso (le tien, ou un serveur de test) via l'URL d'invitation OAuth2 generee dans le portail, avec un vrai Ticket Tool installe dessus pour tester la detection.

## Demarrage (dev local)

1. `npm install`
2. Copier `.env.example` en `.env` et renseigner `DISCORD_TOKEN`/`CLIENT_ID` (ton bot de test personnel, voir ci-dessus), `DATABASE_URL` (et `DEV_GUILD_ID` en dev pour un enregistrement instantane des commandes slash).
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

- `/config add-category <category> <type>` : associe une categorie Discord (celle utilisee par un bouton du panel Ticket Tool) a un type de ticket, Recrutement ou Service. Une categorie non configuree est ignoree par le bot (geree par Ticket Tool seul).
- `/config set-staff-role` : role(s) considere(s) comme staff (pour le temps de premiere reponse, les pings d'escalade et les notifications de nouvelle commande).
- `/config set-escalation-timeout` : delai en minutes avant qu'un ticket sans reponse staff declenche une escalade (0 = desactive).

## Recrutement

A l'ouverture d'un ticket dans une categorie de type Recrutement, le bot poste un bouton "Remplir le formulaire" qui ouvre un modal Discord (5 questions fixes : Nom RP, Age, Experience RP, Disponibilites, Motivation). Les reponses sont enregistrees et un recap est poste dans le salon.

- `/recruitment status <etape>` — En attente / Entretien / Accepte / Refuse.
- `/recruitment claim` — s'assigner la candidature.
- `/ticket info` affiche aussi le statut de la candidature et le recruteur assigne.

## Service client (catalogue + commande self-service)

Le staff configure le catalogue, le **client compose sa commande lui-meme** dans le ticket :

1. `/catalog add <name> <price> <image> [description]` — cree un article (photo obligatoire).
2. `/catalog field-add <item> <label> <style> [required]` — jusqu'a 5 champs par article, a remplir par le client lors de la commande (ex: date + nombre d'invites pour une salle, quantite + boisson pour un menu). Le style `Quantite` alimente automatiquement le calcul du prix ; les autres styles (`Texte court`/`Texte long`) sont juste enregistres et affiches sur la facture.
3. A l'ouverture d'un ticket Service, le bot poste un menu deroulant du catalogue actif. Le client choisit un article -> un formulaire genere a partir des champs configures s'ouvre -> il peut ajouter d'autres articles -> "Valider la commande" ping le role staff.
4. Cote staff : `/order status`, `/order paid` (marque payee et **genere/poste automatiquement l'image de facture**), `/order invoice` (renvoie l'image), `/order add-item`/`remove-item` pour des corrections manuelles exceptionnelles.

Autres commandes catalogue : `/catalog list`, `/catalog view <id>`, `/catalog remove <id>`, `/catalog field-remove <field-id>`.

## Commandes generiques

- `/ticket info` — resume du ticket courant (statut, priorite, tags, opener, + bloc specifique Recrutement ou Service).
- `/ticket priority <level>` — LOW / NORMAL / HIGH / URGENT.
- `/ticket tag add|remove <tag>`.
- `/autoreply add|remove|list` — regles de reponse automatique mot-cle.
- `/stats overview` — tickets ouverts/fermes/escalades, temps de reponse moyen.

## Points d'extension

- `src/services/autoReplyService.ts` : interface `AutoReplyMatcher`, un seul matcher mot-cle fourni. Ajouter un matcher IA (ex: Claude API) ici sans toucher au reste.
- `src/services/webhookDispatcher.ts` : webhooks sortants signes HMAC (header `X-Signature-256`) sur les evenements `ticket.created`, `ticket.closed`, `ticket.escalated` — point de branchement generique pour un CRM/site externe.

## A verifier sur le vrai serveur

Le signal de fermeture de ticket differe selon la configuration Ticket Tool (suppression du canal, renommage avec un prefixe, ou deplacement de categorie). Le bot couvre la suppression (`channelDelete`) et un renommage avec prefixe `closed-`/`ferme-` (`channelUpdate`, voir `src/events/channelUpdate.ts`) — a ajuster une fois observe en conditions reelles.
