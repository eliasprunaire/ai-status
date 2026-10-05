<!-- style_gate: pass -->

<div align="center">

<img src="docs/logo.svg" width="96" height="96" alt="Logo AI Status : une grille de neuf états de service">

# AI Status

**L’état des fournisseurs IA, sur une seule page.**

23 fournisseurs · Français / English · GitHub Pages

[Ouvrir le tableau de bord](https://status.librenet.fr/) · [Signaler un problème](https://github.com/eliasprunaire/ai-status/issues)

[![Tests, collecte et publication](https://github.com/eliasprunaire/ai-status/actions/workflows/collect.yml/badge.svg?branch=main)](https://github.com/eliasprunaire/ai-status/actions/workflows/collect.yml)
[![Node.js ≥ 22](https://img.shields.io/badge/Node.js-%E2%89%A5_22-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Python 3 · serveur local](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)](#lancer-en-local)
[![Dernière release](https://img.shields.io/github/v/release/eliasprunaire/ai-status)](https://github.com/eliasprunaire/ai-status/releases/latest)

</div>

---

## Ce que propose la page

- Les états, incidents et maintenances des fournisseurs IA et clouds d’inférence
- Une recherche, des filtres par état et un tri par nom ou gravité
- Le détail des modèles et services suivis, avec les sources et l’heure de collecte
- Une interface bilingue, utilisable au clavier, avec thème clair ou sombre

## Comprendre les statuts

La page regroupe les informations publiées par les sources officielles. Une source illisible apparaît **« Non vérifié »**. Chaque carte précise le périmètre couvert ; « Opérationnel » ne garantit pas la disponibilité de tous les services d’un fournisseur.

Les 23 fournisseurs référencés, avec leur périmètre et leur méthode de collecte :

| Fournisseur | Ce qui est suivi | Collecte |
|---|---|---|
| [Anthropic](https://status.claude.com) | Claude API, claude.ai et Claude Code | Statuspage |
| [OpenAI](https://status.openai.com) | API, ChatGPT et Codex | Statuspage |
| [xAI](https://status.x.ai) | API, Grok et applications | Flux RSS officiel |
| [Google Cloud (Vertex AI / Gemini)](https://status.cloud.google.com) | Produits Vertex AI et Gemini, toutes régions | Flux JSON officiels |
| [Cursor](https://status.cursor.com) | Client Cursor et modèles hébergés | Statuspage |
| [Perplexity](https://status.perplexity.com) | Website, App et Computer ; API non couverte | incident.io |
| [Mistral AI](https://status.mistral.ai) | Génération sur **Ministral 3 3B** uniquement | Sonde API authentifiée |
| [Alibaba Cloud](https://status.alibabacloud.com) | Cloud global ; pas Qwen ou Model Studio en particulier | API publique |
| [DeepSeek](https://status.deepseek.com) | API par modèle | Flashcat |
| [Kimi / Moonshot AI](https://status.moonshot.cn) | Kimi, plateforme ouverte et modèles | Statuspage |
| [GLM / Zhipu AI](https://status.zhipuai.cn) | GLM / BigModel | Non vérifié : source inaccessible depuis la CI |
| [MiniMax](https://status.minimaxi.com) | API LLM, voix et vidéo | Statuspage |
| [Tencent Hunyuan](https://status.cloud.tencent.com) | LLM, image, vidéo, 3D et agents | API publique |
| [ByteDance / Doubao (Volcengine Ark)](https://status.volcengine.com) | Plateforme Ark servant Doubao, par région | Flux RSS officiels |
| [Baidu ERNIE](https://cloud.baidu.com/product-s/qianfan_home) | Qianfan / modèles ERNIE | Non vérifié : aucune source publique identifiée |
| [Groq](https://groqstatus.com) | API et modèles hébergés | Statuspage |
| [Replicate](https://www.cloudflarestatus.com/services?search=replicate) | Statut global publié par Cloudflare ; sans détail API/GPU | Statuspage filtré |
| [Cohere](https://status.cohere.com) | API et modèles | Statuspage |
| [Fireworks AI](https://status.fireworks.ai) | Modèles hébergés | Statuspage |
| [Together AI](https://status.together.ai) | Site, Playground et modèles | Better Stack |
| [OpenRouter](https://status.openrouter.ai) | API Gateway et Web & Application Services | Datadog |
| [AWS Bedrock](https://health.aws.amazon.com/health/status) | Amazon Bedrock par région ; autres services AWS exclus | Flux JSON publics |
| [Microsoft Azure AI](https://azure.status.microsoft/en-us/status) | Services IA, toutes régions ; incidents à large impact uniquement | Tableau HTML officiel |

La collecte vise une exécution toutes les 5 minutes, déclenchée par un cron externe (voir [Planification de la collecte](CONTRIBUTING.md#planification-de-la-collecte)). Le cron intégré à GitHub Actions reste en secours, mais il est souvent retardé de plusieurs heures. La page relit les données publiées toutes les 2 minutes et affiche l’heure de la dernière collecte avec son âge ; une alerte apparaît lorsque cette collecte a plus de 20 minutes.

## Lancer en local

Prérequis : **Node.js 22 ou plus** et **Python 3** pour le serveur local.

```sh
npm ci
npm run collect
npm run serve
```

Ouvrir ensuite [localhost:8080](http://localhost:8080).

La sonde Mistral utilise la variable d’environnement `MISTRAL_API_KEY`. Sans clé, les autres collectes fonctionnent et Mistral reste non vérifié. Ne pas enregistrer la clé dans le dépôt. La sonde effectue au plus un appel facturable à `ministral-3b-2512` toutes les 30 minutes, limité à 8 tokens de sortie, sans nouvelle tentative automatique : tant que la dernière observation publiée est saine et a moins de 30 minutes, la collecte la reprend avec son heure d’origine (`source.reuse` dans `providers.json`). Un échec, une dégradation ou un document illisible déclenchent une nouvelle sonde. Voir les [tarifs Mistral](https://mistral.ai/pricing/api/).

Pour lancer les tests, sans appel aux fournisseurs :

```sh
npx playwright install chromium
npm test
```

## Publier avec GitHub Pages

Dans **Settings → Pages**, choisir **GitHub Actions** comme source. Ajouter `MISTRAL_API_KEY` aux secrets Actions du dépôt pour activer la sonde Mistral ; la clé reste dans la collecte et n’est jamais envoyée à la page publique.

Les PR lancent les tests. Sur `main`, le workflow teste, collecte et publie la page avec ses données. Un lancement manuel sur une autre branche permet de vérifier la collecte sans déployer. Le fichier généré `public/data/status.json` n’est pas versionné.

Le pied de page indique la version du code et son commit. Les [notes de version](https://github.com/eliasprunaire/ai-status/releases) sont publiées sur GitHub ; une collecte périodique ne change pas la version. Le processus SemVer est décrit dans le [guide de contribution](CONTRIBUTING.md#versions).

## Contribuer

Pour signaler un problème, corriger une collecte ou ajouter un fournisseur, consulter le [guide de contribution](CONTRIBUTING.md).

---

<div align="center">

[Licence MIT](LICENSE) · [Tableau de bord](https://status.librenet.fr/) · [Signaler un problème](https://github.com/eliasprunaire/ai-status/issues)

</div>
