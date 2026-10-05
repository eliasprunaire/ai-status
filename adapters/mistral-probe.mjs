import { fail, HttpError } from '../lib/errors.mjs';
import { mistralCompletion, MISTRAL_PROBE_MODEL } from '../lib/http.mjs';
import { validateStatusDocument } from '../public/status-contract.js';

export const METHOD = { fr: 'test de génération via API Mistral', en: 'generation test via Mistral API' };

const COMPONENT = `Ministral 3 3B (${MISTRAL_PROBE_MODEL})`;

// Réutilise l'observation publiée si elle est saine et plus récente que reuse.maxAgeMinutes :
// la sonde est facturée, la page n'a pas besoin d'un nouvel appel à chaque collecte.
// Tout doute (lecture impossible, document invalide, échec, dégradation, heure incohérente)
// renvoie null : on sonde alors comme avant
async function publishedProbe(provider, get, now = Date.now()) {
  const reuse = provider.source.reuse;
  if (!reuse) return null;
  try {
    // Paramètre unique : le CDN de la page garde les réponses plusieurs minutes
    const previous = await get(`${reuse.url}?t=${now}`);
    if (!validateStatusDocument(previous)) return null;
    const entry = previous.providers.find((p) => p.id === provider.id);
    const age = now - Date.parse(entry?.collectedAt);
    const [component] = entry?.components ?? [];
    if (!entry || !(age >= 0 && age < reuse.maxAgeMinutes * 60_000)) return null;
    if (entry.collect.state !== 'ok' || entry.collect.method !== provider.source.kind || entry.status !== 'operationnel') return null;
    if (entry.components.length !== 1 || component.name !== COMPONENT || component.status !== 'operationnel') return null;
    if (entry.incidents.length || entry.maintenances.length) return null;
    return {
      indicator: null,
      components: [{ name: COMPONENT, status: 'operationnel' }],
      incidents: [],
      maintenances: [],
      note: entry.collect.error,
      noteEn: entry.collect.errorEn,
      collectedAt: entry.collectedAt,
    };
  } catch {
    return null;
  }
}

export async function collect(provider = { source: {} }, get = null) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw fail('unavailable', 'Sonde inactive : clé API Mistral non configurée', 'Probe inactive: Mistral API key not configured');
  const published = get ? await publishedProbe(provider, get) : null;
  if (published) return published;
  let status = 'operationnel';
  let note = 'Génération réussie sur Ministral 3 3B. Les autres modèles et services ne sont pas testés.';
  let noteEn = 'Generation succeeded on Ministral 3 3B. Other models and services are not tested.';
  try {
    const doc = await mistralCompletion(apiKey);
    const choice = doc?.choices?.[0];
    if (doc?.model !== MISTRAL_PROBE_MODEL || !Array.isArray(doc.choices) || doc.choices.length !== 1 || choice?.finish_reason !== 'stop' || choice.message?.role !== 'assistant' || typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
      throw fail('schema', 'Génération Mistral vide, incomplète ou modèle inattendu', 'Empty or incomplete Mistral generation, or unexpected model');
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status < 500 || error.status > 599) {
      const reason = [401, 403].includes(error.status) ? ['authentification ou accès refusé', 'authentication or access denied'] : error.status === 429 ? ['quota ou limite de requêtes', 'quota or rate limit'] : ['requête refusée', 'request rejected'];
      throw fail('unavailable', `Sonde non vérifiée : ${reason[0]} (HTTP ${error.status})`, `Probe unverified: ${reason[1]} (HTTP ${error.status})`);
    }
    status = 'degradation';
    note = `Échec de la sonde de génération (HTTP ${error.status}). Observation ponctuelle, pas un incident officiel Mistral.`;
    noteEn = `Generation probe failed (HTTP ${error.status}). A single observation, not an official Mistral incident.`;
  }
  return { indicator: null, components: [{ name: COMPONENT, status }], incidents: [], maintenances: [], note, noteEn };
}
