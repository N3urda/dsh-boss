import React, { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import leafletCss from 'leaflet/dist/leaflet.css';
import type { CareerRecord } from '../records/schema.js';
import type { PlaceCandidate } from '../integrations/schema.js';
import type { WorkbenchStore } from './store.js';
import { baiduMapUrl } from './map-links.js';

export function MapPanel({
  store,
  records,
  selected,
  onSelect,
}: {
  store: WorkbenchStore;
  records: CareerRecord[];
  selected?: CareerRecord;
  onSelect: (id: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map>(),
    pins = useRef<L.LayerGroup>(),
    preview = useRef<L.CircleMarker>();
  const [picking, setPicking] = useState(false),
    [point, setPoint] = useState<{ lng: number; lat: number }>();
  const [precision, setPrecision] = useState<'building' | 'area'>('area');
  const [candidates, setCandidates] = useState<PlaceCandidate[]>([]),
    [candidate, setCandidate] = useState<PlaceCandidate>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tileError, setTileError] = useState(false),
    [searched, setSearched] = useState(false);
  const context = useRef({ picking, selected, onSelect });
  context.current = { picking, selected, onSelect };
  useEffect(() => {
    const instance = L.map(element.current!, {
      scrollWheelZoom: false,
      attributionControl: true,
    }).setView([34.2658, 108.9541], 11);
    map.current = instance;
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(instance);
    tiles.on('tileerror', () => setTileError(true));
    pins.current = L.layerGroup().addTo(instance);
    instance.on('click', (e: L.LeafletMouseEvent) => {
      if (context.current.picking && context.current.selected) {
        setPoint({ lat: e.latlng.lat, lng: e.latlng.wrap().lng });
        setCandidate(undefined);
      }
    });
    const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    observer.observe(element.current!);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = undefined;
    };
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !pins.current) return;
    pins.current.clearLayers();
    for (const record of records) {
      const location = record.location;
      if (location.status !== 'confirmed') continue;
      const marker = L.circleMarker([location.coordinates.lat, location.coordinates.lng], {
        radius: record.id === selected?.id ? 9 : 7,
        color: '#245f50',
        weight: 2,
        fillColor: '#43836c',
        fillOpacity: location.precision === 'building' ? 0.9 : 0.15,
      });
      const label = document.createElement('span');
      label.textContent = `${record.fields.company} · ${location.precision === 'building' ? '已确认办公点' : '大致区域'}`;
      marker
        .bindTooltip(label)
        .on('click', () => context.current.onSelect(record.id))
        .addTo(pins.current);
    }
    if (selected?.location.status === 'confirmed')
      instance.setView(
        [selected.location.coordinates.lat, selected.location.coordinates.lng],
        selected.location.precision === 'building' ? 16 : 13,
      );
  }, [records, selected?.id, selected?.revision]);
  useEffect(() => {
    setPicking(false);
    setPoint(undefined);
    setCandidates([]);
    setCandidate(undefined);
    setSearched(false);
    setError('');
  }, [selected?.id, selected?.revision]);
  useEffect(() => {
    let active = true;
    if (selected && selected.location.status !== 'confirmed')
      void store.api
        .locationCandidates({ recordId: selected.id, expectedRevision: selected.revision })
        .then((v) => {
          if (active) {
            const found = store.unwrap(v) as PlaceCandidate[];
            if (found.length) setCandidates(found);
          }
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [selected?.id, selected?.revision, store.latestEvent?.changeSetId]);
  useEffect(() => {
    preview.current?.remove();
    const instance = map.current;
    if (!point || !instance) return;
    preview.current = L.circleMarker([point.lat, point.lng], {
      radius: 10,
      color: '#c58132',
      fillOpacity: 0.2,
      dashArray: '3 3',
    }).addTo(instance);
  }, [point]);
  const locate = async () => {
    if (!selected) return;
    const id = selected.id,
      revision = selected.revision;
    setBusy(true);
    setError('');
    setCandidates([]);
    setSearched(false);
    try {
      const result = store.unwrap(
        await store.api.geocode({ recordId: id, expectedRevision: revision }),
      ) as { candidates: PlaceCandidate[] };
      if (context.current.selected?.id === id && context.current.selected?.revision === revision) {
        setCandidates(result.candidates);
        setSearched(true);
      }
    } catch (e) {
      if (context.current.selected?.id === id)
        setError(e instanceof Error ? e.message : '定位失败');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!selected || !point) return;
    setBusy(true);
    setError('');
    try {
      await store.mutate('setLocation', {
        requestId: crypto.randomUUID(),
        recordId: selected.id,
        expectedRevision: selected.revision,
        point,
        precision,
        label: candidate?.label || selected.fields.address || '手动标记的办公地点',
      });
      setPoint(undefined);
      setPicking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  const located = records.filter((r) => r.location.status === 'confirmed').length;
  const mapUrl = baiduMapUrl({
    city: selected?.fields.city || store.searchCity,
    address: selected?.fields.address,
    title: selected?.fields.company,
    point:
      point ||
      (selected?.location.status === 'confirmed' ? selected.location.coordinates : undefined),
  });
  return (
    <div className="map-panel">
      <style>{leafletCss}</style>
      <div className="map-heading">
        <strong>公司与办公地点</strong>
        <span className="muted">
          {located} 个已标记 · {records.length - located} 个待定位
        </span>
      </div>
      {!picking && (
        <iframe
          className="baidu-map"
          title="百度公司办公地点地图"
          src={mapUrl}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      )}
      <div
        hidden={!picking}
        className="career-map"
        ref={element}
        role="region"
        aria-label="手动确认位置地图"
      />
      {picking && tileError && (
        <p className="notice error">部分地图瓦片加载失败，可继续查看列表或稍后重开地图。</p>
      )}
      <p className="muted map-note">
        百度官方地图 · 无需 Key。
        {selected?.location.status === 'confirmed'
          ? '显示已确认位置。'
          : '地址搜索结果供核对，尚未确认办公点。'}
      </p>
      <div className="job-actions">
        <a href={mapUrl} target="_blank" rel="noopener noreferrer">
          在百度地图中查看 ↗
        </a>
        {picking && <button onClick={() => setPicking(false)}>返回百度地图</button>}
      </div>
      {selected ? (
        <>
          <p>
            <strong>{selected.fields.company}</strong> ·{' '}
            {selected.fields.address || '实际办公地址待补充'}
          </p>
          <div className="job-actions">
            <button disabled={busy || !selected.fields.address} onClick={() => void locate()}>
              查找可保存的位置
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPicking(!picking);
                setError('');
              }}
            >
              {picking ? '退出选点' : '手动标记位置'}
            </button>
            {selected.location.status === 'confirmed' && (
              <a target="_blank" rel="noopener noreferrer" href={mapUrl}>
                打开地图 ↗
              </a>
            )}
          </div>
          {busy && <p role="status">正在处理…</p>}
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {picking && (
            <p className="notice">
              手动选点使用 OpenStreetMap 坐标编辑器。百度免 Key
              页面不回传点击坐标；请核对后确认，系统不会把搜索结果自动当成办公点。
            </p>
          )}
          {searched && !candidates.length && (
            <p className="notice">没有找到匹配地址，可补充门牌、园区名或手动选点。</p>
          )}
          {candidates.length > 0 && (
            <div className="place-candidates">
              <p className="muted">Photon 地址候选，选中后在百度地图核对再保存：</p>
              {candidates.map((place, index) => (
                <button
                  key={place.id}
                  onClick={() => {
                    setCandidate(place);
                    setPoint(place.point);
                    setPrecision(place.precision);
                    map.current?.setView(
                      [place.point.lat, place.point.lng],
                      place.precision === 'building' ? 16 : 13,
                    );
                  }}
                >
                  {index + 1}. {place.label}
                  <span className="muted">
                    {place.point.lat.toFixed(5)}, {place.point.lng.toFixed(5)} · WGS84
                  </span>
                  <span className="muted">
                    {place.precision === 'area'
                      ? '范围位置，不能直接视为办公楼'
                      : '建筑候选，仍需核对'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {point && (
            <div className="notice">
              <p>待确认：{candidate?.label || '地图手动选点'}</p>
              <label>
                位置精度
                <select
                  aria-label="位置精度"
                  value={precision}
                  onChange={(e) => setPrecision(e.target.value as 'building' | 'area')}
                >
                  <option value="area">仅知道大致区域</option>
                  <option value="building">我确认这是具体办公点</option>
                </select>
              </label>
              <div className="job-actions">
                <button disabled={busy} onClick={() => setPoint(undefined)}>
                  取消
                </button>
                <button className="primary" disabled={busy} onClick={() => void save()}>
                  确认办公地点
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="muted">
          选择一个已保存机会，即可查询或标记实际办公地。初始视野为西安市，不代表任何公司位置。
        </p>
      )}
    </div>
  );
}
