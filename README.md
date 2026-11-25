# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/redsparksz/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/redsparksz/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A first-light crowd sniper for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades 10 SOL of paper money on a replay of pump.fun chain data (harness `pumpfun-replay/v2`), scored by net PnL.

## Idea

A new pump.fun coin's whole life is decided in its first seconds: on the dev window (1,222 coins) 286 coins more than doubled from their create price, the median time to that peak was 52 slots (~21 s), and the median coin ends the window flat. So this bot only buys a coin in its first few slots, only when the opening tape already shows a real crowd — several distinct buyers, net SOL flowing in, price already up from create, a real reserve big enough to take a meaningful order — and then gives the position room to run instead of banking the first pop.

Two other legs were built, measured, and rejected on the dev window (they stay in the code, switched off): a second-wind entry at age 5–12 (buys the top: +0.888 with it on vs +0.949 without) and a creator-exit recovery entry (loses money on its own, −0.224 SOL standalone). The first-light leg carries the whole edge.

## Entry (one shot per coin, age 0–4 slots)

- ≥ 11 distinct non-creator buyers, net flow ≥ 2 SOL, run-up ≥ 3% vs create
- real SOL reserve 3–60 SOL, creator has not sold
- stake 0.50 SOL per coin (capped at 1% of real reserve per reply)
- age 4, not 3: some launches are one slot slow to show their crowd; the extra slot adds 12 coins and +0.07 SOL on the dev window

## Exits

- Take half at +10%; sell everything at +30%
- Stop-loss −3%
- Trailing stop: once up ≥ 5%, exit on an 8% pullback from the best value
- Exit at once if the creator sells while held; exit after 10 slots with no trade; max hold 90 slots
- This is the tight-exits variant of the same first-light entry (see the `main` branch for the loose-exits variant at dev +0.718 SOL). The tight exits give up dev PnL but survive surrogate windows far better: stress median +0.03 SOL with 4/10 copies losing, vs the loose variant's median −0.14 with 7/10 losing.

All arithmetic is integer (`bigint`) on the harness's own reserve units, so two runs on the same data produce identical orders. No network, no wall clock, no randomness, no files.

## Results

Dev window (local grade, kit `grade-local --driver process`, reproduced byte for byte twice): **net PnL +0.5316 SOL (+5.32%, 90% interval +0.200 .. +0.964 SOL), 112 fills over 49 coins, 49 round trips, win rate 40.8%, max drawdown 0.66%, fees 0.2372 SOL curve + 0.0120 SOL tx** (at 2x fees still +0.2788 SOL). Top-3 coins made 28% of the gains; without them net PnL is +0.30 SOL. Guardrails met (49 coins with a round trip ≥ 0.01 SOL, drawdown ≤ 50%).

The local research simulator (an independent re-implementation of the replay model) scores the same settings at +0.949 SOL; the 0.23 SOL gap is the seeded 2% transaction-failure lottery — five coins' buys filled in one system and failed in the other — not a modelling difference (58 of 63 coins agree to < 0.001 SOL). The final window re-rolls that lottery with its own seed.

Stress test (`grade-local --stress 10`, rebuilt copies of the dev window): **median +0.03 SOL, p10 −0.48, p90 +0.30 SOL; 4 of 10 copies lost money; the dev score sits above all 10 copies** (kit warning: dev score above 90% of copies). Expect roughly 0 to +0.1 SOL on a fresh window — a far better centre than the loose variant's median −0.14, at the cost of 0.19 SOL of dev PnL.

For comparison on the same dev window: our two sibling first-light bots scored +0.5089 and +0.6033 SOL (grade-local); the current dev board leader sits at +1.07 SOL. House baselines all lose money (momentum −9.49, sniper −0.47, reversion −4.00 SOL).

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot <your repository> --driver docker
```

## Files

- `main.ts` — entrypoint (`node main.ts`)
- `strategy.ts` — the strategy (all logic, deterministic, no clock/random/network)
- `vendor/makefun-bot.ts` — the kit's replay/v2 shim, vendored byte for byte
