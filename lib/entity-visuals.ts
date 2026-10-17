import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Jimp } from 'jimp';
import { getDatabase } from './db';
import { remainingVisualMs, type VisualApiBudget } from './gemini-pool';
import { loadYuNet, detectFacesYunet } from '../worker/yunet-detector';
import type { VisualEntity, VisualFaceCheck } from './types';
import type { RawProviderCandidate } from './visual-providers';

const TTL = 30 * 86400000;
const strip = (value = '') => value.replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').trim();
const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
// No face recognition: labels/descriptions/QIDs are the ONLY identity inputs.
export function chooseEntity(entity: VisualEntity, hits: Array<{ id: string; label?: string; description?: string; aliases?: string[] }>): VisualEntity | undefined {
  if (entity.type === 'person' && !entity.public_figure) return;
  const exact = hits.filter((hit) => /^Q\d+$/.test(hit.id) && [hit.label, ...(hit.aliases ?? [])].some((name) => name && canonical(name) === canonical(entity.name)));
  const context = new Set(entity.description_en.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const ranked = exact.map((hit) => ({ hit, score: (hit.description?.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => context.has(word)).length })).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score <= ranked[1].score)) return;
  const winner = ranked[0].hit;
  if (entity.type === 'person' && !/actor|actress|model|singer|musician|writer|author|politician|athlete|presenter|celebrity|socialite|business|royal|influencer|comedian|filmmaker|journalist|television/i.test(winner.description ?? '')) return;
  return { ...entity, name: winner.label ?? entity.name, qid: winner.id, description_en: winner.description ?? entity.description_en };
}

let wikiActive = 0;
const wikiWaiters: Array<() => void> = [];
async function wiki(host: 'www.wikidata.org' | 'en.wikipedia.org' | 'commons.wikimedia.org', params: Record<string, string>, userAgent: string, budget?: VisualApiBudget): Promise<Record<string, unknown>> {
  if (!userAgent.trim()) throw new Error('Configure Wikimedia User-Agent');
  if (wikiActive >= 2) await new Promise<void>((resolve, reject) => {
    const grant = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { const index = wikiWaiters.indexOf(grant); if (index >= 0) wikiWaiters.splice(index, 1); reject(new Error('Wikimedia deadline waiting for slot')); }, remainingVisualMs(budget, 2500));
    wikiWaiters.push(grant);
  }); else wikiActive++;
  try {
    const url = new URL(`https://${host}/w/api.php`);
    for (const [key, value] of Object.entries({ ...params, format: 'json', maxlag: '5' })) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(remainingVisualMs(budget, 2000)) });
    if (!response.ok) throw new Error(`Wikimedia HTTP ${response.status}; no retry storm`);
    const data = await response.json() as Record<string, unknown>;
    if (data.error) throw new Error('Wikimedia API unavailable/maxlag; skipped');
    return data;
  } finally { const next = wikiWaiters.shift(); if (next) next(); else wikiActive--; }
}

export async function resolvePublicEntity(entity: VisualEntity, userAgent: string, budget?: VisualApiBudget): Promise<VisualEntity | undefined> {
  if (entity.type === 'person' && !entity.public_figure) return;
  const key = `${entity.type}:${canonical(entity.name)}:${canonical(entity.description_en)}`;
  const saved = getDatabase().prepare('SELECT entity_json FROM entity_resolution_cache WHERE name = ? AND expires_at > ?').get(key, Date.now()) as { entity_json: string } | undefined;
  if (saved) return JSON.parse(saved.entity_json) as VisualEntity;
  const data = await wiki('www.wikidata.org', { action: 'wbsearchentities', search: entity.name, language: 'en', uselang: 'en', type: 'item', limit: '5' }, userAgent, budget);
  const resolved = chooseEntity(entity, (data.search ?? []) as Array<{ id: string; label?: string; description?: string; aliases?: string[] }>);
  if (resolved) getDatabase().prepare('INSERT INTO entity_resolution_cache (name,entity_json,expires_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET entity_json=excluded.entity_json, expires_at=excluded.expires_at').run(key, JSON.stringify(resolved), Date.now() + TTL);
  return resolved;
}

type WikiPage = { title?: string; pageid?: number; pageimage?: string; imageinfo?: Array<{ url?: string; thumburl?: string; width?: number; height?: number; timestamp?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }> };
function commonsCandidates(data: Record<string, unknown>, entity: VisualEntity, evidence: string): RawProviderCandidate[] {
  const pages = (data.query as { pages?: Record<string, WikiPage> } | undefined)?.pages ?? {};
  return Object.values(pages).flatMap((page) => {
    const info = page.imageinfo?.[0]; const meta = info?.extmetadata;
    if (!info?.url || !meta?.LicenseShortName?.value) return [];
    return [{ provider: 'wikimedia' as const, assetId: String(page.pageid), title: strip(page.title),
      description: `${strip(meta.ImageDescription?.value)} ${entity.name}`, alt: '', tags: [], creator: strip(meta.Artist?.value),
      licenseRaw: strip(meta.LicenseShortName.value), licenseUrl: meta.LicenseUrl?.value,
      sourcePageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title ?? '')}`,
      imageUrl: info.url, thumbnailUrl: info.thumburl ?? info.url, width: info.width ?? 0, height: info.height ?? 0,
      entityQid: entity.qid, entitySourcePriority: evidence.startsWith('Commons category') ? 2 : 1, identityEvidence: evidence, uploadedAt: info.timestamp }];
  });
}

export async function entityImageCandidates(entity: VisualEntity, userAgent: string, budget?: VisualApiBudget): Promise<RawProviderCandidate[]> {
  if (!entity.qid) return [];
  const cached = getDatabase().prepare('SELECT candidate_json,local_path,content_hash FROM entity_visual_cache WHERE qid = ? AND expires_at > ? LIMIT 12').all(entity.qid, Date.now()) as Array<{ candidate_json: string; local_path: string; content_hash: string }>;
  const results: RawProviderCandidate[] = cached.flatMap((row) => fs.existsSync(row.local_path) && crypto.createHash('sha256').update(fs.readFileSync(row.local_path)).digest('hex') === row.content_hash ? [{ ...JSON.parse(row.candidate_json), verifiedLocalPath: row.local_path }] : []);
  // Optional library is explicit user-supplied identity evidence, never a face match.
  const root = path.resolve('data/celebrity-library');
  if (fs.existsSync(root)) for (const directory of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && canonical(entry.name) === canonical(entity.name))) {
    const dir = path.join(root, directory.name);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 24)) {
      if (!entry.isFile() || !/\.(jpe?g|png|webp)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      remainingVisualMs(budget);
      if (fs.statSync(file).size > 12 * 1024 * 1024) continue;
      try {
        const credits = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')) as { qid: string; creator: string; license: string; sourcePageUrl: string };
        if (credits.qid !== entity.qid || !credits.creator || !credits.sourcePageUrl || !credits.license) continue;
        const image = await Jimp.read(file);
        results.unshift({ provider: 'wikimedia', assetId: `library-${crypto.createHash('sha256').update(file).digest('hex').slice(0, 20)}`, title: `${entity.name} — ${entry.name}`, description: entity.description_en, alt: '', tags: [], creator: credits.creator, licenseRaw: credits.license, sourcePageUrl: credits.sourcePageUrl, imageUrl: credits.sourcePageUrl, width: image.width, height: image.height, verifiedLocalPath: file, entityQid: entity.qid, entitySourcePriority: 0, identityEvidence: `User library sidecar ${entity.qid}` });
      } catch { /* Missing/invalid credits or unsupported image is not usable. */ }
    }
  }
  if (results.length >= 3) return results;
  const data = await wiki('www.wikidata.org', { action: 'wbgetentities', ids: entity.qid, props: 'claims|sitelinks', languages: 'en' }, userAgent, budget);
  type Claim = { mainsnak?: { datavalue?: { value?: unknown } } };
  const item = (data.entities as Record<string, { claims?: Record<string, Claim[]>; sitelinks?: Record<string, { title?: string }> }> | undefined)?.[entity.qid];
  const image = item?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  const category = item?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
  const common = { action: 'query', prop: 'imageinfo', iiprop: 'url|size|extmetadata|timestamp', iiurlwidth: '1920', iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription' };
  if (typeof image === 'string') results.push(...commonsCandidates(await wiki('commons.wikimedia.org', { ...common, titles: `File:${image}` }, userAgent, budget), entity, `Wikidata ${entity.qid} P18`));
  else if (item?.sitelinks?.enwiki?.title) {
    const lead = await wiki('en.wikipedia.org', { action: 'query', titles: item.sitelinks.enwiki.title, prop: 'pageimages', piprop: 'name', pilicense: 'free' }, userAgent, budget);
    const pages = (lead.query as { pages?: Record<string, WikiPage> } | undefined)?.pages ?? {};
    const name = Object.values(pages)[0]?.pageimage;
    if (name) results.push(...commonsCandidates(await wiki('commons.wikimedia.org', { ...common, titles: `File:${name}` }, userAgent, budget), entity, `Wikipedia lead via ${entity.qid}`));
  }
  if (typeof category === 'string') results.push(...commonsCandidates(await wiki('commons.wikimedia.org', { ...common, generator: 'categorymembers', gcmtitle: `Category:${category}`, gcmtype: 'file', gcmlimit: '12' }, userAgent, budget), entity, `Commons category ${category} via ${entity.qid}`));
  return results;
}

const faceCache = new Map<string, VisualFaceCheck>();
/** Detection of boxes only, never identity/embeddings. Coordinates map back to original pixels. */
export async function inspectVisualFaces(file: string): Promise<VisualFaceCheck> {
  const bytes = fs.readFileSync(file); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const cached = faceCache.get(hash); if (cached) return cached;
  const runtime = await loadYuNet(); if (!runtime) throw new Error('YuNet unavailable; person/B-roll face safety cannot be verified');
  const { inspectImageBuffer } = await import('./visual-providers'); inspectImageBuffer(bytes);
  const image = await Jimp.read(bytes); const width = image.width; const height = image.height;
  image.scaleToFit({ w: 640, h: 640 });
  const faces = await detectFacesYunet(runtime, { data: image.bitmap.data, width: image.width, height: image.height }, { tiling: 'off' });
  const prominent = faces.filter((face) => face.box.width / image.width >= 0.12 || face.box.width * face.box.height / (image.width * image.height) >= 0.015).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  const box = prominent[0]?.box;
  const result: VisualFaceCheck = { prominent: prominent.length, total: faces.length, width, height, face: box ? { x: box.x * width / image.width, y: box.y * height / image.height, width: box.width * width / image.width, height: box.height * height / image.height } : undefined };
  if (faceCache.size > 500) faceCache.clear(); faceCache.set(hash, result); return result;
}

export function rememberEntityImage(entity: VisualEntity, candidate: RawProviderCandidate, file: string) {
  if (!entity.qid || !candidate.identityEvidence) return;
  getDatabase().prepare('INSERT INTO entity_visual_cache (qid,asset_id,candidate_json,local_path,content_hash,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(qid,asset_id) DO UPDATE SET candidate_json=excluded.candidate_json, local_path=excluded.local_path, content_hash=excluded.content_hash, expires_at=excluded.expires_at').run(entity.qid, candidate.assetId, JSON.stringify(candidate), file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), Date.now() + TTL);
}


export const passesVisualFacePolicy = (check: VisualFaceCheck, broll: boolean): boolean =>
  broll ? check.prominent === 0 : check.prominent === 1 && check.total === 1;
