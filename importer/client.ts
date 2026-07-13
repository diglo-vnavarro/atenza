// Cliente de la API v3 de ServiceDesk Plus Cloud.
// Auth: OAuth 2.0 de Zoho (header `Authorization: Zoho-oauthtoken <token>`).
// Parámetros: JSON-encoded en el query param `input_data`. Paginación: list_info.
//
// El token se pasa por variable de entorno (SDP_OAUTH_TOKEN). Ver README.

export interface SdpConfig {
  /** p. ej. https://digloitsm.sdpondemand.manageengine.eu/app/itdesk */
  base: string;
  token: string;
  /** cabecera Accept específica de SDP (algunas instancias la requieren). */
  accept?: string;
}

export function configFromEnv(): SdpConfig {
  const base = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
  const token = process.env.SDP_OAUTH_TOKEN ?? '';
  if (!token) throw new Error('Falta SDP_OAUTH_TOKEN (token OAuth de Zoho). Ver importer/README.md');
  return { base, token, accept: process.env.SDP_ACCEPT };
}

/** Endpoints v3 (nombres estándar; ajústalos si tu instancia difiere). */
export const ENDPOINTS = {
  templates: 'request_templates',
  categories: 'categories',
  slas: 'slas',
  groups: 'groups',
  technicians: 'technicians',
  requesters: 'requesters',
  priorities: 'priorities',
  statuses: 'statuses',
  sites: 'sites',
} as const;

function url(cfg: SdpConfig, resource: string, listInfo: object): string {
  const input = encodeURIComponent(JSON.stringify({ list_info: listInfo }));
  return `${cfg.base}/api/v3/${resource}?input_data=${input}`;
}

/** Trae TODAS las páginas de un recurso y devuelve el array crudo. */
export async function fetchAll(cfg: SdpConfig, resource: string, key = resource): Promise<unknown[]> {
  const out: unknown[] = [];
  let start = 0; const rows = 100;
  for (let page = 0; page < 200; page++) {
    const res = await fetch(url(cfg, resource, { row_count: rows, start_index: start, get_total_count: true }), {
      headers: {
        Authorization: `Zoho-oauthtoken ${cfg.token}`,
        Accept: cfg.accept ?? 'application/vnd.manageengine.sdp.v3+json',
      },
    });
    if (!res.ok) throw new Error(`${resource}: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    const json = (await res.json()) as Record<string, unknown>;
    const arr = (json[key] as unknown[]) ?? [];
    out.push(...arr);
    const li = json.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows;
  }
  return out;
}
