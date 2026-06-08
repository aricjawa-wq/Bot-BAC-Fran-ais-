# 🎓 Bot Bac de Français 2026

Bot Discord pour préparer le Bac de Français 2026 — QCM interactifs, dissertation guidée, correction automatique.

-----

## Variables d’environnement à configurer sur Railway

|Variable        |Où la trouver                                                            |
|----------------|-------------------------------------------------------------------------|
|`DISCORD_TOKEN` |Discord Developer Portal → ton app → Bot → Reset Token                   |
|`GEMINI_API_KEY`|[aistudio.google.com](https://aistudio.google.com) → Get API Key         |
|`CLIENT_ID`     |Discord Developer Portal → ton app → General Information → Application ID|
|`GUILD_ID`      |Discord → Mode développeur ON → clic droit sur ton serveur → Copier l’ID |

-----

## Commandes disponibles

|Commande|Description                                                |
|--------|-----------------------------------------------------------|
|`/qcm`  |Lance un QCM interactif sur une œuvre au programme         |
|`/essay`|Génère une problématique et ouvre un thread de dissertation|
|`/end`  |Termine la dissertation et reçoit une correction détaillée |
|`/close`|Ferme le thread actuel                                     |

-----

## Structure du serveur Discord attendue

Pour que le `/qcm` lise le contenu de tes catégories, crée des catégories Discord avec ces noms (ou contenant ces mots) :

- `CAHIERS DE DOUAI` (ou `Douai`)
- `DISCOURS S.V.` (ou `DSV`)
- `LE MENTEUR` (ou `Menteur`)
- `EXPRESSION DE LA RAGE` (ou `Ponge`)
- `LA PEAU DE CHAGRIN` (ou `Chagrin`)

Place des salons texte dans chaque catégorie avec tes notes de cours, résumés, analyses.

-----

## Déploiement sur Railway

1. Crée un compte sur [railway.app](https://railway.app)
1. New Project → Deploy from GitHub repo
1. Connecte ton repo GitHub contenant ces fichiers
1. Dans ton projet Railway → Variables → ajoute les 4 variables ci-dessus
1. Le bot démarre automatiquement ✅

-----

## Permissions Discord requises

Dans le Developer Portal → OAuth2 → URL Generator :

- Scopes : `bot`, `applications.commands`
- Permissions : `Read Messages`, `Send Messages`, `Manage Threads`, `Create Public Threads`, `Read Message History`, `Embed Links`, `Attach Files`