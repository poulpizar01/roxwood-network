# Roxwood Network

Bot Discord (Node.js + TypeScript + discord.js + Prisma/PostgreSQL) qui ajoute une sur-couche à Ticket Tool pour des serveurs GTA RP, sur deux usages :

- **Recrutement** : formulaire de candidature (bouton -> modal) rempli par le candidat dès l'ouverture du ticket, suivi piloté par le staff via des boutons (pas de commande à taper) dans un salon de suivi dédié.
- **Service client** : catalogue de produits/services (photo + champs personnalisés par article, configuré par le staff), commande composée **par le client lui-même** (menu déroulant + formulaire), le staff n'a qu'à confirmer le paiement — ce qui génère automatiquement une facture en image.

Plus une troisième catégorie de ticket, **FAQ** : le client pose sa question, une réponse automatique par mot-clé se déclenche si elle correspond à une règle configurée. Et les fonctions génériques de la base : demandes d'absence, webhooks sortants pour brancher des systèmes externes.

Ticket Tool n'a pas d'API publique : la détection se fait en écoutant les événements Discord (création/suppression/renommage de canal dans la catégorie configurée, associée à un type Recrutement, Service ou FAQ via le **panneau d'administration**, voir plus bas).

**Quasiment toute la configuration passe par le panneau d'administration** (messages permanents avec boutons, édités en place) plutôt que par des commandes slash — beaucoup plus intuitif que de devoir connaître/taper des commandes. Il ne reste que quelques commandes slash pour ce qui n'a pas encore rejoint le panneau, plus `/absence` qui est volontairement une commande (accessible à tout le monde, pas un bouton dans un salon potentiellement invisible aux non-staff).

## Secrets : qui a accès à quoi

Le token du bot de **production** (celui utilisé sur le vrai serveur Discord) vit uniquement dans le `.env` du VPS, configuré par la personne qui a accès au VPS. Il n'est jamais commité, jamais partagé sur GitHub, et les contributeurs qui n'ont accès qu'au repo n'y ont pas accès.

Pour développer/tester en local sans ce token, créer une application Discord **personnelle et séparée** sur https://discord.com/developers/applications (gratuit) :
1. New Application → Bot → copier le token → c'est ton `DISCORD_TOKEN` de dev local.
2. Récupérer le Client ID dans "General Information" → `CLIENT_ID`.
3. Inviter ce bot de test sur un serveur Discord perso (le tien, ou un serveur de test) via l'URL d'invitation OAuth2 générée dans le portail, avec un vrai Ticket Tool installé dessus pour tester la détection.

## Démarrage (dev local)

1. `npm install`
2. Copier `.env.example` en `.env` et renseigner `DISCORD_TOKEN`/`CLIENT_ID` (ton bot de test personnel, voir ci-dessus), `DATABASE_URL` (et `DEV_GUILD_ID` en dev pour un enregistrement instantané des commandes slash).
3. `npx prisma migrate dev` pour créer le schéma PostgreSQL.
4. `npm run dev` pour lancer le bot.

## Déploiement VPS (Docker)

Le bot tourne en production via `docker-compose.yml` (2 services : `bot` et `db` Postgres). Sur le VPS :

1. `git clone` puis `cd` dans le repo.
2. Créer un fichier `.env` (jamais commité) avec au minimum : `DISCORD_TOKEN`, `CLIENT_ID`, `POSTGRES_PASSWORD` (mot de passe dédié, différent du dev local). Voir `.env.example` pour la liste complète des variables Docker.
3. `docker compose up -d --build`

Au démarrage du conteneur `bot`, `docker/entrypoint.sh` applique automatiquement les migrations Prisma (`prisma migrate deploy`) avant de lancer le bot — aucune commande manuelle à lancer sur le VPS pour les migrations.

Pour mettre à jour après un push sur GitHub : sur le VPS, `git pull` puis `docker compose up -d --build`.

Aucun port n'est exposé publiquement (le bot ne fait que des connexions sortantes vers Discord et les webhooks configurés) ; Postgres n'est accessible que depuis le réseau Docker interne.

## Panneau d'administration

`/config set-panel-channel <channel>` désigne un salon (staff/admin uniquement côté permissions Discord) qui accueille le **message racine** du panneau : 3 boutons, **Tickets**, **Absences**, **Monitoring**. Cliquer un bouton active la fonctionnalité et poste (ou met à jour) un **message dédié** dans le même salon, édité en place à chaque changement plutôt que reposté.

- **Tickets** : gestion des rôles de gestion par catégorie de ticket ("Ajouter/Retirer un rôle de gestion" — chaque catégorie a sa propre équipe, plus de rôle staff global unique), plus trois boutons qui ouvrent les messages dédiés imbriqués **Service client**, **Recrutement** et **FAQ** (dans le même salon).
- **Service client** : bouton "Définir/Retirer la catégorie" (libellé selon l'état courant), puis gestion du catalogue — ajouter/retirer un article, changer sa photo (envoyée en message juste après, les modals Discord ne supportent pas l'upload de fichier), ajouter/retirer un champ personnalisé par article.
- **Recrutement** : bouton "Définir/Retirer la catégorie", bouton "Ouvrir/Fermer les recrutements" (même principe, libellé dynamique), bouton "Définir/Retirer le salon de suivi" des candidatures (même principe — "Retirer" revient au comportement par défaut : récap posté dans le salon du ticket), et gestion des questions du formulaire de candidature (max 5, style texte court/long) — si aucune n'est configurée, repli automatique sur 5 questions par défaut (Nom RP, Âge, Expérience RP, Disponibilités, Motivation).
- **FAQ** : bouton "Définir/Retirer la catégorie" (comme Service client/Recrutement), puis gestion des règles de réponse automatique mot-clé -> réponse.
- **Absences** : configuration du rôle approbateur et du salon de suivi des demandes (voir section Absences plus bas).
- **Monitoring** : lecture des logs webhook du script FiveM (voir section Monitoring plus bas).

Chaque message dédié (sauf le message racine) porte une réaction 🗑️ posée automatiquement : cliquer dessus le supprime et réinitialise sa référence en base — recliquer le bouton parent (racine, ou "Tickets" pour Service/Recrutement/FAQ) le reposte tout neuf. Le message racine n'a jamais cette réaction : c'est le seul point d'entrée vers tout le reste, il ne doit pas pouvoir être supprimé par erreur.

## Commandes slash restantes

- `/config set-panel-channel <channel>` — salon du panneau d'administration (voir ci-dessus).
- `/absence` — déclare une absence (accessible à tout le monde, voir section Absences).
- `/stock [coffre]` — consulte le stock d'un coffre d'entreprise, ou le stock total (accessible à tout le monde, voir section Monitoring).
- `/stats overview` — tickets ouverts/fermés, temps de réponse moyen.

`/catalog`, `/recruitment status` et `/autoreply` n'existent plus : entièrement remplacés par le panneau d'administration.

## Recrutement

À l'ouverture d'un ticket dans la catégorie Recrutement (et si les recrutements sont ouverts, voir panneau "Recrutement"), le bot poste un bouton "Remplir le formulaire" qui ouvre un modal Discord avec les questions configurées (ou les 5 par défaut). À la soumission, le candidat reçoit une confirmation qui l'invite aussi à envoyer d'éventuelles photos/documents **directement en message** dans le salon : le bot les rattache automatiquement à la candidature.

Un récap (candidat, statut, recruteur, réponses, pièces jointes) est posté dans le salon de suivi (panneau "Recrutement" → "Définir le salon de suivi", ou le salon du ticket par défaut) avec deux boutons :

- **Statut** — ouvre un menu déroulant éphémère (En attente / Entretien / Accepté / Refusé) ; le message de suivi se met à jour automatiquement. Passer une candidature à **Refusé** marque aussi le ticket comme clôturé côté suivi (sort des stats "ouverts") et prévient le staff dans le salon qu'il peut le fermer via le bouton "Close" de Ticket Tool. La fermeture automatisée a été testée (message direct du bot, puis via webhook de salon) et abandonnée : Ticket Tool ignore tout message qui ne vient pas d'un vrai humain, et un bot ne peut de toute façon pas cliquer le bouton d'un autre bot à sa place (limite Discord). C'est pour ça que le bot ne supprime jamais les messages d'un autre bot qui portent un bouton/menu (voir plus bas) : celui de Ticket Tool doit rester cliquable.
- **S'assigner** — assigne directement le membre du staff qui clique comme recruteur (réassignation possible).

Ces boutons (et ceux du panneau "Tickets"/"Service client"/"Recrutement"/"FAQ") sont réservés aux rôles de gestion de la catégorie concernée (panneau "Tickets" → "Ajouter un rôle de gestion") : un clic par quelqu'un d'autre est refusé avec un message explicite.

Le bot supprime aussi automatiquement, dans tout ticket suivi, les messages purement informatifs postés par d'autres bots pour garder le salon propre — mais jamais un message qui porte un bouton ou un menu (typiquement le message de bienvenue de Ticket Tool avec son bouton "Close"), pour ne pas priver le staff de sa seule vraie méthode de fermeture. Nécessite que le rôle du bot ait la permission Discord **"Gérer les messages"** sur le serveur ; sans elle, la suppression échoue silencieusement (juste loggée).

## Service client (catalogue + commande self-service)

Le staff configure le catalogue via le panneau "Service client", le **client compose sa commande lui-même** dans le ticket, et un seul message de commande est édité en place tout au long du cycle (composition → validation → suivi) plutôt que reposté à chaque fois :

1. Panneau "Service client" → "Ajouter un article" (modal nom/prix/description) → "Changer la photo d'un article" (envoyée en message juste après, les modals ne supportent pas l'upload).
2. "Ajouter un champ" — jusqu'à 5 champs par article, à remplir par le client lors de la commande (ex: date + nombre d'invités pour une salle, quantité + boisson pour un menu). Le style `Quantité` alimente automatiquement le calcul du prix ; les autres styles (`Texte court`/`Texte long`) sont juste enregistrés et affichés sur la facture.
3. À l'ouverture d'un ticket Service, le bot poste un menu déroulant du catalogue actif. Le client choisit un article -> un formulaire généré à partir des champs configurés s'ouvre -> il peut ajouter d'autres articles -> "Valider la commande" ping les rôles de gestion de la catégorie.
4. Côté staff, directement sur le message de commande : **Statut** (menu déroulant), **Marquer payée** (bascule le paiement et **génère/poste automatiquement l'image de facture**), **Facture** (renvoie l'image), **Ajouter un article** (réutilise le menu du client), **Retirer un article** (menu des lignes existantes) — pour des corrections manuelles exceptionnelles. Boutons réservés aux rôles de gestion de la catégorie.

## Absences

Panneau "Absences" → configurer le **rôle approbateur** et le **salon de suivi** (séparé du salon panneau). Une fois les deux définis, n'importe quel membre peut déclarer une absence avec `/absence` (dates JJ/MM/AAAA + motif). La demande est postée dans le salon de suivi avec deux boutons **Accepter**/**Refuser**, réservés au rôle approbateur ; le message se met à jour en place (statut, qui a traité) une fois résolue.

## FAQ

Troisième catégorie de ticket (comme Recrutement et Service client) : à l'ouverture d'un ticket dans la catégorie FAQ, le bot invite le client à poser sa question. Panneau "Tickets" → "FAQ" → "Définir la catégorie", puis "Ajouter une règle" (modal mot-clé/réponse) / "Retirer une règle". Quand le client écrit un message contenant le mot-clé d'une règle (recherche simple, insensible à la casse), la réponse configurée est postée automatiquement ; sinon un membre du staff (rôle de gestion de la catégorie FAQ) prend le relais.

## Monitoring (logs webhook FiveM)

Le script FiveM du serveur poste des logs d'activité en jeu (embeds webhook) dans des salons dédiés : prise/fin de service, recrutements/licenciements, mouvements de coffre d'entreprise, factures, ventes. Le panneau "Monitoring" configure :

- **Entreprise (jobId)** : chaque guilde ne surveille qu'**une seule entreprise** — tout log dont le `jobId` ne correspond pas est complètement ignoré (le serveur FiveM mélange plusieurs entreprises dans les mêmes salons).
- **Rôle "en service"** : ajouté au membre à la prise de service, retiré à la fin de service.
- **Un salon par type de log** (Prise de service / Recrutement / Coffre / Facture / Vente run) : bouton "Salon <type>" (libellé dynamique Définir/Retirer selon l'état courant).
- **Webhooks sortants** : "Ajouter un webhook" (choisir le type d'événement → URL de destination) génère un secret affiché **une seule fois**, à noter pour vérifier la signature HMAC-SHA256 (header `X-Signature-256`) côté récepteur — même mécanisme que les webhooks `ticket.*` existants (voir Points d'extension).

Effets automatiques :
- **Prise de service** : bascule le rôle "en service" du membre concerné.
- **Recrutement** (embauche uniquement) : si un ticket de candidature existe pour ce joueur (`Ticket.openerId` = `targetPlayerDiscord` du log), passe son statut à **Accepté** et met à jour le message de suivi. Licenciements et changements de grade sont journalisés mais sans effet automatique pour l'instant.
- **Coffre** : chaque dépôt/retrait alimente un ledger par coffre (identifié par sa position), interrogeable avec `/stock`.
- **Facture / Vente run** : journalisés pour les statistiques (montant, taxes, quantités) et relayés par webhook sortant — aucun effet automatique.

Tout log reçu (que le texte libre de sa description ait pu être parsé ou non) est conservé en base (`MonitoringEvent`) et jamais perdu — un format de description inattendu désactive juste l'effet automatique correspondant (avertissement loggé), le reste continue de fonctionner.

**Récupération des données côté site externe** : le bot ne fait que du push sortant — dès qu'un événement se produit, il envoie un `POST` au serveur du site, sans qu'aucun utilisateur ne soit connecté à ce moment-là (communication bot-vers-serveur, pas liée à une session). Le corps envoyé est `{ guildId, eventType, payload, sentAt }` : `guildId` identifie explicitement de quel serveur Discord provient l'événement, pour que le récepteur puisse trier même s'il reçoit les données de plusieurs Discords sur une seule URL. Distinguer les Discords entre eux (ne récupérer que les données d'un seul) se fait donc soit en filtrant sur ce `guildId`, soit en utilisant une URL dédiée par Discord lors de la création de l'abonnement (panneau "Monitoring" → "Ajouter un webhook"). L'authentification d'un visiteur humain sur le site (OAuth2 Discord) est un sujet complètement séparé, sans lien avec ce flux de données — voir la discussion dans l'historique du projet si besoin.

**Sécurité des webhooks** : c'est du push sortant uniquement (aucun port/serveur exposé côté bot), et l'isolation entre serveurs Discord est garantie côté code — `dispatchWebhook` ne va chercher que les abonnements de la guilde concernée, jamais ceux d'un autre serveur. La signature HMAC-SHA256 permet au récepteur de vérifier l'authenticité des requêtes, mais **seulement s'il implémente lui-même cette vérification** — le bot ne peut pas l'y forcer (même principe que les webhooks Stripe/GitHub). Les actions sensibles du panneau "Monitoring" (jobId, rôle "en service", salons, webhooks sortants) exigent la permission Discord **"Gérer le serveur"**, en plus des permissions du salon panneau lui-même — contrairement au reste du panneau, qui ne s'appuie que sur la visibilité du salon.

## Points d'extension

- `src/services/autoReplyService.ts` : interface `AutoReplyMatcher`, un seul matcher mot-clé fourni. Ajouter un matcher IA (ex: Claude API) ici sans toucher au reste.
- `src/services/webhookDispatcher.ts` : webhooks sortants signés HMAC (header `X-Signature-256`) sur les événements `ticket.created`, `ticket.closed`, `monitoring.shift`, `monitoring.recruitment`, `monitoring.safe`, `monitoring.invoice`, `monitoring.sale` — point de branchement générique pour un CRM/site externe. Gérés depuis le panneau "Monitoring" (aucun accès DB nécessaire).

## À vérifier sur le vrai serveur

Le signal de fermeture de ticket diffère selon la configuration Ticket Tool (suppression du canal, renommage avec un préfixe, ou déplacement de catégorie). Le bot couvre la suppression (`channelDelete`) et un renommage avec préfixe `closed-`/`ferme-` (`channelUpdate`, voir `src/events/channelUpdate.ts`) — à ajuster une fois observé en conditions réelles.

Le parsing des logs de Monitoring (`src/services/monitoringParsers.ts`) est basé sur 5 exemples réels fournis par l'utilisateur, vérifiés au mot près — mais pas exhaustif de toutes les variantes possibles (ex: autres formulations de licenciement, autres types de log FiveM non capturés). Si un log n'est pas reconnu, il est quand même conservé brut (`MonitoringEvent`) et un avertissement est loggué : vérifier les logs du bot en cas de log de Monitoring qui ne déclenche pas l'effet attendu. De même, l'identification d'un coffre par sa `targetPosition` (position fixe du coffre, distincte de la position du joueur) suppose que le même coffre physique émet toujours exactement la même valeur — à confirmer en conditions réelles.
