'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Newspaper, ChevronDown, ChevronUp, ExternalLink, MapPin, Zap } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Intelligence Feed
   SIGINT-style news aggregation with risk scoring
   ═══════════════════════════════════════════════════════════════ */

interface IntelFeedProps {
  data: any;
  onLocate?: (lat: number, lng: number) => void;
}

function getRiskClass(score: number): string {
  if (score >= 8) return 'risk-critical';
  if (score >= 6) return 'risk-high';
  if (score >= 4) return 'risk-medium';
  return 'risk-low';
}

function getRiskLabel(score: number): string {
  if (score >= 8) return 'CRITICAL';
  if (score >= 6) return 'HIGH';
  if (score >= 4) return 'ELEVATED';
  return 'LOW';
}

function timeAgo(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff)) return 'нет даты';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${Math.max(0, mins)} мин назад`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${Math.max(0, hrs)} ч назад`;
    return `${Math.max(0, Math.floor(hrs / 24))} дн назад`;
  } catch {
    return '';
  }
}

export default function IntelFeed({ data, onLocate }: IntelFeedProps) {
  const [expanded, setExpanded] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const news = data.news || [];
  const sources: Array<{
    handle: string; name: string; kind?: 'wire' | 'telegram'; count: number;
    latest: string | null; state?: string; lastSuccessAt?: string | null;
  }> = data.news_meta?.sources ?? [];
  const reportedSources = sources.filter(source => source.count > 0).length;
  const failedSources = sources.filter(source => source.state === 'degraded' || source.state === 'error').length;
  const fetchedAt: string | null = data.news_meta?.fetchedAt ?? null;
  const feedDelayed = fetchedAt !== null && Date.now() - Date.parse(fetchedAt) > 10 * 60_000;
  const sourceLabel = (source: (typeof sources)[number]) => {
    if (source.state === 'degraded') return 'СБОЙ · КЭШ';
    if (source.state === 'error') return 'ОШИБКА ЗАГРУЗКИ';
    if (source.state === 'empty') return 'ПУСТОЙ ОТВЕТ';
    if (source.state === 'ok') return source.count ? 'ДАННЫЕ ПОЛУЧЕНЫ' : 'НЕТ НОВЫХ ЗА 72 Ч';
    return 'НЕ ПРОВЕРЕНО';
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.6, duration: 0.6 }}
      className="glass-panel flex flex-col overflow-hidden pointer-events-auto"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Newspaper className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[11px] text-[var(--text-primary)]">ЛЕНТА РАЗВЕДДАННЫХ</span>
          <span className="gotham-tag gotham-tag--info" style={{ fontSize: '9px', padding: '1px 5px' }}>{news.length}</span>
          {news.some((n: any) => n.risk_score >= 8) && (
            <span className="gotham-tag gotham-tag--critical" style={{ fontSize: '9px', padding: '1px 4px' }}>ОПОВЕЩЕНИЯ</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: !sources.length ? '#858B97' : failedSources || feedDelayed ? '#FFB454' : '#8FE4B1' }} />
          {expanded ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      {/* Source connectivity is independent from the age of the latest report.
          Expose it by touch instead of displaying an unconditional green LIVE dot. */}
      <div className="border-t border-white/5 px-3 py-2 text-[10px] font-mono">
        <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen} aria-controls="osiris-intel-source-health">
          <span style={{ color: failedSources || feedDelayed ? '#FFB454' : '#8FE4B1' }}>
            {sources.length ? reportedSources + '/' + sources.length + ' С ПУБЛИКАЦИЯМИ (72 Ч)' : 'ОЖИДАНИЕ ДАННЫХ ОБ ИСТОЧНИКАХ'}
            {failedSources > 0 && <span> · {failedSources} СБОЙ</span>}
            {feedDelayed && <span> · ДАННЫЕ ЗАДЕРЖАНЫ</span>}
          </span>
          <ChevronDown className={sourcesOpen ? 'h-3 w-3 shrink-0 rotate-180 text-white/60' : 'h-3 w-3 shrink-0 text-white/60'} />
        </button>
        {sourcesOpen && (
          <div id="osiris-intel-source-health" role="region" aria-label="Состояние источников" className="mt-2 max-h-48 overflow-y-auto divide-y divide-white/10 border-t border-white/10">
            {fetchedAt && <div className="py-2 text-white/55">Данные сформированы: {timeAgo(fetchedAt)}</div>}
            {[...sources].sort((a, b) => Number(b.state === 'error' || b.state === 'degraded') - Number(a.state === 'error' || a.state === 'degraded')).map(source => (
              <div key={source.handle} className="flex items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate text-white/85">{source.name} <span className="text-white/40">· {source.kind === 'wire' ? 'RSS' : 'Telegram'}</span></div>
                  <div className="text-white/45">{source.count} публикаций · последняя: {source.latest ? timeAgo(source.latest) : 'нет данных'}</div>
                  {source.lastSuccessAt && <div className="text-white/45">Связь: {timeAgo(source.lastSuccessAt)}</div>}
                </div>
                <div className="max-w-28 shrink-0 text-right" style={{ color: source.state === 'error' || source.state === 'degraded' ? '#FFB454' : '#8FE4B1' }}>{sourceLabel(source)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* News Items */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="max-h-[400px] overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]">
              {news.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <span className="text-[10px] font-mono text-[var(--text-muted)] tracking-widest">
                    НЕТ СВЕЖИХ СООБЩЕНИЙ
                  </span>
                </div>
              ) : (
                news.slice(0, 25).map((item: any, i: number) => (
                  <div
                    key={i}
                    role="button"
                    tabIndex={0}
                    className="px-4 py-2.5 hover:bg-[var(--hover-accent)] transition-colors cursor-pointer"
                    onClick={() => { if (item.link) window.open(item.link, '_blank', 'noopener,noreferrer'); else setSelectedIdx(selectedIdx === i ? null : i); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && item.link) window.open(item.link, '_blank', 'noopener,noreferrer'); }}
                  >
                    {/* Top row: risk badge + source + time */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-mono font-bold tracking-widest ${getRiskClass(item.risk_score)}`}>
                        {getRiskLabel(item.risk_score)}
                      </span>
                      <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
                        {item.source}
                      </span>
                      {item.coords && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onLocate?.(item.coords[0], item.coords[1]);
                          }}
                          className="text-[var(--text-muted)] hover:text-[var(--cyan-primary)] transition-colors"
                          title={item.coords_anchor ? `Approximate: centroid for "${item.coords_anchor}", not the event location` : 'Approximate location'}
                        >
                          <MapPin className="w-2.5 h-2.5" />
                        </button>
                      )}
                      <span className="text-[9px] font-mono text-[var(--text-muted)] ml-auto">
                        {timeAgo(item.published)}
                      </span>
                    </div>

                    {/* Title */}
                    <h4 className="text-[10px] text-[var(--text-primary)] leading-tight line-clamp-2">
                      {item.title}
                    </h4>

                    {/* Why the risk badge reads the way it does. Not an assessment:
                        the keyword filter's own working, shown so the badge is
                        read as a word count rather than a judgement. */}
                    {item.keyword_assessment && (
                      <div className="mt-1.5 flex items-start gap-1.5 bg-red-950/20 border border-red-900/20 rounded px-2 py-1">
                        <Zap className="w-2.5 h-2.5 text-red-400 flex-shrink-0 mt-0.5" />
                        <span className="text-[10px] font-mono text-red-400/80 leading-relaxed">
                          {item.keyword_assessment}
                        </span>
                      </div>
                    )}

                    {/* Expanded details */}
                    <AnimatePresence>
                      {selectedIdx === i && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="mt-2 overflow-hidden"
                        >
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-[11px] font-mono text-[var(--cyan-primary)] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="w-2.5 h-2.5" />
                            OPEN SOURCE
                          </a>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
