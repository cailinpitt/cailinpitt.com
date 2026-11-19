// Gas money a scooter ride saved, priced at what gas cost the week it happened.
// No imports, so the site's tests can load it without the Workers types.

/** EIA weekly retail regular gas, Lower Atlantic (PADD 1C): the region that includes Georgia. */
export const EIA_SERIES = 'EMM_EPMR_PTE_R1Z_DPG'
/** EIA's typical passenger car. Matches CAR_MPG on the site. */
export const CAR_MPG = 22

export function eiaUrl(apiKey: string, weeks: number): string {
  const params = new URLSearchParams({
    frequency: 'weekly',
    'data[0]': 'value',
    'facets[series][]': EIA_SERIES,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: String(weeks),
    api_key: apiKey,
  })
  return `https://api.eia.gov/v2/petroleum/pri/gnd/data/?${params}`
}

export interface WeekPrice {
  /** YYYY-MM-DD. */
  week: string
  /** Dollars per gallon. */
  price: number
}

/** The weeks in an EIA response, skipping rows without a usable price. Values arrive as strings. */
export function parseEiaPrices(body: unknown): WeekPrice[] {
  const rows = (body as { response?: { data?: unknown } })?.response?.data
  if (!Array.isArray(rows)) return []
  const out: WeekPrice[] = []
  for (const row of rows) {
    const { period, value } = (row ?? {}) as { period?: unknown; value?: unknown }
    const price = Number(value)
    if (typeof period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(period) && price > 0 && price < 20) {
      out.push({ week: period, price })
    }
  }
  return out
}

/** The price in effect on `date`: the latest week starting on or before it, else the earliest known. */
export function priceOn(date: string, prices: WeekPrice[]): number {
  let found = prices[0].price
  for (const p of prices) {
    if (p.week <= date) found = p.price
    else break
  }
  return found
}

/**
 * Dollars of gas the scooter's miles would have cost in a car. Logged rides are
 * priced at their own week; the odometer's miles from before the logger have no
 * date, so they take the price of the first logged ride. Null without prices.
 */
export function gasSaved(
  rides: { startDate: string; distanceMi: number }[],
  pricesAscending: WeekPrice[],
  odometerMi: number,
): number | null {
  if (!pricesAscending.length) return null
  const sorted = [...rides].sort((a, b) => a.startDate.localeCompare(b.startDate))
  let dollars = 0
  let logged = 0
  for (const ride of sorted) {
    dollars += (ride.distanceMi / CAR_MPG) * priceOn(ride.startDate, pricesAscending)
    logged += ride.distanceMi
  }
  const before = Math.max(odometerMi - logged, 0)
  const firstPrice = sorted.length
    ? priceOn(sorted[0].startDate, pricesAscending)
    : pricesAscending[pricesAscending.length - 1].price
  dollars += (before / CAR_MPG) * firstPrice
  return Math.round(dollars * 100) / 100
}
