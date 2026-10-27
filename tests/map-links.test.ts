import test from 'node:test';
import assert from 'node:assert/strict';
import { baiduMapUrl, baiduPoint } from '../src/client/map-links.js';
test('Baidu official URI preserves address text and converts stored WGS84 to explicit BD09 for markers', () => {
  const address = '软件新城 & A 座';
  const query = new URL(baiduMapUrl({ city: '西安', address }));
  assert.equal(query.origin, 'https://api.map.baidu.com');
  assert.equal(query.pathname, '/geocoder');
  assert.equal(query.searchParams.get('address'), `西安 ${address}`);
  assert(!query.searchParams.has('ak'));
  const marker = new URL(baiduMapUrl({ point: { lat: 34.25, lng: 108.9 }, title: '<公司>' }));
  assert.equal(marker.pathname, '/marker');
  assert.equal(marker.searchParams.get('coord_type'), 'bd09ll');
  const point = marker.searchParams.get('location')!.split(',').map(Number);
  assert(point[0] > 34.25 && point[0] < 34.27);
  assert(point[1] > 108.9 && point[1] < 108.92);
  // Independent published reference: coordtransform README's WGS84 -> GCJ02 example.
  const beijing = baiduPoint({ lng: 116.404, lat: 39.915 });
  assert(Math.abs(beijing.lng - 116.416627) < 0.000002);
  assert(Math.abs(beijing.lat - 39.9227) < 0.000002);
  assert.equal(marker.searchParams.get('title'), '<公司>');
});
