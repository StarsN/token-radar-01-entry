// Token Launch Radar — the model.
//
// Everything the board claims is derived here, from the sealed snapshot alone:
// which protocols still record no token, what a launch would be worth if the
// record stayed as it is, and what a reader should do to farm each one. No
// protocol is named in this file: change the snapshot and the board changes.
//
// The method, in one paragraph. A protocol is a launch candidate when
// DefiLlama records no token for it (gecko_id and symbol both null) and it is
// not a wrapped, staked, bridged or exchange product of something that already
// trades: those are filtered by category, by name and by brand, below. Each
// survivor is valued the way its launched peers are valued: the median
// market-cap-to-TVL of the tokenised protocols in its own category, shrunk
// toward the market-wide median and winsorised to the range the launched
// market actually shows, then adjusted for seven-day momentum and for how
// long the protocol has run with no token. Every factor is printed on the
// board, so any row can be re-computed by hand.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  multiple: number;
  momentum_factor: number;
  maturity_factor: number;
  base_value_usd: number;
  watchlist: boolean;
}

export interface CompRow {
  category: string;
  launched: number;
  median_multiple: number;
  multiple_used: number;
}

export interface RadarStats {
  scanned: number;
  launched_set_aside: number;
  excluded: Record<string, number>;
  board_rows: number;
  watchlist_size: number;
  watchlist_covered: number;
  total_implied_usd: number;
  global_median_multiple: number;
}

export interface Radar {
  rows: BoardRow[];
  comps: CompRow[];
  launched: { name: string; category: string | null; tvl_usd: number; mcap_usd: number; multiple: number }[];
  stats: RadarStats;
}

/** Parse and lightly validate the sealed snapshot. Throws on a shape this program cannot read. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (typeof raw.as_of !== 'string' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: expected as_of, protocols[] and watchlist[]');
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error(`snapshot: a protocol is missing slug, name or tvl_usd`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The candidate filter. Each rule names what it removes and why; the counts
// land in the stats, so the dashboard can show its working.
// ---------------------------------------------------------------------------

/** Categories whose TVL is a balance of someone else's asset, or an exchange's
 *  own books: a bridge's custodied coins, a staking product's underlying, an
 *  exchange's reserves. None of them is a protocol waiting to launch. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'CEX',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Anchor BTC',
  'Decentralized BTC',
]);

/** Names that begin with an exchange's name are that exchange's own product. */
const EXCHANGE_PREFIXES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const VERSION_SUFFIX = /\s(V2|v2|2\.0)$/;

/** The brand of a name: its first word, lower-cased, punctuation stripped. */
export function brandOf(name: string): string {
  const first = name.toLowerCase().split(/[\s.\-/]+/).filter(Boolean)[0] ?? '';
  return first.replace(/[^a-z0-9]/g, '');
}

export type Exclusion = 'token' | 'category' | 'name' | 'exchange' | 'brand';

/** Why a protocol is not a launch candidate, or null when it is one. */
export function exclusionReason(p: Protocol, tokenBrands: Map<string, string>): Exclusion | null {
  if (p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null) return 'token';
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return 'category';
  if (PRODUCT_WORD.test(p.name) || VERSION_SUFFIX.test(p.name)) return 'name';
  const lower = p.name.toLowerCase();
  if (EXCHANGE_PREFIXES.some((e) => lower.startsWith(e))) return 'exchange';
  // A product line that carries the brand of a protocol whose token already
  // trades (a chain's mint, an exchange-less brand's swap arm) is that
  // protocol's product, not a separate launch waiting to happen.
  const owner = tokenBrands.get(brandOf(p.name));
  if (owner !== undefined && owner !== p.slug) return 'brand';
  return null;
}

// ---------------------------------------------------------------------------
// Calibration: what launched tokens are worth per dollar of TVL.
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const SHRINK_PRIOR = 8; // pseudo-count of the market-wide median in every category
const MULTIPLE_FLOOR = 0.02;
const MULTIPLE_CAP = 3.0;

export interface Calibration {
  globalMedian: number;
  byCategory: Map<string, { launched: number; median: number; used: number }>;
  fallback: number;
}

/** Multiples from the launched set: protocols that record a token and a TVL. */
export function calibrate(protocols: Protocol[]): Calibration {
  const launched = protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const globalMedian = median(launched.map((p) => p.mcap_usd! / p.tvl_usd));
  const groups = new Map<string, number[]>();
  for (const p of launched) {
    if (p.category === null) continue;
    const list = groups.get(p.category) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    groups.set(p.category, list);
  }
  const byCategory = new Map<string, { launched: number; median: number; used: number }>();
  for (const [category, ratios] of groups) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + SHRINK_PRIOR * globalMedian) / (ratios.length + SHRINK_PRIOR);
    byCategory.set(category, {
      launched: ratios.length,
      median: med,
      used: Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, shrunk)),
    });
  }
  return { globalMedian, byCategory, fallback: Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, globalMedian)) };
}

// ---------------------------------------------------------------------------
// The two adjustments. Each is small on purpose: the multiple does the work,
// these only shade it, and both are printed on every row.
// ---------------------------------------------------------------------------

/** Seven-day TVL momentum: a protocol growing into its launch is worth more
 *  than one draining away. change_7d is in per cent; the factor is damped
 *  (three quarters of the move) and clamped, so one wild week cannot rule. */
export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  const raw = 1 + (change7d / 100) * 0.75;
  return Math.min(1.75, Math.max(0.55, raw));
}

/** Track record: the longer a protocol has run with no token, the more users
 *  and history a launch would price in. Worth at most ±15% either way. A
 *  protocol with no recorded start date takes no adjustment. */
export function maturityFactor(listedAt: string | null, asOf: string): { factor: number; ageDays: number | null } {
  if (listedAt === null) return { factor: 1, ageDays: null };
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return { factor: 1, ageDays: null };
  const ageDays = Math.round((end - start) / 86_400_000);
  const years = ageDays / 365.25;
  return { factor: Math.min(1.15, Math.max(0.85, 0.85 + 0.075 * years)), ageDays };
}

// ---------------------------------------------------------------------------
// Farm plans. One playbook per kind of protocol, written against the row's own
// figures: its name, its main chain, a position sized to its TVL, and what
// that position is as a share of the whole. Every step names a cost or a time,
// because a plan without either is a slogan.
// ---------------------------------------------------------------------------

export function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function positionFor(tvl: number): { low: number; high: number } {
  if (tvl >= 500_000_000) return { low: 2000, high: 10000 };
  if (tvl >= 100_000_000) return { low: 1000, high: 5000 };
  if (tvl >= 25_000_000) return { low: 500, high: 2500 };
  return { low: 250, high: 1000 };
}

type Playbook = (c: {
  name: string;
  chain: string;
  chains: number;
  pos: string;
  share: string;
  tvl: string;
}) => string[];

const PLAYBOOKS: Record<string, Playbook> = {
  lending: (c) => [
    `Open ${c.name} on ${c.chain} with a wallet you control and deposit ${c.pos} of a major stablecoin or ETH as collateral. Setup takes about 15 minutes; the cost is gas only — a few dollars on most chains, $5–25 on Ethereum mainnet at typical fees.`,
    `Borrow 30–40% of the collateral's value and redeposit it once, a single gentle loop, then stop. Keep the health factor above 2.0 so an ordinary bad week cannot liquidate you, and spend two minutes a week checking it has stayed there.`,
    `Hold the position through at least 8–12 weekly snapshots. Points and airdrop screens reward duration and a steady balance far more than one large day, so resist topping up and withdrawing around rumoured snapshot dates.`,
    `Use ${c.name} as a borrower, not only a lender: repay and redraw a small loan about once a month, vote in any governance poll, and enrol in the points or rewards program if one is running — each is a separate, cheap signal of a real user.`,
    `Size the risk honestly: ${c.pos} is about ${c.share} of ${c.name}'s ${c.tvl} TVL, small enough to unwind in one transaction. Smart-contract and oracle risk ride on every position, so never farm with money you cannot afford to lose outright.`,
  ],
  dex: (c) => [
    `Open ${c.name} on ${c.chain} and make ten ordinary swaps across a week, the trades you would make anyway, before providing any liquidity. Cost is the swap fees plus a few dollars of gas; twenty minutes of actual use beats a single farmed burst.`,
    `Provide ${c.pos} to the deepest stable or blue-chip pool, split evenly on both sides, and leave it there. Concentrated ranges earn more but need rebalancing twice a week; a full-range position is the low-maintenance choice for a farm.`,
    `Keep the LP position open for at least 8–12 weeks and let fees compound in place. Liquidity that arrives and leaves inside a fortnight is exactly the pattern snapshot screens are built to discount.`,
    `Route your regular trading through ${c.name} whenever its price is within a few basis points of the market, and join any volume, points or governance program it runs — consistent weekly volume from one wallet is the signal that is hardest to fake.`,
    `Watch the impermanent loss, not just the fees: ${c.pos} is about ${c.share} of ${c.name}'s ${c.tvl} TVL, so your share of fees is thin and the position only pays if the pair stays range-bound or the launch rewards loyalty over size.`,
  ],
  yield: (c) => [
    `Open ${c.name} on ${c.chain} and deposit ${c.pos} into its flagship vault or curated strategy. Setup is one approval and one deposit, about ten minutes; cost is gas only, a few dollars on most chains and $5–25 on Ethereum mainnet.`,
    `Split the position across two strategies or curators inside ${c.name} rather than chasing the highest headline APY: the second-best vault with a longer record is usually the one still standing at snapshot time.`,
    `Leave the deposit untouched for at least 8–12 weeks. Vault shares that season quietly are the behaviour points programs are designed to find; churning between vaults resets most duration counters.`,
    `Claim and restake any points, rewards or governance weight on a weekly rhythm, and take part in one governance vote or feedback round — curators read engagement when they argue for how a launch should be shared.`,
    `Read the strategy's underlying exposures before you size up: ${c.pos} is about ${c.share} of ${c.name}'s ${c.tvl} TVL. Curated yield stacks risks — the vault, its curator and every market beneath it — so cap what a single failure could take.`,
  ],
  stake: (c) => [
    `Open ${c.name} on ${c.chain} and stake ${c.pos} of the chain's native asset from a wallet you control. One transaction, about five minutes; the cost is gas, and the position starts earning staking yield while it farms.`,
    `Hold through at least one full unbonding cycle's worth of weeks — 8–12 weeks is a fair season. Staking positions that survive volatility are the ones screens count; panic-unstaking at the first dip erases the record.`,
    `Delegate or restake a second, smaller tranche if ${c.name} offers more than one route, so your activity shows in two of its counters rather than one, without doubling the amount at risk.`,
    `Do the free things on schedule: claim rewards weekly, vote in governance when a poll opens, and keep the same wallet active on ${c.chain} for ordinary transfers, so the stake reads as one user's habit, not a parked deposit.`,
    `Remember the exit is slow by design: unbonding can lock ${c.pos} — about ${c.share} of ${c.name}'s ${c.tvl} TVL — for days or weeks, and the underlying asset can fall while you wait. Never stake money with a deadline attached.`,
  ],
  rwa: (c) => [
    `Register with ${c.name} and finish its onboarding on ${c.chain} first: real-world-asset platforms run identity checks, and completing them early is itself a filter many farmers fail. Allow a few days for review; there is no fee to register.`,
    `Subscribe ${c.pos} to its flagship asset or fund once approved, and hold the position to at least one full distribution or interest cycle, so the record shows a completed round trip of the product working as intended.`,
    `Keep the position for a season of 10–12 weeks and reinvest each distribution back into ${c.name} rather than withdrawing it: a growing, compounding balance is the clearest signal of a genuine holder.`,
    `Join the holder communications — attestations, investor updates, any governance or feedback channel — and answer one survey or call if offered. RWA launches reward identifiable, reachable holders more than anonymous size.`,
    `Underwrite the off-chain risk before sizing up: ${c.pos} is about ${c.share} of ${c.name}'s ${c.tvl} TVL, and behind it sit custodians, issuers and jurisdictions, not just contracts. Read who holds the assets and what happens on a default.`,
  ],
  trade: (c) => [
    `Open ${c.name} on ${c.chain}, fund a trading account with ${c.pos}, and place small, ordinary trades — the size you would trade anyway. Onboarding and a first trade take about 20 minutes; costs are trading fees plus a few dollars of gas.`,
    `Trade a little every week for 8–12 weeks rather than one large burst: open and close positions across different markets or expiries, so the record shows a returning trader, the profile points seasons are built to reward.`,
    `Keep drawdowns boring. A farmer's edge is survival, not profit: cap each position so a liquidation is impossible at normal leverage, and never add margin to defend a losing trade for the sake of volume.`,
    `Use the surrounding product — leaderboards, seasons, referral-free volume tiers, governance votes if any — and keep the same account throughout. Fragmenting activity across wallets is the classic way to be filtered out as a sybil.`,
    `Count the real cost before you start: fees on ${c.pos} turned over weekly can reach several hundred dollars over a season, against a hoped-for share of ${c.name}'s launch on ${c.tvl} TVL. If the fees outgrow the thesis, stop.`,
  ],
  chain: (c) => [
    `Bridge ${c.pos} onto ${c.name}'s network from ${c.chain === 'Ethereum' ? 'a major exchange or bridge' : 'Ethereum'} and keep the balance there: a chain's own launch maths starts from wallets that hold and use its native asset. Bridging takes about 15 minutes plus bridge fees.`,
    `Use three or four of the chain's native applications in your first week — a swap, a lending market, a name or NFT mint — so the wallet reads as a resident, not a tourist who arrived for one snapshot.`,
    `Stay active for a season: one or two ordinary transactions a week for 10–12 weeks, including some in quiet weeks. Chains reward the wallets that were there before any campaign was announced.`,
    `Hold a small governance or staking position if ${c.name} offers one, and vote when a proposal opens. On a chain, the future token is usually the governance asset, and early voters are its natural first holders.`,
    `Keep the exit in mind: ${c.pos} is about ${c.share} of the ${c.tvl} TVL ${c.name} reports. Bridge liquidity back out can thin without warning, so keep only a farming allocation on a young chain, never your reserves.`,
  ],
  core: (c) => [
    `Open ${c.name} on ${c.chain} and complete its core action end to end — the deposit, mint, subscription or trade the product exists for — with ${c.pos}. Setup takes about 15 minutes; the cost is gas only, a few dollars on most chains.`,
    `Repeat the core action on a weekly rhythm for 8–12 weeks, in ordinary sizes. Whatever a launch screen measures, it is almost always consistency: distinct weeks active beats one heroic day, every time.`,
    `Grow the position slowly toward the top of your ${c.pos} range as the record builds, rather than arriving at full size on day one — a rising balance from one wallet is the profile of a user, not a mercenary.`,
    `Take every free engagement ${c.name} offers: a points program, a testnet, a governance vote, an early-access list. Each takes minutes, costs nothing but gas, and puts the wallet in another of the counters a launch can reward.`,
    `Keep the risk in proportion: ${c.pos} is about ${c.share} of ${c.name}'s ${c.tvl} TVL. A pre-token protocol owes you nothing for farming it, so treat the whole position as spent on a possibility, never as an investment with a date.`,
  ],
};

const CATEGORY_PLAYBOOK: Record<string, keyof typeof PLAYBOOKS> = {
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  CDP: 'lending',
  'CDP Manager': 'lending',
  'Collateral Markets': 'lending',
  Dexs: 'dex',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  'Onchain Capital Allocator': 'yield',
  'Risk Curators': 'yield',
  'Liquidity Manager': 'yield',
  'Leveraged Farming': 'yield',
  Farm: 'yield',
  'Basis Trading': 'yield',
  Restaking: 'stake',
  'Staking Pool': 'stake',
  RWA: 'rwa',
  Derivatives: 'trade',
  'Interest Rate Derivatives': 'trade',
  Options: 'trade',
  'Options Vault': 'trade',
  Synthetics: 'trade',
  'Prediction Market': 'trade',
  Chain: 'chain',
};

/** The farm plan for one protocol: five concrete steps built from its record. */
export function farmSteps(p: Protocol): string[] {
  const pos = positionFor(p.tvl_usd);
  const sharePct = (pos.low / p.tvl_usd) * 100;
  const share = sharePct >= 0.1 ? `${sharePct.toFixed(2)}%` : `${sharePct.toFixed(3)}%`;
  const book = PLAYBOOKS[CATEGORY_PLAYBOOK[p.category ?? ''] ?? 'core']!;
  return book({
    name: p.name,
    chain: p.chains[0] ?? 'Ethereum',
    chains: p.chains.length,
    pos: `${money(pos.low)}–${money(pos.high)}`,
    share,
    tvl: money(p.tvl_usd),
  });
}

// ---------------------------------------------------------------------------
// The board itself.
// ---------------------------------------------------------------------------

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Build the ranked board, the calibration table and the launched reference set. */
export function buildRadar(snapshot: Snapshot): Radar {
  const tokenBrands = new Map<string, string>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && !tokenBrands.has(brandOf(p.name))) tokenBrands.set(brandOf(p.name), p.slug);
  }
  const calibration = calibrate(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);

  const excluded: Record<string, number> = {};
  const candidates: Protocol[] = [];
  let launchedSetAside = 0;
  for (const p of snapshot.protocols) {
    const reason = exclusionReason(p, tokenBrands);
    if (reason === 'token') {
      launchedSetAside++;
    } else if (reason !== null) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
    } else {
      candidates.push(p);
    }
  }

  const scored = candidates.map((p) => {
    const comp = p.category !== null ? calibration.byCategory.get(p.category) : undefined;
    const multiple = comp !== undefined ? comp.used : calibration.fallback;
    const mom = momentumFactor(p.change_7d);
    const mat = maturityFactor(p.listed_at, snapshot.as_of);
    const base = p.tvl_usd * multiple;
    const implied = Math.max(1, Math.round(base * mom * mat.factor));
    return { p, multiple, mom, mat, base, implied };
  });
  // A total order, so two runs write the same bytes: value, then TVL, then slug.
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: BoardRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.implied,
    farm_steps: farmSteps(s.p),
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.mat.ageDays,
    multiple: round4(s.multiple),
    momentum_factor: round4(s.mom),
    maturity_factor: round4(s.mat.factor),
    base_value_usd: Math.round(s.base),
    watchlist: watchlist.has(s.p.slug),
  }));

  const comps: CompRow[] = [...calibration.byCategory.entries()]
    .map(([category, c]) => ({ category, launched: c.launched, median_multiple: round4(c.median), multiple_used: round4(c.used) }))
    .sort((a, b) => b.launched - a.launched || (a.category < b.category ? -1 : 1));

  const launched = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 12)
    .map((p) => ({
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: round4(p.mcap_usd! / p.tvl_usd),
    }));

  return {
    rows,
    comps,
    launched,
    stats: {
      scanned: snapshot.protocols.length,
      launched_set_aside: launchedSetAside,
      excluded,
      board_rows: rows.length,
      watchlist_size: snapshot.watchlist.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      total_implied_usd: rows.reduce((sum, r) => sum + r.implied_value_usd, 0),
      global_median_multiple: round4(calibration.globalMedian),
    },
  };
}

/** The gate's board rules, checked before anything is written: a board this
 *  function accepts is a board the scorer's board rows accept. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100–4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!slugs.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row ${i + 1}: slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}, expected ${i + 1}`;
    if (!(row.implied_value_usd > 0) || row.implied_value_usd > 100_000_000_000_000) return `row ${i + 1}: implied value out of range`;
    if (row.implied_value_usd > previous) return `row ${i + 1}: implied value rises as rank ascends`;
    previous = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${i + 1}: ${row.farm_steps.length} farm steps, outside 3–12`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${i + 1}: a farm step is ${len} characters, outside 20–600`;
    }
  }
  if (rows.every((r) => r.implied_value_usd === rows[0]!.implied_value_usd)) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data, as a script the page loads: window.RADAR. */
export function dataScript(snapshot: Snapshot, radar: Radar): string {
  const payload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    stats: radar.stats,
    comps: radar.comps,
    launched: radar.launched,
    rows: radar.rows,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
