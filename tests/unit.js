/**
 * Unit tests for Website Time Tracker logic.
 * Run with: node tests/unit.js
 * Tests: date key, hostname extraction, time rounding, timeline aggregation.
 */

function getDateKey(date) {
  const d = date ? new Date(date) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function hostnameFromUrl(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
    return null;
  }
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function roundMs(ms, granularityMs) {
  if (!granularityMs || granularityMs <= 0) return ms;
  return Math.floor(ms / granularityMs) * granularityMs;
}

function aggregateTimeline(timeline) {
  const byDomain = {};
  for (const block of timeline) {
    const d = block.domain;
    const dur = (block.end || 0) - (block.start || 0);
    if (!byDomain[d]) byDomain[d] = { ms: 0, blocks: [] };
    byDomain[d].ms += dur;
    byDomain[d].blocks.push(block);
  }
  return Object.entries(byDomain)
    .map(([domain, data]) => ({ domain, ...data }))
    .sort((a, b) => b.ms - a.ms);
}

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name);
  }
}

function eq(a, b, name) {
  const ok = a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
  }
}

console.log('Time accumulation / date key');
const d = new Date('2025-02-13T15:30:00');
eq(getDateKey(d), '2025-02-13', 'getDateKey returns YYYY-MM-DD');

console.log('\nHostname extraction');
eq(hostnameFromUrl('https://www.youtube.com/watch?v=1'), 'youtube.com', 'strip www and return hostname');
eq(hostnameFromUrl('https://github.com/foo'), 'github.com', 'hostname without www');
eq(hostnameFromUrl('chrome://extensions'), null, 'chrome:// returns null');
eq(hostnameFromUrl(''), null, 'empty url returns null');

console.log('\nTime granularity');
eq(roundMs(5500, 1000), 5000, 'roundMs floors to granularity');
eq(roundMs(0, 1000), 0, 'roundMs zero');
eq(roundMs(999, 1000), 0, 'roundMs below granularity');

console.log('\nTimeline aggregation');
const timeline = [
  { start: 1000, end: 5000, domain: 'a.com' },
  { start: 5000, end: 7000, domain: 'a.com' },
  { start: 7000, end: 10000, domain: 'b.com' }
];
const agg = aggregateTimeline(timeline);
eq(agg.length, 2, 'two domains');
eq(agg[0].domain, 'a.com', 'first domain is a.com (more time)');
eq(agg[0].ms, 6000, 'a.com total 6s');
eq(agg[1].domain, 'b.com', 'second domain is b.com');
eq(agg[1].ms, 3000, 'b.com total 3s');

console.log('\n---');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
