<!-- style_gate: pass -->

# Contribuer à AI Status

## Signaler un problème

Ouvrir une [issue](https://github.com/eliasprunaire/ai-status/issues) avec le fournisseur concerné, le résultat attendu, le résultat affiché et l’heure de collecte. Joindre le lien de la source officielle si possible. Pour un problème d’affichage, préciser le navigateur et la langue utilisée.

Ne joindre aucune clé API, aucun cookie ni jeton de session.

## Préparer une modification

Créer une branche de travail et installer les outils :

```sh
npm ci
npx playwright install chromium
npm test
```

Le collecteur utilise Node.js 22 ou plus. Python 3 sert uniquement au serveur local (`npm run serve`). Les tests ne contactent pas les fournisseurs et n’ont pas besoin de clé Mistral.

## Corriger ou ajouter une source

- Déclarer le fournisseur dans [providers.json](providers.json), avec un identifiant stable et un périmètre explicite en français et en anglais
- Réutiliser un lecteur de [adapters/](adapters/) lorsqu’il couvre le format ; enregistrer tout nouveau lecteur dans [collect.mjs](collect.mjs)
- Conserver une réponse réduite dans [test/fixtures/](test/fixtures/), sans secret, avec son URL et sa date d’observation ; distinguer les scénarios synthétiques
- Vérifier dans [test/](test/) les états et événements concernés, ainsi que les réponses absentes ou incomplètes : une source illisible reste « Non vérifié »
- Mettre à jour le tableau du [README](README.md) si le fournisseur ou son périmètre change

Utiliser les sources officielles et le client HTTP existant. Respecter les limites d’accès et de taille, l’isolation des erreurs et le contrat JSON partagé. Une sonde sur un modèle ne décrit pas la santé de tout le fournisseur.

## Proposer la PR

Relancer `npm test`, puis décrire le problème, la correction et les vérifications effectuées. Pour l’interface, vérifier le français, l’anglais et la navigation au clavier.

Une collecte réelle (`npm run collect`) contacte les sources ; avec `MISTRAL_API_KEY`, elle consomme des tokens. Ne pas versionner `public/data/status.json`. Distinguer les tests simulés d’une collecte réussie : une CI verte ne prouve pas que chaque fournisseur a été lu.

Les PR exécutent les tests. La publication du site se fait depuis `main`.

## Planification de la collecte

Le cron de `collect.yml` (`7,37 * * * *`) ne tient pas sa cadence : GitHub l’exécute avec des retards de plusieurs heures. Il reste en secours. La cadence de 5 minutes vient d’un déclencheur externe qui appelle `workflow_dispatch` via `scripts/dispatch-collect.sh`.

1. Créer un jeton à granularité fine limité à ce dépôt, avec le seul droit **Actions : lecture et écriture**, et une expiration.
2. Le ranger hors du dépôt, lisible par son seul utilisateur (`chmod 600`).
3. Planifier le script, par exemple avec `crontab -e` :

```cron
*/5 * * * * GH_TOKEN="$(cat /etc/ai-status/gh-token)" /opt/ai-status/scripts/dispatch-collect.sh
```

Le script sort en erreur si GitHub ne répond pas `204`. Les exécutions se mettent en file (`concurrency`) : au plus une collecte en cours et une en attente. Chaque exécution rejoue les tests, puis collecte, puis déploie. La sonde Mistral, facturable, ne s’exécute qu’une fois par fenêtre de 30 minutes : les autres collectes reprennent l’observation publiée tant qu’elle est saine. Renouveler le jeton avant son expiration : sans lui, la page retombe sur le cron de secours et l’alerte « données obsolètes » s’affiche après 20 minutes.

## Versions

Utiliser des messages de commit [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/) : `fix:` et `perf:` déclenchent un correctif, `feat:` une version mineure. Avant `1.0.0`, une rupture signalée par `!` ou `BREAKING CHANGE:` déclenche une version mineure et figure dans les notes. Sans rupture, `docs:`, `test:`, `ci:` et `chore:` ne déclenchent pas seuls de release. Le passage à `1.0.0` demande une décision explicite ; le contrat JSON v2 garde sa numérotation indépendante.

Après les tests d’un push sur `main`, Release Please prépare une PR de version. La première proposera **0.1.2**, sans versions antérieures. Le robot synchronise le package, le verrouillage et son manifeste ; les notes restent dans GitHub Releases, sans fichier d’historique supplémentaire.

Les tests de cette PR sont déclenchés explicitement sur son commit, sans collecte ni clé Mistral. Après leur réussite, un mainteneur fusionne par **rebase**. Les tests sur `main` précèdent la création du tag et de la release, tous deux liés au commit testé. Ne pas modifier manuellement une release publiée.

GitHub peut aussi afficher **Approve workflows to run** sur une PR du robot. Un mainteneur doit approuver ce lancement : les tests déclenchés explicitement ne suffisent pas à satisfaire le contrôle obligatoire tant que cette approbation manque.

Si la publication échoue, relancer le workflow **collect** du commit concerné avec **Re-run jobs**. Un lancement manuel (`workflow_dispatch`) ne prépare ni ne publie de version. La reprise vérifie le tag existant et refuse toute divergence, sans créer de version de remplacement. La collecte et le déploiement restent indépendants de la publication des releases.

La métadonnée `public/build-info.js` est générée avec le site et n’est pas versionnée.

---

[Retour au README](README.md) · [Licence MIT](LICENSE)
