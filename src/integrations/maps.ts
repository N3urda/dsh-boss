import { z } from 'zod';
import { RecordError } from '../records/schema.js';
import { pointSchema, type PlaceCandidate } from './schema.js';

const featureSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      geometry: z.object({
        type: z.literal('Point'),
        coordinates: z.tuple([z.number(), z.number()]),
      }),
      properties: z
        .object({
          osm_id: z.number().int().positive(),
          osm_type: z.enum(['N', 'W', 'R']),
          name: z.string().optional(),
          country: z.string().optional(),
          state: z.string().optional(),
          city: z.string().optional(),
          district: z.string().optional(),
          street: z.string().optional(),
          housenumber: z.string().optional(),
          type: z.string().optional(),
        })
        .passthrough(),
    }),
  ),
});
export function parsePlaces(raw: unknown): PlaceCandidate[] {
  const payload = featureSchema.safeParse(raw);
  if (!payload.success)
    throw new RecordError('MAP_BAD_RESPONSE', '地点服务返回格式变化，未保存任何坐标。');
  return payload.data.features.slice(0, 6).map((f) => ({
    id: `${f.properties.osm_type}${f.properties.osm_id}`,
    label: [
      ...new Set(
        [
          f.properties.name,
          f.properties.street,
          f.properties.housenumber,
          f.properties.district,
          f.properties.city,
          f.properties.state,
          f.properties.country,
        ].filter(Boolean),
      ),
    ].join(' · '),
    point: pointSchema.parse({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }),
    precision: ['house', 'building'].includes(f.properties.type ?? '')
      ? ('building' as const)
      : ('area' as const),
    provider: 'photon' as const,
    crs: 'WGS84' as const,
    sourceUrl: `https://www.openstreetmap.org/${{ N: 'node', W: 'way', R: 'relation' }[f.properties.osm_type]}/${f.properties.osm_id}`,
  }));
}
export class MapsAdapter {
  private lastRequest = 0;
  private running = false;
  constructor(
    private fetcher: typeof fetch = fetch,
    private endpoint = process.env.DSH_BOSS_PHOTON_URL || 'https://photon.komoot.io/api/',
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Photon endpoint must be HTTPS without credentials');
  }
  async search(address: string, city: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.running || Date.now() - this.lastRequest < 1100)
      throw new RecordError('MAP_BUSY', '地点查询较频繁，请稍后再试。');
    this.running = true;
    this.lastRequest = Date.now();
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set('q', `${city} ${address}`.trim());
      url.searchParams.set('limit', '6');
      const response = await this.fetcher(url, {
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        redirect: 'error',
        headers: {
          'User-Agent': 'dsh-boss/0.2.4 personal-career-workbench',
          Accept: 'application/json',
        },
      });
      if (!response.ok)
        throw new RecordError('MAP_UNAVAILABLE', '地点查询暂不可用，仍可在地图上手动选点。');
      const body = await response.text();
      if (body.length > 512000) throw new Error('Response too large');
      return parsePlaces(JSON.parse(body));
    } catch (e) {
      if (e instanceof RecordError) throw e;
      throw new RecordError(
        signal?.aborted ? 'CANCELLED' : 'MAP_UNAVAILABLE',
        '地点查询取消、超时或网络不可用，仍可手动选点。',
      );
    } finally {
      this.running = false;
    }
  }
}
