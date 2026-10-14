// src/screens/calls/dayFilterUtils.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Pure logic for the "Calls by Day" lead filters (no React Native in here — easy to test):
//   • "New on this day"  — only leads newly assigned on the selected day
//   • Ad filter          — campaign → ad set → ad (a Google ad group counts as an ad set)
//
// The server (GET /call-logs/lead-filters) sends a tree of what exists for the selected day:
//   { assignedCount, total, campaigns: [{ value, label, count, adSets: [{ value, label, count, ads: [{ value, label, count }] }] }] }
// where value NONE means "nothing recorded" (no campaign / no ad set / no ad).
// ─────────────────────────────────────────────────────────────────────────────

export const NONE = '__none__';
export const EMPTY_AD = { campaign: '', adsetId: '', adId: '' };

export const hasAdFilter = (f) => !!(f && (f.campaign || f.adsetId || f.adId));

// Request params for /call-logs and /call-logs/uncalled
export function adParams(f) {
  const p = {};
  if (f && f.campaign) p.campaign = f.campaign;
  if (f && f.adsetId)  p.adsetId  = f.adsetId;
  if (f && f.adId)     p.adId     = f.adId;
  return p;
}
export const leadFilterQuery = ({ assignedOnly, ad } = {}) => ({ ...(assignedOnly ? { assigned: 'day' } : {}), ...adParams(ad) });
export const leadFilterKey = (state) => JSON.stringify(leadFilterQuery(state));

const campaigns = (tree) => (tree && Array.isArray(tree.campaigns) ? tree.campaigns : []);

// merge items with the same value (an ad set / ad can sit under several campaigns' "none" buckets)
function mergeBy(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const it of list) {
      if (!m.has(it.value)) m.set(it.value, { ...it });
      else { const cur = m.get(it.value); cur.count += it.count; if (it.ads) cur.ads = [...(cur.ads || []), ...it.ads]; }
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

export const campaignList = (tree) => campaigns(tree);

// Ad sets of the chosen campaign (or of every campaign when none is chosen)
export function adSetList(tree, campaign) {
  const cs = campaign ? campaigns(tree).filter((c) => c.value === campaign) : campaigns(tree);
  return mergeBy(cs.map((c) => c.adSets || [])).map(({ ads, ...rest }) => rest);
}

// Ads of the chosen ad set / campaign (or of everything when nothing is chosen)
export function adList(tree, campaign, adsetId) {
  const cs = campaign ? campaigns(tree).filter((c) => c.value === campaign) : campaigns(tree);
  const sets = cs.flatMap((c) => (c.adSets || []).filter((s) => !adsetId || s.value === adsetId));
  return mergeBy(sets.map((s) => s.ads || []));
}

const findCampaigns = (tree, pred) => campaigns(tree).filter(pred);

// ── choosing ─────────────────────────────────────────────────────────────────
// Choosing a higher level drops lower choices that no longer fit; choosing a lower level when the higher one is
// blank fills the higher one in — when it can only be one thing (an ad set belongs to one campaign).
export function chooseCampaign(f, value, tree) {
  const next = { campaign: value || '', adsetId: f.adsetId, adId: f.adId };
  if (!value) return { ...EMPTY_AD };
  if (next.adsetId && !adSetList(tree, value).some((s) => s.value === next.adsetId)) { next.adsetId = ''; next.adId = ''; }
  if (next.adId && !adList(tree, value, next.adsetId).some((a) => a.value === next.adId)) next.adId = '';
  return next;
}

export function chooseAdSet(f, value, tree) {
  if (!value) return { campaign: f.campaign, adsetId: '', adId: '' };
  const next = { campaign: f.campaign, adsetId: value, adId: f.adId };
  if (!next.campaign && value !== NONE) {
    const owners = findCampaigns(tree, (c) => (c.adSets || []).some((s) => s.value === value));
    if (owners.length === 1) next.campaign = owners[0].value;
  }
  if (next.adId && !adList(tree, next.campaign, value).some((a) => a.value === next.adId)) next.adId = '';
  return next;
}

export function chooseAd(f, value, tree) {
  if (!value) return { ...f, adId: '' };
  const next = { campaign: f.campaign, adsetId: f.adsetId, adId: value };
  if (value !== NONE && (!next.campaign || !next.adsetId)) {
    const owners = findCampaigns(tree, (c) => (c.adSets || []).some((s) => (s.ads || []).some((a) => a.value === value)));
    if (owners.length === 1) {
      if (!next.campaign) next.campaign = owners[0].value;
      if (!next.adsetId) {
        const sets = owners[0].adSets.filter((s) => (s.ads || []).some((a) => a.value === value));
        if (sets.length === 1) next.adsetId = sets[0].value;
      }
    }
  }
  return next;
}

// The tree changes with the day (and with "New on this day"). Drop any choice that no longer exists so the screen
// can't get stuck on an empty list. Do nothing until a tree has loaded.
export function pruneAdFilter(f, tree) {
  if (!tree || !hasAdFilter(f)) return f;
  let { campaign, adsetId, adId } = f;
  if (campaign && !campaigns(tree).some((c) => c.value === campaign)) return { ...EMPTY_AD };
  if (adsetId && !adSetList(tree, campaign).some((s) => s.value === adsetId)) { adsetId = ''; adId = ''; }
  if (adId && !adList(tree, campaign, adsetId).some((a) => a.value === adId)) adId = '';
  return (campaign === f.campaign && adsetId === f.adsetId && adId === f.adId) ? f : { campaign, adsetId, adId };
}

// ── labels ───────────────────────────────────────────────────────────────────
const labelOf = (list, value) => { const it = list.find((x) => x.value === value); return it ? it.label : ''; };

// For the pill: the most specific thing chosen ("Video v2"), else the campaign, else "All".
export function adFilterLabel(f, tree) {
  if (!hasAdFilter(f)) return 'All';
  if (f.adId)    return labelOf(adList(tree, f.campaign, f.adsetId), f.adId) || 'Selected ad';
  if (f.adsetId) return labelOf(adSetList(tree, f.campaign), f.adsetId) || 'Selected ad set';
  return labelOf(campaignList(tree), f.campaign) || f.campaign;
}

// For the summary line in the sheet: campaign › ad set › ad
export function adFilterTrail(f, tree) {
  const parts = [];
  if (f.campaign) parts.push(labelOf(campaignList(tree), f.campaign) || f.campaign);
  if (f.adsetId)  parts.push(labelOf(adSetList(tree, f.campaign), f.adsetId) || 'Ad set');
  if (f.adId)     parts.push(labelOf(adList(tree, f.campaign, f.adsetId), f.adId) || 'Ad');
  return parts;
}

export function filterSearch(list, q) {
  const s = String(q || '').trim().toLowerCase();
  return s ? list.filter((it) => String(it.label).toLowerCase().includes(s)) : list;
}

// ── the ad line on a lead card ───────────────────────────────────────────────
// "Founders › Video v2" (ad set › ad). Uses the server's `ad` summary when present, else the raw lead fields
// (the populated lead on a call-log row). Empty string when the lead has no ad information.
export function adLine(lead) {
  if (!lead) return '';
  const a = lead.ad;
  let set = '', ad = '';
  if (a && typeof a === 'object') { set = a.adSet || ''; ad = a.ad || ''; }
  else {
    const at = lead.attribution || {};
    const setId = at.metaAdsetId || at.googleAdGroupId || '';
    set = lead.adSetName || (setId ? `Ad set …${String(setId).slice(-6)}` : '');
    ad  = at.metaAdName || (at.metaAdId ? `Ad …${String(at.metaAdId).slice(-6)}` : '');
  }
  return [set, ad].filter(Boolean).join(' › ');
}
