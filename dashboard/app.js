// Token Launch Radar — the page's working parts.
//
// Reads window.RADAR (written by main.ts beside this directory as data.js) and
// renders three views from it: the board, one protocol's detail, and the
// method. All state lives in the location hash, so every view — a filtered
// board included — is a link that can be shared, screenshotted and returned
// to. No network: every byte shown arrived in data.js.

(function () {
  'use strict';
  var DATA = window.RADAR;
  var rows = DATA.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  // ---------- formatting ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }
  function pct(x) {
    if (x == null) return '<span class="neg" style="color:#87a0b4">—</span>';
    var cls = x >= 0 ? 'pos' : 'neg';
    return '<span class="' + cls + '">' + (x >= 0 ? '+' : '') + x.toFixed(1) + '%</span>';
  }
  function factor(x) { return '×' + x.toFixed(2); }
  function ageText(days) {
    if (days == null) return 'not recorded';
    if (days < 60) return days + ' days';
    if (days < 730) return Math.round(days / 30.4) + ' months';
    return (days / 365.25).toFixed(1) + ' years';
  }

  // ---------- masthead ----------
  var s = DATA.stats;
  document.getElementById('mastStats').innerHTML =
    stat('Snapshot', DATA.as_of) +
    stat('Protocols scanned', s.scanned) +
    stat('Launch candidates', s.board_rows) +
    stat('Watchlist covered', s.watchlist_covered + ' / ' + s.watchlist_size) +
    stat('Total implied value', money(s.total_implied_usd), true);
  function stat(label, value, teal) {
    return '<div class="stat"><span>' + esc(label) + '</span><b' + (teal ? ' class="teal"' : '') + '>' + esc(value) + '</b></div>';
  }

  // ---------- board state ----------
  var state = { q: '', cat: '', chain: '', min: 0, wl: false, sort: 'rank', dir: 1 };

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    var detail = document.getElementById('viewDetail');
    var board = document.getElementById('viewBoard');
    var method = document.getElementById('viewMethod');
    board.hidden = true; detail.hidden = true; method.hidden = true;
    setNav('');
    if (hash.indexOf('/p/') === 0) {
      renderDetail(decodeURIComponent(hash.slice(3)));
      detail.hidden = false;
    } else if (hash === '/method') {
      method.hidden = false;
      setNav('method');
    } else {
      var query = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : '';
      var params = new URLSearchParams(query);
      state.q = params.get('q') || '';
      state.cat = params.get('cat') || '';
      state.chain = params.get('chain') || '';
      state.min = Number(params.get('min') || 0);
      state.wl = params.get('wl') === '1';
      state.sort = params.get('sort') || 'rank';
      state.dir = params.get('dir') === '-1' ? -1 : 1;
      syncControls();
      renderBoard();
      board.hidden = false;
      setNav('board');
    }
    window.scrollTo(0, 0);
  }
  function setNav(which) {
    var links = document.querySelectorAll('.tabs a');
    links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-nav') === which); });
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.cat) params.set('cat', state.cat);
    if (state.chain) params.set('chain', state.chain);
    if (state.min) params.set('min', String(state.min));
    if (state.wl) params.set('wl', '1');
    if (state.sort !== 'rank') params.set('sort', state.sort);
    if (state.dir !== 1) params.set('dir', '-1');
    var query = params.toString();
    var next = '#/' + (query ? '?' + query : '');
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  }

  // ---------- board ----------
  var els = {
    q: document.getElementById('fSearch'),
    cat: document.getElementById('fCategory'),
    chain: document.getElementById('fChain'),
    min: document.getElementById('fMinValue'),
    wl: document.getElementById('fWatch'),
    body: document.getElementById('boardBody'),
    count: document.getElementById('rowCount'),
    foot: document.getElementById('boardFoot'),
  };

  function fillSelect(el, values, allLabel) {
    el.innerHTML = '<option value="">' + allLabel + '</option>' + values.map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
    }).join('');
  }
  var categories = [];
  var chains = [];
  rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) === -1) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); });
  });
  categories.sort(); chains.sort();
  fillSelect(els.cat, categories, 'All categories');
  fillSelect(els.chain, chains, 'All chains');

  function syncControls() {
    els.q.value = state.q;
    els.cat.value = state.cat;
    els.chain.value = state.chain;
    els.min.value = String(state.min);
    els.wl.checked = state.wl;
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.wl && !r.watchlist) return false;
      if (r.implied_value_usd < state.min) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va == null && vb == null) return a.rank - b.rank;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return state.dir * va.localeCompare(vb) || a.rank - b.rank;
      return state.dir * (va - vb) || a.rank - b.rank;
    });
    return out;
  }

  function renderBoard() {
    var out = visibleRows();
    els.body.innerHTML = out.map(function (r) {
      var first = r.farm_steps[0];
      var hint = first;
      if (first.length > 118) {
        hint = first.slice(0, 118);
        var cut = hint.lastIndexOf(' ');
        if (cut > 60) hint = hint.slice(0, cut);
        hint += '…';
      }
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank num">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + (r.watchlist ? '<span class="wl-badge">Watchlist</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + factor(r.multiple) + '</td>' +
        '<td class="num val">' + money(r.implied_value_usd) + '</td>' +
        '<td class="farm-hint">' + esc(hint) + '</td></tr>';
    }).join('');
    els.count.textContent = 'Showing ' + out.length + ' of ' + rows.length + ' candidates';
    els.foot.textContent =
      'Implied value = TVL × category multiple × momentum × maturity — the method page shows the calibration. ' +
      'Click any row for the protocol\'s full valuation and farm plan.';
    var heads = document.querySelectorAll('#boardTable th[data-sort]');
    heads.forEach(function (th) {
      var key = th.getAttribute('data-sort');
      var label = th.getAttribute('data-label') || th.textContent.replace(/ [▲▼]$/, '');
      th.setAttribute('data-label', label);
      th.innerHTML = esc(label) + (key === state.sort ? ' <span class="dir">' + (state.dir === 1 ? '▲' : '▼') + '</span>' : '');
    });
  }

  els.q.addEventListener('input', function () { state.q = els.q.value; writeHash(); renderBoard(); });
  els.cat.addEventListener('change', function () { state.cat = els.cat.value; writeHash(); renderBoard(); });
  els.chain.addEventListener('change', function () { state.chain = els.chain.value; writeHash(); renderBoard(); });
  els.min.addEventListener('change', function () { state.min = Number(els.min.value); writeHash(); renderBoard(); });
  els.wl.addEventListener('change', function () { state.wl = els.wl.checked; writeHash(); renderBoard(); });
  document.querySelectorAll('#boardTable th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
      writeHash(); renderBoard();
    });
  });
  els.body.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) window.location.hash = '#/p/' + encodeURIComponent(tr.getAttribute('data-slug'));
  });

  // ---------- detail ----------
  function renderDetail(slug) {
    var r = bySlug[slug];
    var el = document.getElementById('viewDetail');
    if (!r) {
      el.innerHTML = '<a class="back-link" href="#/">← Back to the board</a><p>No protocol with that name is on the board.</p>';
      return;
    }
    var steps = r.farm_steps.map(function (step) { return '<li>' + esc(step) + '</li>'; }).join('');
    el.innerHTML =
      '<a class="back-link" href="#/">← Back to the board</a>' +
      '<div class="detail-head"><span class="rank-chip">#' + r.rank + '</span><h2>' + esc(r.name) + '</h2>' +
      (r.watchlist ? '<span class="wl-badge">On the $50M watchlist</span>' : '') + '</div>' +
      '<p class="detail-sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) +
      ' · tracked by DefiLlama since ' + esc(r.listed_at || 'an unrecorded date') + ' (' + ageText(r.age_days) + ')' +
      ' · records no token in the snapshot</p>' +
      '<div class="detail-grid">' +
      statBlock('Implied launch value', money(r.implied_value_usd)) +
      statBlock('TVL', money(r.tvl_usd)) +
      statBlock('TVL change, 7d', r.change_7d == null ? 'not reported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') +
      statBlock('Category multiple', factor(r.multiple)) +
      statBlock('Chains', String(r.chains.length)) +
      '</div>' +
      '<article class="panel"><h3>How this value is built</h3><div class="factors">' +
      factorBox('TVL', money(r.tvl_usd)) + op('×') +
      factorBox('Multiple', factor(r.multiple)) + op('=') +
      factorBox('Base value', money(r.base_value_usd)) + op('×') +
      factorBox('Momentum', factor(r.momentum_factor)) + op('×') +
      factorBox('Maturity', factor(r.maturity_factor)) + op('=') +
      '<div class="factor result"><span>Implied value</span><b>' + money(r.implied_value_usd) + '</b></div>' +
      '</div><p class="caveat">The multiple is the median market-cap-to-TVL of launched ' + esc(r.category || '') +
      ' protocols, shrunk toward the market median and winsorised; momentum shades it for the seven-day TVL move; ' +
      'maturity for the years run with no token. Recompute it from the snapshot\'s own figures — nothing here is a guess at a date or a promise of an airdrop.</p></article>' +
      '<article class="panel"><h3>Farm plan — ' + r.farm_steps.length + ' steps</h3><ol class="steps">' + steps + '</ol></article>';
  }
  function statBlock(label, value) {
    return '<div class="stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function factorBox(label, value) {
    return '<div class="factor"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function op(symbol) { return '<div class="factor op">' + symbol + '</div>'; }

  // ---------- method ----------
  var ex = s.excluded;
  document.getElementById('filterRules').innerHTML =
    rule('Already launched', s.launched_set_aside, 'protocols record a token (a gecko id, a symbol or a market cap). They are set aside as the calibration set, never ranked.') +
    rule('Product categories', ex.category || 0, 'bridges, canonical bridges, centralised exchanges, liquid staking and restaking, and wrapped-BTC lines: their TVL is a balance of someone else\'s asset.') +
    rule('Product names', ex.name || 0, 'names carrying a whole word wrapped, staked or staking, or ending in a version marker (V2, v2, 2.0) — a later version of a protocol that already launched.') +
    rule('Exchange names', ex.exchange || 0, 'names beginning with an exchange\'s name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, Gemini) are that exchange\'s own product.') +
    rule('Brand products', ex.brand || 0, 'a product line carrying the brand of a protocol whose token already trades is that protocol\'s product, not a separate launch.') +
    rule('Kept', s.board_rows, 'protocols survive as launch candidates and are ranked on the board.');
  function rule(name, count, text) {
    return '<li><strong>' + esc(name) + ' — ' + count + '.</strong> ' + esc(text) + '</li>';
  }
  document.getElementById('compBody').innerHTML = DATA.comps.map(function (c) {
    return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.launched + '</td><td class="num">' +
      factor(c.median_multiple) + '</td><td class="num">' + factor(c.multiple_used) + '</td></tr>';
  }).join('');
  document.getElementById('launchedBody').innerHTML = DATA.launched.map(function (p) {
    return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.category || '—') + '</td><td class="num">' + money(p.tvl_usd) +
      '</td><td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + factor(p.multiple) + '</td></tr>';
  }).join('');

  window.addEventListener('hashchange', readHash);
  readHash();
})();
