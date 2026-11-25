// Crowd sniper with a second-wind rider, for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// What the dev window teaches, in one paragraph: a new coin's fate is mostly
// settled within its first minute. Of the 1,222 coins in the window, 286 more than
// doubled from their create price and the median time to that peak was 52 slots
// (~21 seconds); the median coin ends the window flat, so sitting still is a slow
// bleed and the money is in catching a spike early and leaving. The opening tape
// is the only honest signal available: several unrelated wallets buying, SOL
// flowing in faster than it flows out, and the price already climbing off its
// create level. A launch whose first buyers are one or two wallets is usually the
// creator's own cluster waiting to dump, so this bot wants a crowd, not a whale.
//
// This bot hunts in one place, with two other legs measured and rejected:
//
//   1. FIRST LIGHT (age 0-4 slots): the snipe. Buy the moment the opening
//      tape shows a real crowd: at least `flMinBuyers` distinct non-creator
//      buyers, net SOL in of at least `flMinNetSol`, price already up
//      `flMinRunupBps` from create, real reserve inside `flMinRealSol..flMaxRealSol`,
//      creator has not sold yet. Age 4 (not 3) is the shipped window: some
//      launches are one slot slow to show their crowd, and the extra slot
//      adds 12 coins and +0.07 SOL on the dev window; age 5-6 add coins but
//      lose money per coin.
//   2. SECOND WIND (age `swMinAge..swMaxAge`): REJECTED. Coins that keep
//      attracting buyers after the first-light window still lose money when
//      bought — by the time the crowd has fully formed, the move is priced
//      in (+0.888 with the leg on vs +0.949 without, on the dev window).
//   3. CREATOR-EXIT RIDE (age `rcMinAge..rcMaxAge`): REJECTED. Buying coins
//      whose price recovered past the creator's sell level loses money on its
//      own (-0.224 SOL standalone) and its small combined gain is interaction
//      noise concentrated in the window's second half. The first-light leg
//      carries the whole edge; this leg stays in the code, switched off, so
//      the measurement can be repeated.
//
// Exits are the same discipline for every leg: the whole position exits at
// `tpBps` (+35%) — there is deliberately no early bank, because banking half
// at +10%/+20% cost money on every variant tested; the partial take-profit
// at `tp1Bps` (+40%) only ever fires on a one-batch gap-up past +35%.
// Cut everything at `slBps` below cost, trail the best value once the
// position has been up `trailArmBps` and then gives back `trailBps`, leave
// the moment the creator sells while held (unless the position was entered
// *after* that sell), leave when the coin goes quiet for `staleSlots`, and
// never hold past `maxHold` slots. The loose exits are the second half of
// the edge: stale 25 (not 10) and hold 250 (not 90) together added +0.24 SOL
// on the dev window, because most runners need room to breathe before they
// pop. One buy per coin, ever; no averaging down.
//
// Deterministic by construction: no clock, no environment, no randomness. Every
// amount is integer lamports computed from the reserves the harness reports, and
// every iteration is over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** A buy that failed or was rejected may be tried again while its entry window is open. */
  retryFailedBuys: boolean;

  /** First-light leg on/off. */
  useFirstLight: boolean;
  /** Youngest / oldest age (slots since CreateEvent) for a first-light buy. */
  flMinAge: number;
  flMaxAge: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  flMinBuyers: number;
  /** Net SOL bought minus sold before entry, at least. */
  flMinNetSol: number;
  /** Price now over the create price, in bps: entry window. */
  flMinRunupBps: number;
  flMaxRunupBps: number;
  /** Creator sold before entry: skip the coin (first-light leg only). */
  flSkipDevSold: boolean;

  /** Second-wind leg on/off. */
  useSecondWind: boolean;
  /** Age window (slots since create) for a second-wind buy. */
  swMinAge: number;
  swMaxAge: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  swMinBuyers: number;
  /** Price now over the create price, in bps, at least. */
  swMinRunupBps: number;
  /** Recent-flow window (slots) and what it must show. */
  swWindowSlots: number;
  swMinFlowSol: number;
  /** New distinct buyers inside the recent-flow window, at least. */
  swMinNewBuyers: number;

  /** Creator-exit ride leg on/off. */
  useRecovery: boolean;
  /** Age window (slots since create) for a recovery buy. */
  rcMinAge: number;
  rcMaxAge: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  rcMinBuyers: number;
  /** Price now over the create price, in bps, at least. */
  rcMinRunupBps: number;
  /** Price now over the price at the creator's sell, in bps, at least. */
  rcMinRecoveryBps: number;
  /** Recent-flow window (slots) and the net SOL it must show, at least. */
  rcWindowSlots: number;
  rcMinFlowSol: number;

  /** First take-profit: sell this share of the position once it is worth this much over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least this much, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held (unless entered after that sell). */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots (0 = off). */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.5,
  minBuySol: 0.012,
  minRealSol: 3,
  maxRealSol: 60,
  buySlippageBps: 10_000,
  // Measured and REJECTED across 3 failure-draw seeds (sim): retrying a
  // failed buy recovers the trade at a worse price and displaces a fresh
  // first-light entry — mean -0.014 SOL vs not retrying (-0.038 / -0.004 /
  // 0.000). The code stays, switched off, so the measurement can repeat.
  retryFailedBuys: false,

  useFirstLight: true,
  flMinAge: 0,
  flMaxAge: 3,
  flMinBuyers: 11,
  flMinNetSol: 2,
  flMinRunupBps: 300,
  flMaxRunupBps: 100_000,
  flSkipDevSold: true,

  // Measured and REJECTED on the dev window (see README): second-wind entries
  // (age 5-12) dilute the result (+0.888 vs +0.949 first-light only) — by the
  // time the crowd has fully formed, the move is already priced in.
  useSecondWind: false,
  swMinAge: 4,
  swMaxAge: 12,
  swMinBuyers: 20,
  swMinRunupBps: 1200,
  swWindowSlots: 6,
  swMinFlowSol: 0.5,
  swMinNewBuyers: 3,

  // Measured and REJECTED on the dev window (see README): the recovery leg
  // LOSES money on its own (-0.224 SOL standalone) and its combined gain
  // (+0.036) is interaction noise concentrated in the second half; the
  // first-light leg carries the whole edge.
  useRecovery: false,
  rcMinAge: 4,
  rcMaxAge: 30,
  rcMinBuyers: 25,
  rcMinRunupBps: 2000,
  rcMinRecoveryBps: 300,
  rcWindowSlots: 10,
  rcMinFlowSol: 1,

  // Exits, tuned on the dev window: no early bank — the partial take-profit
  // only fires at +40% (gap-ups), otherwise the whole position exits at
  // +35%; cut at -3%; trail 8% once up 5%; leave after 25 quiet slots or
  // 250 slots held, whichever comes first. Letting winners run to +35% and
  // giving positions room to breathe beat every tighter exit tested.
  tp1Bps: 1000,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 3000,
  slBps: 300,
  trailArmBps: 500,
  trailBps: 800,
  maxHold: 90,
  exitOnDevSell: true,
  staleSlots: 10,
};

const BPS = 10_000n;
/** Curve fees on every trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1_000_000_000));

/** One trade on a coin's tape, kept only while it is inside a flow window. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  /** SOL bought minus sold on the tape so far (lamports). */
  netLamports: bigint;
  devSold: boolean;
  /** Price (virtual quote / virtual token) right after the creator's first sell. */
  devSellVq: bigint;
  devSellVt: bigint;
  lastTradeSlot: number;
  /** Recent trades, oldest first; pruned as windows slide past them. */
  tape: TapeTrade[];
  /** A buy was sent for this coin; never buy it again. */
  bought: boolean;
  /** Never consider it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far. */
  txPaid: bigint;
  /** Best close value seen (lamports, after curve and tx fees). */
  best: bigint;
  /** The creator had already sold when this position was opened. */
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Price as a ratio pair: returns vq * otherVt against vt * otherVq, in bps. */
function priceRatioBps(vq: bigint, vt: bigint, baseVq: bigint, baseVt: bigint): bigint {
  if (vt <= 0n || baseVq <= 0n || baseVt <= 0n) return 0n;
  return (vq * baseVt * BPS) / (vt * baseVq);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();

  const stake = solToLamports(p.stakeSol);
  const minBuy = solToLamports(p.minBuySol);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set(),
          netLamports: 0n,
          devSold: false,
          devSellVq: 0n,
          devSellVt: 1n,
          lastTradeSlot: e.slot,
          tape: [],
          bought: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.tape.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
        if (e.is_buy) {
          c.netLamports += sol;
          if (e.user !== c.creator) c.buyers.add(e.user);
        } else {
          c.netLamports -= sol;
          if (e.user === c.creator && !c.devSold) {
            c.devSold = true;
            c.devSellVq = BigInt(e.virtual_quote_reserves);
            c.devSellVt = BigInt(e.virtual_token_reserves);
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net SOL flow and distinct new buyers over the last `window` slots. */
  function recentFlow(c: Coin, slot: number, window: number): { net: bigint; newBuyers: number } {
    const from = slot - window;
    let drop = 0;
    while (drop < c.tape.length && c.tape[drop]!.slot <= from) drop++;
    if (drop > 0) c.tape.splice(0, drop);
    let net = 0n;
    const fresh = new Set<Pubkey>();
    for (const t of c.tape) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) fresh.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, newBuyers: fresh.size };
  }

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Reconcile fills: learn what landed, drop bookkeeping for what closed.
      // When retryFailedBuys is on, a buy that failed or was rejected is NOT
      // a buy: the coin stays eligible, so the next batch may try again while
      // its entry window is still open (the replay drops ~2% of transactions
      // at random). Measured across 3 failure-draw seeds, retrying is slightly
      // negative (-0.014 SOL mean), so the flag ships OFF.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
        if (p.retryFailedBuys && f.side === 'buy' && f.status !== 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined) c.bought = false;
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // ---- Exits first: every held position is judged against the same plan. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = {
            openedSlot: state.slot,
            txPaid: tx,
            best: 0n,
            devSoldAtOpen: c?.devSold ?? false,
            tookTp1: false,
          };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Bank part of the win early, then let the rest ride under the same plan.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
            const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(p.slAfterTp1Bps) : BigInt(p.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (
            h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) &&
            value * BPS <= h.best * (BPS - BigInt(p.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (p.staleSlots > 0 && state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- Entries: first light, second wind, creator-exit ride. ----
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.bought) continue;
        const age = state.slot - c.createSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < solToLamports(p.minRealSol) || rq > solToLamports(p.maxRealSol)) continue;

        let mode: 'first' | 'second' | 'recovery' | null = null;
        if (p.useFirstLight && age >= p.flMinAge && age <= p.flMaxAge) {
          if (p.flSkipDevSold && c.devSold) {
            // A dev-sold coin is dead to first light, but the recovery leg may
            // still want it later; only stop watching once that window is past.
            if (!p.useRecovery || age > p.rcMaxAge) {
              c.done = true;
              continue;
            }
          } else {
          const runup = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, c.vq0, c.vt0);
          if (
            c.buyers.size >= p.flMinBuyers &&
            c.netLamports >= solToLamports(p.flMinNetSol) &&
            runup >= BigInt(p.flMinRunupBps) &&
            runup <= BigInt(p.flMaxRunupBps)
          ) {
            mode = 'first';
          } else if (age >= p.flMaxAge) {
            // First-light window is closing with no trigger; the second-wind
            // leg below still gets its chance, so do not mark done here.
          }
          }
        }
        if (mode === null && p.useSecondWind && age >= p.swMinAge && age <= p.swMaxAge && !c.devSold) {
          const runup = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, c.vq0, c.vt0);
          const fl = recentFlow(c, state.slot, p.swWindowSlots);
          if (
            c.buyers.size >= p.swMinBuyers &&
            runup >= BigInt(p.swMinRunupBps) &&
            fl.net >= solToLamports(p.swMinFlowSol) &&
            fl.newBuyers >= p.swMinNewBuyers
          ) {
            mode = 'second';
          }
        }
        if (mode === null && p.useRecovery && c.devSold && age >= p.rcMinAge && age <= p.rcMaxAge) {
          const runup = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, c.vq0, c.vt0);
          const recovered = priceRatioBps(
            curve.virtual_quote_reserves,
            curve.virtual_token_reserves,
            c.devSellVq,
            c.devSellVt,
          );
          const fl = recentFlow(c, state.slot, p.rcWindowSlots);
          if (
            c.buyers.size >= p.rcMinBuyers &&
            runup >= BigInt(p.rcMinRunupBps) &&
            recovered >= BPS + BigInt(p.rcMinRecoveryBps) &&
            fl.net >= solToLamports(p.rcMinFlowSol)
          ) {
            mode = 'recovery';
          }
        }
        if (mode === null) {
          // Nothing triggered and the last entry window has passed: stop watching.
          const lastAge = Math.max(
            p.useFirstLight ? p.flMaxAge : 0,
            p.useSecondWind ? p.swMaxAge : 0,
            p.useRecovery ? p.rcMaxAge : 0,
          );
          if (age > lastAge) c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.bought = true;
        open += 1;
      }
      return orders;
    },
  };
}
