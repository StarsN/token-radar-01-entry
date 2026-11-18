// Token Launch Radar — the program.
//
// Reads the sealed DefiLlama snapshot (every protocol at $5M TVL or more),
// works out which of them still record no token and are not a wrapped, staked
// or bridged product of one that trades, values each the way its launched
// peers are valued, and writes the whole thing out as a board a person can
// farm from:
//
//   /output/board.json    the ranked board (the gate reads this)
//   /output/data.js       the same board, as the dashboard's data
//   /output/dashboard/    the static page (renders with no network)
//   /output/screenshots/  the three captures of it
//   /output/dossier.json  the judge's summary, built by vendor/makefun-board.ts
//
// Node 22, standard library only. Run it locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < args.length) return args[at + 1]!;
  const glued = args.find((a) => a.startsWith(`--${name}=`));
  return glued === undefined ? fallback : glued.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(1);
}

// --- Locate the snapshot ----------------------------------------------------

const inputArg = readArg('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot at ${snapshotPath} — pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outputDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const radar = buildRadar(snapshot);

// Refuse to write a board the gate would refuse: better a loud local failure
// than a silent invalid entry.
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

// --- Write the board and the dashboard's data -------------------------------

mkdirSync(outputDir, { recursive: true });
const boardFile = {
  rows: radar.rows,
  meta: {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model:
      'implied value = TVL x category multiple (median market-cap/TVL of launched peers, shrunk to the market median and winsorised to 0.02–3.0) x momentum factor x maturity factor',
    stats: radar.stats,
  },
};
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify(boardFile)}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(snapshot, radar));

// --- Copy the page and its captures -----------------------------------------

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Copy a directory tree of regular files, skipping dot-names at every level. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) {
      copied.push(...copyTree(source, target).map((n) => `${name}/${n}`));
    } else if (statSync(source).isFile()) {
      copyFileSync(source, target);
      copied.push(name);
    }
  }
  return copied;
}

const pageFiles = copyTree(join(repoRoot, 'dashboard'), join(outputDir, 'dashboard'));
if (!pageFiles.includes('index.html')) fail('dashboard/ holds no index.html to hand in');

const shots = copyTree(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  fail(`screenshots/ holds ${shots.length} images — hand in 3: the board, a protocol's detail view and a filtered view`);
}
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters`);
}

// --- The dossier, written last ----------------------------------------------
// Byte for byte what the scorer rebuilds from this same output directory.

const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);

const s = radar.stats;
process.stdout.write(
  `token-radar: scanned ${s.scanned} protocols — ${s.launched_set_aside} already record a token, ` +
    `${Object.values(s.excluded).reduce((a, b) => a + b, 0)} are products of one — leaving ${s.board_rows} launch candidates\n` +
    `token-radar: watchlist ${s.watchlist_covered}/${s.watchlist_size} covered; total implied value $${s.total_implied_usd.toLocaleString('en-US')}\n` +
    `token-radar: wrote board.json (${s.board_rows} rows), data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length}) and dossier.json (${dossier.length} bytes)\n`,
);
