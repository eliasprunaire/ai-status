#!/bin/sh
# Déclenche le workflow « collect » sur main. À lancer depuis un cron toutes les 5 minutes,
# le cron intégré à GitHub Actions étant retardé ou ignoré en cas de charge.
# GH_TOKEN : jeton à granularité fine, limité à ce dépôt, droit « Actions : lecture et écriture ».
set -eu

: "${GH_TOKEN:?GH_TOKEN requis}"
api="${GH_API_URL:-https://api.github.com}"
repo="${GH_REPO:-eliasprunaire/ai-status}"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
  -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  -d '{"ref":"main"}' \
  "${api}/repos/${repo}/actions/workflows/collect.yml/dispatches")

if [ "${code}" != "204" ]; then
  echo "dispatch refusé : HTTP ${code}" >&2
  exit 1
fi
