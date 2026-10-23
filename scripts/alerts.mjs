import { createHash } from 'node:crypto';

// Issues de surveillance, appelées par le job alert de collect.yml (seul job avec issues: write).
// Les textes viennent de pages tierces : traités comme données, aplatis, bornés, en code
// Une alerte de structure identique à la dernière signalée n'est jamais republiée : sa
// signature est gardée dans le corps de l'issue (la mémoire relue peut être périmée)
const PREFIX = '[surveillance]';
const MAX_TEXT = 300;

const flat = (value) => String(value ?? '').replace(/[\r\n`]/g, ' ').slice(0, MAX_TEXT);
const code = (value) => `\`${flat(value)}\``;

export const failingTitle = (alert) => `${PREFIX} ${flat(alert.name)} : non lu depuis plus d'une heure`;
export const structureTitle = (alert) => `${PREFIX} ${flat(alert.name)} : structure de la page modifiée`;

function failingBody(alert) {
  return [
    `Le fournisseur ${code(alert.id)} n'est plus lu depuis ${code(alert.since)}.`,
    '',
    `Dernière erreur : ${code(alert.error)}`,
    '',
    'Vérifier la page officielle et le résumé du dernier run collect. Cette issue se ferme seule quand la lecture reprend.',
  ].join('\n');
}

export function structureSignature(alert) {
  const canonical = JSON.stringify({ id: alert.id, added: [...alert.added].sort(), removed: [...alert.removed].sort() });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
const signatureOf = (body) => /<!-- signature:([0-9a-f]{16}) -->/.exec(body ?? '')?.[1] ?? null;

function structureBody(alert) {
  const list = (items) => (items.length ? items.map((n) => `- ${code(n)}`).join('\n') : '_aucun_');
  return [
    `Les composants publiés par la page de ${code(alert.id)} ont changé.`,
    '',
    `**Ajoutés**\n${list(alert.added)}`,
    '',
    `**Retirés**\n${list(alert.removed)}`,
    '',
    'Un ajout ou un retrait de modèle est souvent normal. Un renommage ou une réorganisation peut demander d’ajuster providers.json (requiredComponents, components, périmètre).',
    '',
    `<!-- signature:${structureSignature(alert)} -->`,
  ].join('\n');
}

export async function applyAlerts({ github, context, alerts }) {
  if (!Array.isArray(alerts) || alerts.length === 0) return [];
  const repo = context.repo;
  const open = (await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'open', per_page: 100 })).filter((issue) => !issue.pull_request);
  const find = (title) => open.find((issue) => issue.title === title);
  const done = [];
  for (const alert of alerts) {
    if (alert.type === 'recovered') {
      const issue = find(failingTitle(alert));
      if (!issue) continue;
      await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body: `Lecture rétablie pour ${code(alert.id)}.` });
      await github.rest.issues.update({ ...repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
      done.push(['closed', issue.number]);
      continue;
    }
    if (!['failing', 'structure'].includes(alert.type)) continue;
    const title = alert.type === 'failing' ? failingTitle(alert) : structureTitle(alert);
    const body = alert.type === 'failing' ? failingBody(alert) : structureBody(alert);
    const existing = find(title);
    if (existing) {
      // Une issue d'échec déjà ouverte suffit. Un changement de structure différent du dernier
      // signalé s'ajoute en commentaire et devient la référence ; identique, il est ignoré
      if (alert.type === 'structure' && signatureOf(existing.body) !== structureSignature(alert)) {
        await github.rest.issues.createComment({ ...repo, issue_number: existing.number, body });
        await github.rest.issues.update({ ...repo, issue_number: existing.number, body });
        existing.body = body;
        done.push(['commented', existing.number]);
      }
      continue;
    }
    const { data } = await github.rest.issues.create({ ...repo, title, body });
    open.push(data);
    done.push(['created', data.number]);
  }
  return done;
}
