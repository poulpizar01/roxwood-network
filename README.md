# Roxwood Network

Bot Discord (Node.js + TypeScript + discord.js + Prisma/PostgreSQL) qui ajoute une sur-couche a Ticket Tool pour des serveurs GTA RP, sur deux usages :

- **Recrutement** : formulaire de candidature (bouton -> modal) rempli par le candidat des l'ouverture du ticket, suivi pilote par le staff via des boutons (pas de commande a taper) dans un salon de suivi dedie.
- **Service client** : catalogue de produits/services (photo + champs personnalises par article, configure par le staff), commande composee **par le client lui-meme** (menu deroulant + formulaire), le staff n'a qu'a confirmer le paiement — ce qui genere automatiquement une facture en image.

Plus les fonctions generiques de la base : priorites/tags, escalade automatique, reponses automatiques par mot-cle (FAQ), demandes d'absence, webhooks sortants pour brancher des systemes externes.

Ticket Tool n'a pas d'API publique : la detection se fait en ecoutant les evenements Discord (creation/suppression/renommage de canal dans la categorie configuree, associee a un type Recrutement ou Service via le **panneau d'administration**, voir plus bas).

**Quasiment toute la configuration passe par le panneau d'administration** (messages permanents avec boutons, edites en place) plutot que par des commandes slash — beaucoup plus intuitif que de devoir connaitre/taper des commandes. Il ne reste que quelques commandes slash pour ce qui n'a pas encore rejoint le panneau, plus `/absence` qui est volontairement une commande (accessible a tout le monde, pas un bouton dans un salon potentiellement invisible aux non-staff).

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

## Panneau d'administration

`/config set-panel-channel <channel>` designe un salon (staff/admin uniquement cote permissions Discord) qui accueille le **message racine** du panneau : 3 boutons, **Tickets**, **Absences**, **FAQ**. Cliquer un bouton active la fonctionnalite et poste (ou met a jour) un **message dedie** dans le meme salon, edite en place a chaque changement plutot que reposte.

- **Tickets** : gestion des roles de gestion par categorie de ticket ("Ajouter/Retirer un role de gestion" — chaque categorie a sa propre equipe, plus de role staff global unique), plus deux boutons qui ouvrent les messages dedies imbriques **Service client** et **Recrutement** (dans le meme salon).
- **Service client** : bouton "Definir/Retirer la categorie" (libelle selon l'etat courant), puis gestion du catalogue — ajouter/retirer un article, changer sa photo (envoyee en message juste apres, les modals Discord ne supportent pas l'upload de fichier), ajouter/retirer un champ personnalise par article.
- **Recrutement** : bouton "Definir/Retirer la categorie", bouton "Ouvrir/Fermer les recrutements" (meme principe, libelle dynamique), et gestion des questions du formulaire de candidature (max 5, style texte court/long) — si aucune n'est configuree, repli automatique sur 5 questions par defaut (Nom RP, Age, Experience RP, Disponibilites, Motivation).
- **Absences** : configuration du role approbateur et du salon de suivi des demandes (voir section Absences plus bas).
- **FAQ** : gestion des regles de reponse automatique mot-cle -> reponse.
- **Monitoring** : lecture des logs webhook du script FiveM (voir section Monitoring plus bas).

Chaque message dedie (sauf le message racine) porte une reaction 🗑️ posee automatiquement : cliquer dessus le supprime et reinitialise sa reference en base — recliquer le bouton parent (racine, ou "Tickets" pour Service/Recrutement) le reposte tout neuf. Le message racine n'a jamais cette reaction : c'est le seul point d'entree vers tout le reste, il ne doit pas pouvoir etre supprime par erreur.

## Commandes slash restantes

- `/config set-panel-channel <channel>` — salon du panneau d'administration (voir ci-dessus).
- `/config set-escalation-timeout <minutes>` — delai avant qu'un ticket sans reponse staff declenche une escalade (0 = desactive).
- `/config set-recruitment-channel [channel]` — salon dedie ou poster le suivi des candidatures (recap + boutons), pour ne pas encombrer le salon du ticket partage avec le candidat. Sans salon configure, le recap est poste dans le salon du ticket lui-meme.
- `/absence` — declare une absence (accessible a tout le monde, voir section Absences).
- `/stock [coffre]` — consulte le stock d'un coffre d'entreprise, ou le stock total (accessible a tout le monde, voir section Monitoring).
- `/ticket info` / `/ticket priority <level>` / `/ticket tag add|remove <tag>`.
- `/stats overview` — tickets ouverts/fermes/escalades, temps de reponse moyen.

`/catalog`, `/recruitment status` et `/autoreply` n'existent plus : entierement remplaces par le panneau d'administration.

## Recrutement

A l'ouverture d'un ticket dans la categorie Recrutement (et si les recrutements sont ouverts, voir panneau "Recrutement"), le bot poste un bouton "Remplir le formulaire" qui ouvre un modal Discord avec les questions configurees (ou les 5 par defaut). A la soumission, le candidat recoit une confirmation qui l'invite aussi a envoyer d'eventuelles photos/documents **directement en message** dans le salon : le bot les rattache automatiquement a la candidature.

Un recap (candidat, statut, recruteur, reponses, pieces jointes) est poste dans le salon de suivi (`/config set-recruitment-channel`, ou le salon du ticket par defaut) avec deux boutons :

- **Statut** — ouvre un menu deroulant ephemere (En attente / Entretien / Accepte / Refuse) ; le message de suivi se met a jour automatiquement. Passer une candidature a **Refuse** marque aussi le ticket comme clôturé côté suivi (arrête l'escalade, sort des stats "ouverts") et prévient le staff dans le salon qu'il peut le fermer via le bouton "Close" de Ticket Tool. La fermeture automatisée a été testée (message direct du bot, puis via webhook de salon) et abandonnée : Ticket Tool ignore tout message qui ne vient pas d'un vrai humain, et un bot ne peut de toute façon pas cliquer le bouton d'un autre bot à sa place (limite Discord). C'est pour ça que le bot ne supprime jamais les messages d'un autre bot qui portent un bouton/menu (voir plus bas) : celui de Ticket Tool doit rester cliquable.
- **S'assigner** — assigne directement le membre du staff qui clique comme recruteur (reassignation possible).

Ces boutons (et ceux du panneau "Tickets"/"Service client"/"Recrutement") sont reserves aux roles de gestion de la categorie concernee (panneau "Tickets" → "Ajouter un role de gestion") : un clic par quelqu'un d'autre est refuse avec un message explicite. `/ticket info`, execute dans le salon du ticket, affiche aussi le statut de la candidature et le recruteur assigne.

Le bot supprime aussi automatiquement, dans tout ticket suivi, les messages purement informatifs postes par d'autres bots pour garder le salon propre — mais jamais un message qui porte un bouton ou un menu (typiquement le message de bienvenue de Ticket Tool avec son bouton "Close"), pour ne pas priver le staff de sa seule vraie méthode de fermeture. Necessite que le role du bot ait la permission Discord **"Gerer les messages"** sur le serveur ; sans elle, la suppression echoue silencieusement (juste loggee).

## Service client (catalogue + commande self-service)

Le staff configure le catalogue via le panneau "Service client", le **client compose sa commande lui-meme** dans le ticket, et un seul message de commande est édité en place tout au long du cycle (composition → validation → suivi) plutôt que reposté a chaque fois :

1. Panneau "Service client" → "Ajouter un article" (modal nom/prix/description) → "Changer la photo d'un article" (envoyee en message juste apres, les modals ne supportent pas l'upload).
2. "Ajouter un champ" — jusqu'a 5 champs par article, a remplir par le client lors de la commande (ex: date + nombre d'invites pour une salle, quantite + boisson pour un menu). Le style `Quantite` alimente automatiquement le calcul du prix ; les autres styles (`Texte court`/`Texte long`) sont juste enregistres et affiches sur la facture.
3. A l'ouverture d'un ticket Service, le bot poste un menu deroulant du catalogue actif. Le client choisit un article -> un formulaire genere a partir des champs configures s'ouvre -> il peut ajouter d'autres articles -> "Valider la commande" ping les roles de gestion de la categorie.
4. Cote staff, directement sur le message de commande : **Statut** (menu deroulant), **Marquer payée** (bascule le paiement et **genere/poste automatiquement l'image de facture**), **Facture** (renvoie l'image), **Ajouter un article** (reutilise le menu du client), **Retirer un article** (menu des lignes existantes) — pour des corrections manuelles exceptionnelles. Boutons reserves aux roles de gestion de la categorie.

## Absences

Panneau "Absences" → configurer le **role approbateur** et le **salon de suivi** (separe du salon panneau). Une fois les deux definis, n'importe quel membre peut declarer une absence avec `/absence` (dates JJ/MM/AAAA + motif). La demande est postee dans le salon de suivi avec deux boutons **Accepter**/**Refuser**, reserves au role approbateur ; le message se met a jour en place (statut, qui a traite) une fois resolue.

## FAQ (reponses automatiques)

Panneau "FAQ" → "Ajouter une règle" (modal mot-clé/réponse) / "Retirer une règle". Declenchee quand le client ayant ouvert un ticket ecrit un message contenant le mot-cle (recherche simple, insensible a la casse).

## Monitoring (logs webhook FiveM)

Le script FiveM du serveur poste des logs d'activite en jeu (embeds webhook) dans des salons dedies : prise/fin de service, recrutements/licenciements, mouvements de coffre d'entreprise, factures, ventes. Le panneau "Monitoring" configure :

- **Entreprise (jobId)** : chaque guilde ne surveille qu'**une seule entreprise** — tout log dont le `jobId` ne correspond pas est completement ignore (le serveur FiveM melange plusieurs entreprises dans les memes salons).
- **Rôle "en service"** : ajoute au membre a la prise de service, retire a la fin de service.
- **Un salon par type de log** (Prise de service / Recrutement / Coffre / Facture / Vente run) : bouton "Salon <type>" (libelle dynamique Definir/Retirer selon l'etat courant).
- **Webhooks sortants** : "Ajouter un webhook" (choisir le type d'evenement → URL de destination) genere un secret affiche **une seule fois**, a noter pour verifier la signature HMAC-SHA256 (header `X-Signature-256`) cote recepteur — meme mecanisme que les webhooks `ticket.*` existants (voir Points d'extension).

Effets automatiques :
- **Prise de service** : bascule le role "en service" du membre concerne.
- **Recrutement** (embauche uniquement) : si un ticket de candidature existe pour ce joueur (`Ticket.openerId` = `targetPlayerDiscord` du log), passe son statut a **Accepté** et met a jour le message de suivi. Licenciements et changements de grade sont journalises mais sans effet automatique pour l'instant.
- **Coffre** : chaque depot/retrait alimente un ledger par coffre (identifie par sa position), interrogeable avec `/stock`.
- **Facture / Vente run** : journalises pour les statistiques (montant, taxes, quantites) et relayes par webhook sortant — aucun effet automatique.

Tout log recu (que le texte libre de sa description ait pu etre parse ou non) est conserve en base (`MonitoringEvent`) et jamais perdu — un format de description inattendu desactive juste l'effet automatique correspondant (avertissement logge), le reste continue de fonctionner.

## Points d'extension

- `src/services/autoReplyService.ts` : interface `AutoReplyMatcher`, un seul matcher mot-cle fourni. Ajouter un matcher IA (ex: Claude API) ici sans toucher au reste.
- `src/services/webhookDispatcher.ts` : webhooks sortants signes HMAC (header `X-Signature-256`) sur les evenements `ticket.created`, `ticket.closed`, `ticket.escalated`, `monitoring.shift`, `monitoring.recruitment`, `monitoring.safe`, `monitoring.invoice`, `monitoring.sale` — point de branchement generique pour un CRM/site externe. Geres depuis le panneau "Monitoring" (aucun acces DB necessaire).

## A verifier sur le vrai serveur

Le signal de fermeture de ticket differe selon la configuration Ticket Tool (suppression du canal, renommage avec un prefixe, ou deplacement de categorie). Le bot couvre la suppression (`channelDelete`) et un renommage avec prefixe `closed-`/`ferme-` (`channelUpdate`, voir `src/events/channelUpdate.ts`) — a ajuster une fois observe en conditions reelles.

Le parsing des logs de Monitoring (`src/services/monitoringParsers.ts`) est base sur 5 exemples reels fournis par l'utilisateur, verifies au mot pres (voir tests inline dans l'historique de dev) — mais pas exhaustif de toutes les variantes possibles (ex: autres formulations de licenciement, autres types de log FiveM non captures). Si un log n'est pas reconnu, il est quand meme conserve brut (`MonitoringEvent`) et un avertissement est loggue : verifier les logs du bot en cas de log de Monitoring qui ne declenche pas l'effet attendu. De meme, l'identification d'un coffre par sa `targetPosition` (position fixe du coffre, distincte de la position du joueur) suppose que le meme coffre physique emet toujours exactement la meme valeur — a confirmer en conditions reelles.
