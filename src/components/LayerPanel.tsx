'use client';

import { memo, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plane, Satellite, Sun, AlertTriangle, Camera,
  CloudLightning, CloudSun, Ship, Network, Database, Ghost,
  Flame, Tv, Radio, Mountain, Anchor, Megaphone, SlidersHorizontal, Bus
} from 'lucide-react';
import StyleStudio from './StyleStudio';
import { TERRAIN_MIN_ZOOM, type TerrainStatus } from '@/lib/map-terrain';

interface LayerPanelProps {
  data: any;
  activeLayers: any;
  setActiveLayers: React.Dispatch<React.SetStateAction<any>>;
  isMobile?: boolean;
  theme?: 'core' | 'ghost';
  setTheme?: (theme: 'core' | 'ghost') => void;
  /** Server-side capabilities, e.g. { cloudflare: true }. Layers declaring a
   *  `requires` key stay hidden until the matching capability is present. */
  capabilities?: Record<string, boolean>;
  terrainStatus?: TerrainStatus;
  onTerrainRetry?: () => void;
  onTerrainFocus?: () => void;
  on3DModeSelected?: () => void;
  /** False while the splash is up; the rail slides in when it turns true. */
  revealed?: boolean;
  /** A layer's live state in a line, shown under its name in place of its description. */
  liveStatus?: Record<string, string>;
}

interface LayerDef {
  key: string;
  label: string;
  dataKey: string;
  description?: string;
  /** Reads a bucket out of data.category_counts instead of a top-level array. */
  catKey?: string;
  /** Capability that must be configured server-side for this layer to appear. */
  requires?: string;
  /** Key of the layer this one modifies. Renders indented beneath it, and reads
   *  as inert while that parent is off — it has nothing to act on. */
  parent?: string;
}

interface LayerGroupDef {
  label: string;
  fullLabel: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  layers: LayerDef[];
}

const LAYER_GROUPS: LayerGroupDef[] = [
  {
    label: 'ПОГОДА',
    fullLabel: 'WEATHER',
    icon: CloudSun,
    layers: [
      { key: 'live_clouds', label: 'Облачность', description: 'Спутники NOAA · объёмные облака · каждый час', dataKey: '' },
      { key: 'wind', label: 'Ветер', description: 'NOAA GFS · ветер у поверхности · каждые 6 ч', dataKey: '' },
      { key: 'wind_controls', label: 'Управление временем', description: '3 дня назад · 5 дней вперёд', dataKey: '', parent: 'wind' },
      { key: 'wind_particles', label: 'Частицы', description: 'Частицы окрашены по скорости ветра', dataKey: '', parent: 'wind' },
      { key: 'rain', label: 'Осадки', description: 'Радар RainViewer · каждые 10 мин', dataKey: '' },
      { key: 'rain_controls', label: 'Управление временем', description: 'Последние 2 часа · повтор', dataKey: '', parent: 'rain' },
    ],
  },
  {
    label: 'АВИАЦИЯ',
    fullLabel: 'AVIATION',
    icon: Plane,
    layers: [
      { key: 'flights', label: 'Коммерческие рейсы', dataKey: 'commercial_flights' },
      { key: 'private', label: 'Частные рейсы', dataKey: 'private_flights' },
      { key: 'jets', label: 'Бизнес-джеты', dataKey: 'private_jets' },
      { key: 'military', label: 'Военная авиация', dataKey: 'military_flights' },
    ],
  },
  {
    label: 'МОРСКИЕ СУДА',
    fullLabel: 'MARITIME',
    icon: Ship,
    layers: [
      { key: 'maritime', label: 'Морские суда / флот', dataKey: 'maritime_ships,maritime_ports,maritime_chokepoints' },
      { key: 'sdk_sea', label: 'Морские маршруты', dataKey: 'sdk_entities' },
    ],
  },
  {
    label: 'ТРАНСПОРТ',
    fullLabel: 'GROUND TRANSIT',
    icon: Bus,
    layers: [
      { key: 'transit', label: 'Общественный транспорт', description: 'GPS-данные перевозчиков · каждые 20 с', dataKey: '' },
    ],
  },
  {
    label: 'КОСМОС',
    fullLabel: 'SPACE TRACKING',
    icon: Satellite,
    layers: [
      { key: 'satellites', label: 'Все спутники', dataKey: 'satellites' },
      { key: 'sat_comms', label: 'Starlink / связь', dataKey: 'satellites', catKey: 'comms' },
      { key: 'sat_military', label: 'Военные / разведка', dataKey: 'satellites', catKey: 'military' },
      { key: 'sat_navigation', label: 'GPS / навигация', dataKey: 'satellites', catKey: 'navigation' },
      { key: 'sat_earth', label: 'Наблюдение Земли', dataKey: 'satellites', catKey: 'earth_obs' },
      { key: 'sat_science', label: 'Станции / телескопы', dataKey: 'satellites', catKey: 'science' },
    ],
  },
  {
    label: 'НАБЛЮДЕНИЕ',
    fullLabel: 'SURVEILLANCE',
    icon: Camera,
    layers: [
      { key: 'cctv', label: 'Камеры наблюдения', dataKey: 'cameras' },
      { key: 'cctv_previews', label: 'Прямые трансляции', dataKey: '', parent: 'cctv' },
      { key: 'live_news', label: 'Новостные ленты', dataKey: 'live_feeds' },
    ],
  },
  {
    label: 'ОПАСНОСТИ',
    fullLabel: 'NATURAL HAZARDS',
    icon: CloudLightning,
    layers: [
      { key: 'earthquakes', label: 'Землетрясения', dataKey: 'earthquakes' },
      { key: 'fires', label: 'Активные пожары', dataKey: 'fires' },
      { key: 'weather', label: 'Опасная погода', dataKey: 'weather_events' },
    ],
  },
  {
    label: 'УГРОЗЫ',
    fullLabel: 'THREATS & INTEL',
    icon: AlertTriangle,
    layers: [
      { key: 'infrastructure', label: 'Ядерные объекты', dataKey: 'infrastructure' },
      { key: 'global_incidents', label: 'Мировые происшествия', dataKey: 'gdelt' },
      { key: 'alert_pins', label: 'Маркеры оповещений', dataKey: 'alert_pins' },
      { key: 'gdelt_events', label: 'События GDELT', dataKey: 'gdelt_events' },
    ],
  },
  {
    label: 'СЕТЬ',
    fullLabel: 'NETWORK INTEL',
    icon: Network,
    layers: [
      { key: 'malware', label: 'Вредоносное ПО', description: 'C2-серверы · связи внутри группировки', dataKey: 'malware_threats' },
      { key: 'cyber_attacks', label: 'Серверы C2 ботнетов', description: 'Чёрный список Feodo · отчёты исследователей', dataKey: 'cyber_attacks' },
    ],
  },
  {
    label: 'СЕТЕВАЯ РАЗВЕДКА',
    fullLabel: 'NET & EVENT INTEL',
    icon: Megaphone,
    layers: [
      { key: 'cf_outages', label: 'Сбои интернета', dataKey: 'cf_outages', requires: 'cloudflare' },
      { key: 'cf_attacks', label: 'Источники атак', dataKey: 'cf_attack_origins', requires: 'cloudflare' },
    ],
  },
  {
    label: 'ОТОБРАЖЕНИЕ',
    fullLabel: 'ОТОБРАЖЕНИЕ',
    icon: Sun,
    layers: [
      { key: 'day_night', label: 'Смена дня и ночи', dataKey: '' },
      { key: 'terrain_3d', label: '3D-здания', description: 'Здания города · масштаб от 14,5', dataKey: '' },
      { key: 'terrain_elevation', label: '3D-рельеф', description: 'Горы · масштаб от 10', dataKey: '' },
    ],
  },
];

/* ── Minimal Toggle Switch ── */
/**
 * Presentational only. The row around it is the button, and a button inside a
 * button is invalid HTML — the browser reparents it, which breaks hydration and
 * silently drops the click handler on the inner control.
 */
function ToggleSwitch({ active, mobile = false }: { active: boolean; mobile?: boolean }) {
  // The parent button owns click and keyboard behaviour; this is visual only.
  return (
    <span
      aria-hidden="true"
      className={`osiris-layer-switch ${active ? 'active' : ''} ${mobile ? 'is-mobile' : ''}`}
    >
      <span className="osiris-layer-switch__thumb" />
    </span>
  );
}

/**
 * The elbow that ties a sub-layer row to the layer above it. Indentation alone
 * reads as a typo at this size; the line is what says "this belongs to that".
 */
function SubLayerStem() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-[6px] top-0 h-1/2 w-[8px] rounded-bl-[3px] border-b border-l border-white/[0.14]"
    />
  );
}

function LayerPanel({ data, activeLayers, setActiveLayers, isMobile, theme = 'core', setTheme, capabilities = {}, terrainStatus = 'idle', onTerrainRetry, onTerrainFocus, on3DModeSelected, revealed = true, liveStatus }: LayerPanelProps) {
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  /**
   * A pinned group stays open when the pointer leaves. Hover-only flyouts are
   * fine to glance at and impossible to work in — reaching for a toggle at the
   * far edge closes the thing you were reaching for.
   */
  const [pinnedGroup, setPinnedGroup] = useState<string | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);

  useEffect(() => {
    if (!pinnedGroup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinnedGroup(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedGroup]);

  const toggle = (key: string) => {
    if ((key === 'terrain_elevation' || key === 'terrain_3d') && !activeLayers[key]) on3DModeSelected?.();
    setActiveLayers((prev: any) => ({ ...prev, [key]: !prev[key] }));
  };
  const terrainDetails = activeLayers.terrain_elevation ? (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-[10px] text-white/60">
      <p role="status">{terrainStatus === 'idle' ? `Рельеф при масштабе ${TERRAIN_MIN_ZOOM}+ · приблизьте карту` : terrainStatus === 'waiting' ? 'Рельеф загрузится после остановки карты' : terrainStatus === 'loading' ? 'Загружается ближайший рельеф…' : terrainStatus === 'error' ? 'Рельеф недоступен; карта продолжает работать.' : 'Рельеф включён'}</p>
      {terrainStatus === 'idle' && <button type="button" onClick={onTerrainFocus} className="mt-2 min-h-8 rounded border border-white/15 px-2 text-[var(--gold-primary)] hover:bg-white/10">Приблизить к рельефу</button>}
      {terrainStatus === 'error' && <button type="button" onClick={onTerrainRetry} className="mt-2 min-h-8 rounded border border-white/15 px-2 text-[var(--gold-primary)] hover:bg-white/10">Повторить загрузку рельефа</button>}
      <p className="mt-2 text-white/35">Детализация поблизости · кэшированные тайлы</p>
      <a className="mt-1 inline-block underline underline-offset-2" href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">Источники данных рельефа</a>
    </div>
  ) : null;

  /** Switch a whole group at once — off if any are on, otherwise all on.
   *  Sub-layers keep their setting: they only say how their parent shows. */
  const toggleGroup = (layers: LayerDef[]) => {
    const top = layers.filter(l => !l.parent);
    const anyOn = top.some(l => activeLayers[l.key]);
    if (!anyOn && top.some(l => l.key === 'terrain_elevation' || l.key === 'terrain_3d')) on3DModeSelected?.();
    setActiveLayers((prev: any) => {
      const next = { ...prev };
      for (const l of top) next[l.key] = !anyOn;
      return next;
    });
  };

  /* Drop layers whose backing capability is not configured, then drop any group
     left with nothing to show. */
  const visibleGroups = LAYER_GROUPS.map(g => ({
    ...g,
    layers: g.layers.filter(l => !l.requires || capabilities[l.requires]),
  })).filter(g => g.layers.length > 0);

  const getCount = (dk: string, catKey?: string): number | null => {
    if (!dk) return null;
    if (catKey && data.category_counts) {
      return data.category_counts[catKey] || 0;
    }
    let total = 0;
    let found = false;
    for (const k of dk.split(',')) {
      if (data[k] && Array.isArray(data[k])) {
        total += data[k].length;
        found = true;
      }
    }
    return found ? total : null;
  };

  /* ── MOBILE ── */
  if (isMobile) {
    return (
      <div className="osiris-mobile-layer-panel flex flex-col gap-5 py-2">
        {visibleGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-2">
            <div className="osiris-mobile-group-title text-[10px] font-mono tracking-[0.2em] uppercase border-b pb-1.5">
              {group.fullLabel}
            </div>
            <div className="flex flex-col gap-1">
              {group.layers.map((layer) => {
                const isLayerActive = activeLayers[layer.key];
                const count = getCount(layer.dataKey, layer.catKey);
                const dormant = !!layer.parent && !activeLayers[layer.parent];
                return (
                  <button
                    key={layer.key}
                    onClick={() => toggle(layer.key)}
                    aria-pressed={!!isLayerActive}
                    aria-label={layer.label}
                    className={`osiris-mobile-layer-row relative w-full flex items-center gap-3 py-2 rounded-md text-left transition-all ${layer.parent ? 'pl-[22px] pr-1' : 'px-1'} ${dormant ? 'is-dormant' : ''} ${isLayerActive ? 'is-on' : ''}`}
                  >
                    {layer.parent && <SubLayerStem />}
                    <ToggleSwitch active={!!isLayerActive} mobile />
                    <span className={`osiris-mobile-layer-label text-[11px] font-mono uppercase tracking-wider flex-1 transition-colors ${isLayerActive ? 'is-on' : ''}`}>
                      {layer.label}
                      {(liveStatus?.[layer.key] ?? layer.description) && <span className="osiris-mobile-layer-description block mt-1 text-[9px] normal-case tracking-normal">{liveStatus?.[layer.key] ?? layer.description}</span>}
                    </span>
                    {count !== null && (
                      <span className="osiris-mobile-layer-count text-[10px] font-mono tabular-nums">
                        {count.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
              {group.label === 'ОТОБРАЖЕНИЕ' && terrainDetails}
            </div>
          </div>
        ))}

        {/* MOBILE STYLE STUDIO */}
        <div className="flex items-center justify-between mt-2 pt-3 border-t border-white/[0.06] px-1">
          <span className="text-[10px] font-mono tracking-[0.2em] text-white/25 uppercase">Студия стилей</span>
          <button
            onClick={() => setStudioOpen(o => !o)}
            aria-pressed={studioOpen}
            className="osiris-mobile-tool-btn w-8 h-8 rounded-full flex items-center justify-center transition-all"
            style={{
              background: studioOpen ? 'var(--hover-accent)' : 'transparent',
              boxShadow: studioOpen ? '0 0 12px var(--gold-glow)' : 'none',
            }}
          >
            <SlidersHorizontal className="w-4 h-4" style={{ color: studioOpen ? '#FFD15A' : '#D8DEE9' }} />
          </button>
        </div>
        <AnimatePresence>
          {studioOpen && <StyleStudio isMobile onClose={() => setStudioOpen(false)} />}
        </AnimatePresence>

        {/* MOBILE GHOST TOGGLE */}
        {setTheme && (
          <div className="flex items-center justify-between pt-3 border-t border-white/[0.06] px-1">
            <span className="text-[10px] font-mono tracking-[0.2em] text-white/25 uppercase">Призрачный режим</span>
            <button
              onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
              className="osiris-mobile-tool-btn w-8 h-8 rounded-full flex items-center justify-center transition-all"
              style={{
                background: theme === 'ghost' ? 'rgba(179, 136, 255, 0.15)' : 'transparent',
                boxShadow: theme === 'ghost' ? '0 0 12px rgba(179, 136, 255, 0.3)' : 'none',
              }}
            >
              <Ghost className="w-4 h-4" style={{ color: theme === 'ghost' ? '#C9A7FF' : '#D8DEE9' }} />
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ── DESKTOP ── */
  return (
    <motion.div
      initial={{ x: -60, opacity: 0 }}
      animate={revealed ? { x: 0, opacity: 1 } : { x: -60, opacity: 0 }}
      transition={{ type: 'spring', damping: 30, stiffness: 200, delay: 0.25 }}
      className="absolute top-0 left-0 h-full w-[48px] flex flex-col items-center pt-24 pb-6 z-50 pointer-events-auto"
      style={{
        background: 'rgba(0,0,0,0.15)',
        backdropFilter: 'blur(24px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.2)',
      }}
    >
      <div className="flex-1 flex flex-col items-center gap-1">
        {visibleGroups.map((group, index) => {
          /* Sub-layers modify a parent rather than draw anything of their own,
             so they do not count towards the rail's reading. */
          const counted = group.layers.filter(l => !l.parent);
          const groupActive = counted.some(l => activeLayers[l.key]);
          const isHovered = hoveredGroup === group.label;
          const Icon = group.icon;

          const activeCount = counted.filter(l => activeLayers[l.key]).length;
          const isPinned = pinnedGroup === group.label;
          const isOpen = isHovered || isPinned;

          return (
            <div
              key={group.label}
              className="relative flex items-center justify-center"
              onMouseEnter={() => setHoveredGroup(group.label)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              {/* A real button, not a div: this is keyboard reachable, focusable
                  and announced. Clicking pins the flyout open so it can be
                  worked in rather than only glanced at. */}
              <button
                onClick={() => setPinnedGroup(isPinned ? null : group.label)}
                aria-expanded={isOpen}
                aria-label={`${group.fullLabel}${activeCount ? ` — ${activeCount} активно` : ''}`}
                title={group.fullLabel}
                className="relative w-10 h-10 flex items-center justify-center cursor-pointer rounded-lg transition-all duration-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
                style={{
                  background: isPinned
                    ? 'rgba(255,255,255,0.10)'
                    : isHovered ? 'rgba(255,255,255,0.05)' : 'transparent',
                }}
              >
                <Icon
                  className="transition-all duration-300"
                  style={{
                    width: 16,
                    height: 16,
                    color: groupActive
                      ? 'rgba(255,255,255,0.75)'
                      : isOpen
                        ? 'rgba(255,255,255,0.45)'
                        : 'rgba(255,255,255,0.22)',
                    filter: groupActive ? 'drop-shadow(0 0 4px rgba(255,255,255,0.3))' : 'none',
                  }}
                />

                {/* How many layers in this group are live. Without it the rail
                    gives no reading at all until each icon is hovered in turn. */}
                {activeCount > 0 && (
                  <span
                    className="absolute top-1 right-1 min-w-[13px] h-[13px] px-[3px] rounded-full flex items-center justify-center text-[9px] font-mono tabular-nums leading-none"
                    style={{
                      background: 'rgba(0,229,255,0.9)',
                      color: '#04040A',
                      boxShadow: '0 0 6px rgba(0,229,255,0.5)',
                    }}
                  >
                    {activeCount}
                  </span>
                )}
              </button>

              {/* Flyout (LEFT side). Centred on its icon, but the first hangs
                  down from it: the top of the rail leaves no room above. */}
              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ opacity: 0, x: -8, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, x: -4, filter: 'blur(2px)' }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className={`absolute left-[52px] ${index === 0 ? 'top-0' : 'top-1/2 -translate-y-1/2'} min-w-[220px] rounded-xl p-3 z-[100] pointer-events-auto`}
                    style={{
                      background: 'rgba(0,0,0,0.6)',
                      backdropFilter: 'blur(40px) saturate(1.5)',
                      WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    }}
                  >
                    <div className="flex items-center gap-2 mb-2.5 pb-1.5 border-b border-white/[0.04]">
                      <span className="text-[10px] font-mono tracking-[0.2em] uppercase text-white/35 flex-1">
                        {group.fullLabel}
                      </span>
                      {/* Switching eight satellite layers one at a time is the
                          kind of thing that makes a panel feel unfinished. */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroup(group.layers); }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                      >
                        {activeCount > 0 ? 'NONE' : 'ALL'}
                      </button>
                      {isPinned && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setPinnedGroup(null); }}
                          aria-label="Закрыть"
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {group.layers.map((layer) => {
                        const isLayerActive = activeLayers[layer.key];
                        const count = getCount(layer.dataKey, layer.catKey);
                        const dormant = !!layer.parent && !activeLayers[layer.parent];

                        return (
                          <button
                            key={layer.key}
                            onClick={() => toggle(layer.key)}
                            aria-pressed={!!isLayerActive}
                            aria-label={layer.label}
                            title={dormant ? 'Включите основной слой для использования' : undefined}
                            className={`relative w-full flex items-center gap-3 py-1.5 rounded-md hover:bg-white/[0.05] transition-colors cursor-pointer text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${layer.parent ? 'pl-[22px] pr-1' : 'px-1'} ${dormant ? 'opacity-40' : ''}`}
                          >
                            {layer.parent && <SubLayerStem />}
                            <ToggleSwitch active={!!isLayerActive} />
                            <span className={`text-[11px] font-mono uppercase tracking-wider flex-1 transition-colors duration-200 ${isLayerActive ? 'text-white/70' : 'text-white/35'}`}>
                              {layer.label}
                              {(liveStatus?.[layer.key] ?? layer.description) && <span className={`block mt-0.5 text-[9px] normal-case tracking-normal ${liveStatus?.[layer.key] ? 'text-white/55' : 'text-white/35'}`}>{liveStatus?.[layer.key] ?? layer.description}</span>}
                            </span>
                            {count !== null && (
                              <span className={`text-[10px] font-mono tabular-nums transition-colors ${isLayerActive ? 'text-white/45' : 'text-white/20'}`}>
                                {count.toLocaleString()}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {group.label === 'ОТОБРАЖЕНИЕ' && terrainDetails}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Subtle separator */}
      <div className="w-5 h-px bg-white/[0.06] my-2" />

      {/* Style Studio */}
      <button
        onClick={() => setStudioOpen(o => !o)}
        aria-pressed={studioOpen}
        className="w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-500 cursor-pointer"
        style={{ background: studioOpen ? 'var(--hover-accent)' : 'transparent' }}
        title="Студия стилей"
      >
        <SlidersHorizontal
          className="transition-all duration-500"
          style={{
            width: 15,
            height: 15,
            color: studioOpen ? 'var(--gold-primary)' : 'rgba(255,255,255,0.15)',
            filter: studioOpen ? 'drop-shadow(0 0 6px var(--gold-glow))' : 'none',
          }}
        />
      </button>
      <AnimatePresence>
        {studioOpen && <StyleStudio onClose={() => setStudioOpen(false)} />}
      </AnimatePresence>

      {/* Ghost Protocol Toggle */}
      {setTheme && (
        <button
          onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
          className="w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-500 cursor-pointer"
          style={{
            background: theme === 'ghost' ? 'rgba(179, 136, 255, 0.1)' : 'transparent',
          }}
          title="Призрачный режим"
        >
          <Ghost
            className="transition-all duration-500"
            style={{
              width: 15,
              height: 15,
              color: theme === 'ghost' ? '#B388FF' : 'rgba(255,255,255,0.15)',
              filter: theme === 'ghost' ? 'drop-shadow(0 0 6px rgba(179, 136, 255, 0.5))' : 'none',
            }}
          />
        </button>
      )}
    </motion.div>
  );
}

export default memo(LayerPanel);
