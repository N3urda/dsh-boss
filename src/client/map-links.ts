import transform from 'coordtransform';

/** Display conversion only. Stored locations remain WGS84; these approximate points are not survey data. */
export function baiduPoint(point: { lat: number; lng: number }) {
  const gcj = transform.wgs84togcj02(point.lng, point.lat);
  const bd = transform.gcj02tobd09(...gcj);
  return { lng: bd[0], lat: bd[1] };
}
/** Baidu URI's wgs84/gcj02 redirect currently returns invalid coordinates. Supply BD09 explicitly. */
export function baiduMapUrl(input: {
  city?: string;
  address?: string;
  title?: string;
  point?: { lat: number; lng: number };
}) {
  const query = new URLSearchParams({ output: 'html', src: 'webapp.dsh.boss' });
  if (input.point) {
    const point = baiduPoint(input.point);
    query.set('location', `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`);
    query.set('coord_type', 'bd09ll');
    query.set('zoom', '16');
    query.set('title', input.title || '办公地点');
    query.set('content', input.address || input.title || '已确认位置');
    return `https://api.map.baidu.com/marker?${query}`;
  }
  query.set('address', [input.city || '西安', input.address].filter(Boolean).join(' '));
  return `https://api.map.baidu.com/geocoder?${query}`;
}
