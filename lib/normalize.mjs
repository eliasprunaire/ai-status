// Normalisation des statuts bruts vers l'enum du site.
// Enum: operationnel | degradation | incident_majeur | maintenance | indisponible | inconnu
import { STATUS_VALUES, SEVERITY, worstOf, STATUS_LABELS, STATUS_LABELS_EN } from '../public/status-contract.js';

// Indicateur de page Statuspage (status.indicator)
const INDICATOR_MAP = {
  none: 'operationnel',
  minor: 'degradation',
  major: 'incident_majeur',
  critical: 'indisponible',
  maintenance: 'maintenance',
};

// État d'un composant Statuspage (components[].status)
const COMPONENT_MAP = {
  operational: 'operationnel',
  degraded_performance: 'degradation',
  partial_outage: 'degradation',
  major_outage: 'incident_majeur',
  under_maintenance: 'maintenance',
};

// Impact d'un incident Google Cloud (incidents.json, status_impact)
const GOOGLE_IMPACT_MAP = {
  SERVICE_OUTAGE: 'incident_majeur',
  SERVICE_DISRUPTION: 'degradation',
};

// Enum, gravité, worstOf et libellés vivent dans le contrat partagé avec la page ;
// ré-exportés ici pour les adaptateurs et les tests
export { SEVERITY, worstOf, STATUS_LABELS, STATUS_LABELS_EN };
export const STATUSES = STATUS_VALUES;

export function normalizeIndicator(indicator) {
  return INDICATOR_MAP[indicator] ?? 'inconnu';
}

export function normalizeComponentStatus(status) {
  return COMPONENT_MAP[status] ?? 'inconnu';
}

export function normalizeGoogleImpact(impact) {
  // Google classe parfois de vraies hausses d'erreurs en SERVICE_INFORMATION (Vertex Gemini API,
  // 27/02/2026) : un incident ouvert de ce type est affiché en dégradation, jamais ignoré
  return impact === 'SERVICE_INFORMATION' ? 'degradation' : GOOGLE_IMPACT_MAP[impact] ?? 'inconnu';
}

// « model » si le nom correspond au motif déclaré par le fournisseur (modelPattern
// dans providers.json) ; sinon « service ». Affichage seulement, jamais le statut
export function classifyKind(name, modelPattern) {
  return modelPattern && new RegExp(modelPattern, 'i').test(name) ? 'model' : 'service';
}
