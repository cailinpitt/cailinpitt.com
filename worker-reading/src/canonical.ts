// Url canonicalization, kept free of worker bindings so tests can import it.

/**
 * Query parameters that carry no meaning for the page itself. Stripping them
 * means the same article shared from two places dedupes to one row.
 *
 * Deliberately *not* included: `s` (WordPress search), `q`, `id`, `p` — those
 * change which page you land on.
 */
const TRACKING_PARAM = new RegExp(
  '^(' +
    [
      'utm_[a-z_]+', 'ref', 'ref_src', 'referrer', 'source', 'cmpid', 'ncid', 'spm', 'si', 'smid', 'icid', 'ito',
      'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid', '_ga', '_gl', 'srsltid',
      'fbclid', 'mibextid', '__tn__', 'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
      'igshid', 'twclid', '__twitter_impression', 'ttclid', 'is_from_webapp', 'sender_device',
      'li_fat_id', 'trk', 'trackingid', 'lipi', 'msclkid', 'cvid', 'ocid', 'yclid', 'ysclid',
      'mc_cid', 'mc_eid', '_hsenc', '_hsmi', '__hstc', '__hssc', '__hsfp', 'hsctatracking', 'mkt_tok', '_kx',
      'vero_id', 'oly_enc_id', 'oly_anon_id', 'at_medium', 'at_campaign', 's_cid', 's_kwcid', 'ef_id',
      'mtm_[a-z_]+', 'pk_[a-z_]+', 'piwik_[a-z_]+', 'matomo_[a-z_]+', '_branch_match_id', '_branch_referrer',
      'guccounter', 'guce_referrer', 'guce_referrer_sig', 'irclickid', 'wickedid', 'rb_clickid', 'share_id', 'sr_share',
      'cmp', 'leadsource', 'referringsource', 'mrfcid',
    ].join('|') +
    ')$',
  'i',
)

/** Params that are only noise on particular sites — too generic to strip everywhere. */
const SITE_TRACKING_PARAMS: [host: RegExp, param: RegExp][] = [
  [/(^|\.)(x|twitter)\.com$/, /^(s|t)$/],
  [/(^|\.)(youtube\.com|youtu\.be)$/, /^(feature|pp|ab_channel)$/],
  [/(^|\.)instagram\.com$/, /^igsh$/],
  [/(^|\.)substack\.com$/, /^(r|triedredirect|isfreemail|post_id|publication_id)$/i],
  [/(^|\.)blogspot\.com$/, /^m$/],
]

/**
 * Normalize a url so the same article always hashes to the same id: drop the
 * fragment and tracking parameters, sort what's left (share links vary the
 * order), and drop a trailing slash.
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname.includes('.')) return null

  url.hash = ''
  const siteParams = SITE_TRACKING_PARAMS.filter(([host]) => host.test(url.hostname)).map(([, param]) => param)
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key) || siteParams.some((param) => param.test(key))) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
  }
  return url.toString()
}
