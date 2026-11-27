'use client';

import { useEffect, useRef, useState } from 'react';
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
  if (score >= 8) return 'КРИТИЧЕСКИЙ';
  if (score >= 6) return 'ВЫСОКИЙ';
  if (score >= 4) return 'ПОВЫШЕННЫЙ';
  return 'НИЗКИЙ';
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
  const [headlineLanguage, setHeadlineLanguage] = useState<'ru' | 'en'>('ru');
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({});
  const [translationStatus, setTranslationStatus] = useState<'loading' | 'ready' | 'limited'>('ready');
  // A refreshed news array must not discard translations already in flight.
  // Failed requests may retry after five minutes, not on every one-minute poll.
  const attemptedAt = useRef(new Map<string, number>());
  const inFlightTitles = useRef(new Set<string>());
  const isMounted = useRef(true);
  const translationJobs = useRef(0);
  const news = data.news || [];
  const headlineSignature = news.slice(0, 25)
    .map((item: { title?: unknown }) => typeof item.title === 'string' ? item.title : '')
    .join('\u001f');
  const newsRefreshAt: string = data.news_meta?.fetchedAt ?? '';

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (headlineLanguage !== 'ru') return;
    const pending: string[] = [];
    const now = Date.now();
    for (const title of headlineSignature.split('\u001f')) {
      if (!title || translatedTitles[title] || inFlightTitles.current.has(title)) continue;
      const lastAttempt = attemptedAt.current.get(title);
      if (lastAttempt !== undefined && now - lastAttempt < 5 * 60_000) continue;
      attemptedAt.current.set(title, now);
      inFlightTitles.current.add(title);
      pending.push(title);
    }
    if (!pending.length) return;
    // Keep this retry bookkeeping bounded even after days of news updates.
    while (attemptedAt.current.size > 350) {
      const oldest = attemptedAt.current.keys().next().value;
      if (!oldest) break;
      attemptedAt.current.delete(oldest);
    }

    translationJobs.current++;
    setTranslationStatus('loading');
    const batches: string[][] = [];
    for (let i = 0; i < pending.length; i += 12) batches.push(pending.slice(i, i + 12));
    void Promise.all(batches.map(async headlines => {
      try {
        const response = await fetch('/api/news/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headlines }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return { translations: {} as Record<string, string>, unavailable: true };
        return await response.json() as { translations: Record<string, string>; unavailable: boolean };
      } catch {
        return { translations: {} as Record<string, string>, unavailable: true };
      }
    })).then(results => {
      for (const title of pending) inFlightTitles.current.delete(title);
      translationJobs.current = Math.max(0, translationJobs.current - 1);
      if (!isMounted.current) return;
      const merged = Object.assign({}, ...results.map(result => result.translations));
      setTranslatedTitles(previous => ({ ...previous, ...merged }));
      setTranslationStatus(results.some(result => result.unavailable)
        ? 'limited'
        : translationJobs.current > 0 ? 'loading' : 'ready');
    });
    // `newsRefreshAt` supplies a retry opportunity after the cooldown.
    // Deliberately do not cancel in-flight translations on news refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headlineSignature, headlineLanguage, newsRefreshAt]);
  const sources: Array<{
    handle: string; name: string; kind?: 'wire' | 'telegram'; count: number;
    latest: string | null; state?: string; lastSuccessAt?: string | null; nextRetryAt?: string | null; responseMs?: number | null; pausedReason?: string | null;
  }> = data.news_meta?.sources ?? [];
  const reportedSources = sources.filter(source => source.count > 0).length;
  const liveConnections = sources.filter(source => source.state === 'ok' || source.state === 'empty').length;
  const failedSources = sources.filter(source => source.state === 'degraded' || source.state === 'error' || source.state === 'blocked').length;
  const pausedSources = sources.filter(source => source.state === 'paused').length;
  const fetchedAt: string | null = data.news_meta?.fetchedAt ?? null;
  const feedDelayed = fetchedAt !== null && Date.now() - Date.parse(fetchedAt) > 10 * 60_000;
  // A working connection is not the same as newly published OSINT. Display
  // actual article ages rather than an unconditional LIVE label.
  const now = Date.now();
  const articleAge = (item: { published?: string }) => now - Date.parse(item.published || '');
  const recent3h = news.filter((item: { published?: string }) =>
    Number.isFinite(articleAge(item)) && articleAge(item) >= 0 && articleAge(item) <= 3 * 60 * 60_000).length;
  const recent24h = news.filter((item: { published?: string }) =>
    Number.isFinite(articleAge(item)) && articleAge(item) >= 0 && articleAge(item) <= 24 * 60 * 60_000).length;
  const sourceLabel = (source: (typeof sources)[number]) => {
    if (source.state === 'paused') return 'ПРИОСТАНОВЛЕН · HTTP 403';
    if (source.state === 'blocked') return 'HTTP 403 · ДОСТУП ЗАПРЕЩЁН';
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
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: !sources.length ? '#858B97' : failedSources || pausedSources || feedDelayed ? '#FFB454' : '#8FE4B1' }} />
          {expanded ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      <div className="flex items-center justify-between border-t border-white/5 px-3 py-1.5 text-[9px] font-mono">
        <span className="text-white/50">
          {headlineLanguage === 'ru'
            ? translationStatus === 'loading' ? 'ПЕРЕВОД ЗАГОЛОВКОВ…'
              : translationStatus === 'limited' ? 'ПЕРЕВОД ЧАСТИЧНО НЕДОСТУПЕН' : 'МАШИННЫЙ ПЕРЕВОД НА РУССКИЙ'
            : 'ОРИГИНАЛЬНЫЕ ЗАГОЛОВКИ'}
        </span>
        <div className="flex gap-1" aria-label="Язык новостных заголовков">
          <button type="button" onClick={() => setHeadlineLanguage('ru')} aria-pressed={headlineLanguage === 'ru'} className={headlineLanguage === 'ru' ? 'rounded bg-[#A88639]/25 px-2 py-1 text-[#EBCB79]' : 'rounded px-2 py-1 text-white/50 hover:text-white'}>РУС</button>
          <button type="button" onClick={() => setHeadlineLanguage('en')} aria-pressed={headlineLanguage === 'en'} className={headlineLanguage === 'en' ? 'rounded bg-[#A88639]/25 px-2 py-1 text-[#EBCB79]' : 'rounded px-2 py-1 text-white/50 hover:text-white'}>ОРИГ</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-white/10 px-3 py-1.5 text-[9px] font-mono" role="status">
        <span className={recent24h ? 'text-[#9FDCE2]' : 'text-[#FFB454]'}>
          СВЕЖЕСТЬ ЛЕНТЫ · {recent3h} ЗА 3 Ч · {recent24h} ЗА 24 Ч
        </span>
        {recent24h === 0 && <span className="text-[#FFB454]">НЕТ ПУБЛИКАЦИЙ ЗА СУТКИ</span>}
      </div>

      {/* Source connectivity is independent from the age of the latest report.
          Expose it by touch instead of displaying an unconditional green LIVE dot. */}
      <div className="border-t border-white/5 px-3 py-2 text-[10px] font-mono">
        <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen} aria-controls="osiris-intel-source-health">
          <span style={{ color: failedSources || pausedSources || feedDelayed ? '#FFB454' : '#8FE4B1' }}>
            {sources.length ? liveConnections + '/' + sources.length + ' ДОСТУПНО · ' + reportedSources + ' С ПУБЛИКАЦИЯМИ' : 'ОЖИДАНИЕ ДАННЫХ ОБ ИСТОЧНИКАХ'}
            {pausedSources > 0 && <span> · {pausedSources} ПРИОСТАНОВЛЕНЫ</span>}
            {failedSources > 0 && <span> · {failedSources} ОШИБКИ</span>}
            {feedDelayed && <span> · ДАННЫЕ ЗАДЕРЖАНЫ</span>}
          </span>
          <ChevronDown className={sourcesOpen ? 'h-3 w-3 shrink-0 rotate-180 text-white/60' : 'h-3 w-3 shrink-0 text-white/60'} />
        </button>
        {sourcesOpen && (
          <div id="osiris-intel-source-health" role="region" aria-label="Состояние источников" className="mt-2 max-h-48 overflow-y-auto divide-y divide-white/10 border-t border-white/10">
            {fetchedAt && <div className="py-2 text-white/55">Данные сформированы: {timeAgo(fetchedAt)}</div>}
            {[...sources].sort((a, b) => Number(b.state === 'error' || b.state === 'degraded' || b.state === 'blocked') - Number(a.state === 'error' || a.state === 'degraded' || a.state === 'blocked')).map(source => (
              <div key={source.handle} className="flex items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate text-white/85">{source.name} <span className="text-white/40">· {source.kind === 'wire' ? 'RSS' : 'Telegram'}</span></div>
                  <div className="text-white/45">{source.count} публикаций · последняя: {source.latest ? timeAgo(source.latest) : 'нет данных'}</div>
                  {source.lastSuccessAt && <div className="text-white/45">Связь: {timeAgo(source.lastSuccessAt)}</div>}
                  {source.responseMs !== null && source.responseMs !== undefined && <div className="text-white/45">Последний ответ: {source.responseMs} мс</div>}
                  {source.nextRetryAt && <div className="text-white/45">Следующая попытка: {new Date(source.nextRetryAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>}
                  {source.pausedReason && <div className="text-[#FFB454]/70">{source.pausedReason} · повторный опрос отключён</div>}
                </div>
                <div className="max-w-28 shrink-0 text-right" style={{ color: source.state === 'error' || source.state === 'degraded' || source.state === 'blocked' || source.state === 'paused' ? '#FFB454' : '#8FE4B1' }}>{sourceLabel(source)}</div>
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
                    <h4 className="text-[11px] text-[var(--text-primary)] leading-snug break-words" title={headlineLanguage === 'ru' ? item.title : undefined}>
                      {headlineLanguage === 'ru' && translatedTitles[item.title] ? translatedTitles[item.title] : item.title}
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
                            ОТКРЫТЬ ПЕРВОИСТОЧНИК
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
