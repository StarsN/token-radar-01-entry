# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/StarsN/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/StarsN/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It reads a sealed DefiLlama snapshot of every protocol at $5M TVL or more, filters out everything that already records a token — and every wrapped, staked, bridged or exchange product of one that does — then ranks the survivors by implied launch value: each protocol's TVL priced at the median market-cap-to-TVL its launched category peers actually fetch, shaded for seven-day momentum and for how long it has run with no token. Every row of the board carries its three valuation factors and a five-step farm plan with costs and timings, and the static dashboard (no network needed) presents the board, a detail view per protocol, and the full calibration behind the model.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Node 22, standard library only. The run writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory; open `dashboard/index.html` from the output to read the board.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vvry49c9&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
