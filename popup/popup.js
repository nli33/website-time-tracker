/**
 * Website Time Tracker - Popup UI
 * Timeline view, Pie chart view, Delete, Settings.
 */

const PIE_COLORS = [
  '#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e',
  '#2ac3de', '#ff9e64', '#73daca', '#c0caf5', '#565f89'
];
const OTHER_COLOR = '#3b4261';
const PIE_OTHER_THRESHOLD = 0.02;

let currentDateKey = getDateKey();
let cachedDays = {};
let cachedDomainTags = {};
let cachedTagList = [];
let liveUpdateInterval = null;
let pieViewMode = 'sites';

function getDateKey(date) {
  const d = date ? new Date(date) : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function formatMs(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return s ? m + 'm ' + s + 's' : m + 'm';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getDayData(days, dateKey) {
  const day = days?.[dateKey];
  if (!day || !day.domains) return { domains: {}, timeline: [] };
  return { domains: day.domains, timeline: day.timeline || [] };
}

function getTimelineSortedChronologically(timeline) {
  return [...(timeline || [])]
    .filter(b => b && (b.start != null || b.end != null))
    .sort((a, b) => (a.start || 0) - (b.start || 0));
}

/** Newest first (most recent on top). */
function getTimelineNewestFirst(timeline) {
  return [...(timeline || [])]
    .filter(b => b && (b.start != null || b.end != null))
    .sort((a, b) => (b.start || 0) - (a.start || 0));
}

function getDayBounds(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return { dayStart: start, dayEnd: end };
}

function domainToColorMap(sortedBlocks) {
  const order = [];
  const seen = new Set();
  for (const b of sortedBlocks) {
    if (b.domain && !seen.has(b.domain)) {
      seen.add(b.domain);
      order.push(b.domain);
    }
  }
  const map = {};
  order.forEach((domain, i) => {
    map[domain] = PIE_COLORS[i % PIE_COLORS.length];
  });
  return map;
}

function renderTimeline(dayData, currentSession, domainTags, tagList) {
  const placeholder = document.getElementById('timelinePlaceholder');
  const container = document.getElementById('timelineBlocks');
  container.innerHTML = '';
  const tags = domainTags || {};
  const tagsList = tagList || [];
  let blocks = getTimelineNewestFirst(dayData.timeline);
  const isViewingToday = currentDateKey === getDateKey();
  if (currentSession && isViewingToday) {
    const liveBlock = {
      domain: currentSession.domain,
      start: currentSession.start,
      end: Date.now(),
      _live: true
    };
    blocks = [liveBlock, ...blocks];
  }
  if (blocks.length === 0) {
    placeholder.classList.remove('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  const colorByDomain = domainToColorMap(blocks);
  for (const block of blocks) {
    const start = block.start || 0;
    const end = block.end || start;
    const ms = end - start;
    const el = document.createElement('div');
    el.className = 'timeline-block' + (block._live ? ' timeline-block-live' : '');
    const color = colorByDomain[block.domain] || OTHER_COLOR;
    el.style.borderLeftColor = color;
    const endLabel = block._live ? 'now' : formatTime(end);
    const blockTags = tags[block.domain] || [];
    const tagsHtml = blockTags.length
      ? blockTags.map(t => `<span class="timeline-tag-pill">${escapeHtml(t)}</span>`).join('')
      : '';
    const editWrap = document.createElement('div');
    editWrap.className = 'timeline-edit-tags-wrap';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'timeline-edit-tags-btn';
    editBtn.textContent = blockTags.length ? 'Edit tags' : '+ Tags';
    editBtn.setAttribute('aria-label', 'Edit tags for ' + block.domain);
    const dropdown = document.createElement('div');
    dropdown.className = 'timeline-tag-dropdown';
    dropdown.hidden = true;
    tagsList.forEach(tag => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.tag = tag;
      cb.checked = blockTags.includes(tag);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(tag));
      dropdown.appendChild(label);
    });
    let closeListener = null;
    const saveTags = async () => {
      if (closeListener) {
        document.removeEventListener('click', closeListener, true);
        closeListener = null;
      }
      const selected = [...dropdown.querySelectorAll('input:checked')].map(c => c.dataset.tag);
      const next = { ...tags, [block.domain]: selected };
      await chrome.storage.local.set({ domainTags: next });
      cachedDomainTags = next;
      dropdown.hidden = true;
      editBtn.textContent = selected.length ? 'Edit tags' : '+ Tags';
      const pills = el.querySelector('.timeline-block-tags');
      pills.innerHTML = selected.map(t => `<span class="timeline-tag-pill">${escapeHtml(t)}</span>`).join('');
    };
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!dropdown.hidden) {
        saveTags();
        return;
      }
      dropdown.querySelectorAll('input').forEach(cb => {
        cb.checked = (tags[block.domain] || []).includes(cb.dataset.tag);
      });
      const rect = editBtn.getBoundingClientRect();
      dropdown.style.top = (rect.bottom + 4) + 'px';
      dropdown.style.left = rect.left + 'px';
      dropdown.hidden = false;
      closeListener = (e) => {
        const t = e.target;
        if (dropdown.hidden) return;
        if (editWrap.contains(t) || dropdown.contains(t)) return;
        saveTags();
      };
      setTimeout(() => document.addEventListener('click', closeListener, true), 0);
    });
    editWrap.appendChild(editBtn);
    editWrap.appendChild(dropdown);
    const row1 = document.createElement('div');
    row1.className = 'timeline-block-row1';
    const main = document.createElement('div');
    main.className = 'timeline-block-main';
    main.innerHTML = `
      <span class="timeline-domain" title="${escapeHtml(block.domain)}">${escapeHtml(block.domain)}${block._live ? ' <span class="timeline-live-badge">live</span>' : ''}</span>
      <span class="timeline-block-tags">${tagsHtml}</span>
    `;
    row1.appendChild(main);
    const actions = document.createElement('div');
    actions.className = 'timeline-block-actions';
    actions.appendChild(editWrap);
    row1.appendChild(actions);
    el.appendChild(row1);
    const row2 = document.createElement('div');
    row2.className = 'timeline-block-row2';
    row2.innerHTML = `
      <span class="timeline-duration">${formatMs(ms)}</span>
      <span class="timeline-block-time-range">${formatTime(start)} – ${endLabel}</span>
    `;
    el.appendChild(row2);
    container.appendChild(el);
  }
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

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function computeTagMsFromDay(dayData, domainTags) {
  const domains = dayData.domains || {};
  const tagMs = {};
  for (const [domain, data] of Object.entries(domains)) {
    const ms = data.ms || 0;
    if (ms <= 0) continue;
    const tags = domainTags[domain];
    if (tags && tags.length) {
      tags.forEach(t => { tagMs[t] = (tagMs[t] || 0) + ms; });
    } else {
      tagMs['Untagged'] = (tagMs['Untagged'] || 0) + ms;
    }
  }
  return tagMs;
}

function drawPieChart(canvasId, dayData, viewMode, domainTags) {
  const canvas = document.getElementById(canvasId);
  const placeholder = document.getElementById('piePlaceholder');
  const legendEl = document.getElementById('pieLegend');
  legendEl.innerHTML = '';
  const domains = dayData.domains || {};
  const total = Object.values(domains).reduce((s, o) => s + (o.ms || 0), 0);
  if (total === 0) {
    placeholder.classList.remove('hidden');
    canvas.style.display = 'none';
    return;
  }
  placeholder.classList.add('hidden');
  canvas.style.display = 'block';

  let entries;
  let labelKey;
  if (viewMode === 'tags') {
    const tagMs = computeTagMsFromDay(dayData, domainTags || {});
    entries = Object.entries(tagMs)
      .map(([tag, ms]) => ({ tag, ms }))
      .filter(e => e.ms > 0)
      .sort((a, b) => b.ms - a.ms);
    labelKey = 'tag';
  } else {
    entries = Object.entries(domains)
      .map(([domain, data]) => ({ domain, ms: data.ms || 0 }))
      .filter(e => e.ms > 0)
      .sort((a, b) => b.ms - a.ms);
    labelKey = 'domain';
  }

  const otherThreshold = total * PIE_OTHER_THRESHOLD;
  const main = [];
  let otherMs = 0;
  const otherLabels = [];
  for (const e of entries) {
    const label = e[labelKey];
    if (e.ms >= otherThreshold) {
      main.push({ ...e, label });
    } else {
      otherMs += e.ms;
      otherLabels.push(label);
    }
  }
  if (otherMs > 0) {
    main.push({ ms: otherMs, _other: otherLabels, label: 'Other' });
  }

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 280;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.scale(dpr, dpr);

  const cx = size / 2;
  const cy = size / 2;
  const r = Math.min(cx, cy) - 8;
  let startAngle = -Math.PI / 2;

  for (let i = 0; i < main.length; i++) {
    const slice = main[i];
    const angle = (slice.ms / total) * 2 * Math.PI;
    const color = slice._other ? OTHER_COLOR : PIE_COLORS[i % PIE_COLORS.length];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fill();
    startAngle += angle;

    const label = slice._other ? 'Other' : slice.label;
    const pct = ((slice.ms / total) * 100).toFixed(1);
    const duration = formatMs(slice.ms);
    const item = document.createElement('div');
    item.className = 'pie-legend-item';
    item.innerHTML = `<span class="pie-legend-swatch" style="background:${color}"></span><span>${escapeHtml(label)} ${pct}% · ${duration}</span>`;
    legendEl.appendChild(item);
  }
}

function renderPie(dayData, viewMode, domainTags) {
  drawPieChart('pieCanvas', dayData, viewMode || 'sites', domainTags);
}

async function loadAndRender() {
  const { days = {}, currentSession = null, domainTags = {}, tagList = [] } = await chrome.storage.local.get(['days', 'currentSession', 'domainTags', 'tagList']);
  cachedDays = days || {};
  cachedDomainTags = domainTags || {};
  cachedTagList = Array.isArray(tagList) ? tagList : [];
  const dayData = getDayData(cachedDays, currentDateKey);
  renderTimeline(dayData, currentSession, cachedDomainTags, cachedTagList);
  renderPie(dayData, pieViewMode, cachedDomainTags);

  if (liveUpdateInterval) clearInterval(liveUpdateInterval);
  liveUpdateInterval = null;
  if (currentSession && document.getElementById('timelinePanel').classList.contains('active')) {
    liveUpdateInterval = setInterval(async () => {
      if (document.querySelector('.timeline-tag-dropdown:not([hidden])')) return;
      const { currentSession: session, domainTags: dt = {}, tagList: tl = [] } = await chrome.storage.local.get(['currentSession', 'domainTags', 'tagList']);
      if (!session) {
        clearInterval(liveUpdateInterval);
        liveUpdateInterval = null;
        return;
      }
      cachedDomainTags = dt;
      cachedTagList = Array.isArray(tl) ? tl : [];
      const dayData_ = getDayData(cachedDays, currentDateKey);
      renderTimeline(dayData_, session, cachedDomainTags, cachedTagList);
    }, 1000);
  }
}

function switchTab(tabName) {
  if (tabName === 'pie' && liveUpdateInterval) {
    clearInterval(liveUpdateInterval);
    liveUpdateInterval = null;
  }
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
    t.setAttribute('aria-selected', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach(p => {
    const isTimeline = p.id === 'timelinePanel';
    const isPie = p.id === 'piePanel';
    const show = (tabName === 'timeline' && isTimeline) || (tabName === 'pie' && isPie);
    p.classList.toggle('active', show);
    p.hidden = !show;
  });
  if (tabName === 'pie') loadAndRender();
  if (tabName === 'timeline') loadAndRender();
}

document.getElementById('pieToggleSites').addEventListener('click', () => {
  pieViewMode = 'sites';
  document.getElementById('pieToggleSites').classList.add('active');
  document.getElementById('pieToggleTags').classList.remove('active');
  const dayData = getDayData(cachedDays, currentDateKey);
  renderPie(dayData, pieViewMode, cachedDomainTags);
});
document.getElementById('pieToggleTags').addEventListener('click', () => {
  pieViewMode = 'tags';
  document.getElementById('pieToggleTags').classList.add('active');
  document.getElementById('pieToggleSites').classList.remove('active');
  const dayData = getDayData(cachedDays, currentDateKey);
  renderPie(dayData, pieViewMode, cachedDomainTags);
});

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('datePicker').addEventListener('change', (e) => {
  // Use picker value as-is: HTML date input returns YYYY-MM-DD (user's calendar date).
  // getDateKey(string) would parse it as UTC midnight and shift to wrong day in non-UTC timezones.
  currentDateKey = e.target.value || getDateKey();
  loadAndRender();
});

document.getElementById('btnDeleteDay').addEventListener('click', async () => {
  if (!confirm(`Delete all data for ${currentDateKey}? This cannot be undone.`)) return;
  const { days = {}, currentSession = null } = await chrome.storage.local.get(['days', 'currentSession']);
  const nextDays = { ...days };
  delete nextDays[currentDateKey];
  const isToday = currentDateKey === getDateKey();
  await chrome.storage.local.set({
    days: nextDays,
    ...(isToday ? { currentSession: null } : {})
  });
  cachedDays = nextDays;
  loadAndRender();
});

document.getElementById('btnDeleteAll').addEventListener('click', async () => {
  if (!confirm('Delete all usage data? Settings and tags will be kept. This cannot be undone.')) return;
  const { settings = {}, domainTags = {}, tagList = [] } = await chrome.storage.local.get(['settings', 'domainTags', 'tagList']);
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    days: {},
    currentSession: null,
    settings: settings.theme !== undefined ? settings : { excludeDomains: [], timeGranularityMs: 1000, theme: 'dark' },
    domainTags: domainTags && Object.keys(domainTags).length ? domainTags : {},
    tagList: Array.isArray(tagList) ? tagList : []
  });
  currentDateKey = getDateKey();
  cachedDays = {};
  cachedDomainTags = domainTags || {};
  cachedTagList = Array.isArray(tagList) ? tagList : [];
  document.getElementById('datePicker').value = '';
  loadAndRender();
  settingsDialog.close();
});

const settingsDialog = document.getElementById('settingsDialog');

function renderSettingsTagList(tagList) {
  const ul = document.getElementById('tagList');
  ul.innerHTML = '';
  (tagList || []).forEach(tag => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tag-name">${escapeHtml(tag)}</span><button type="button" class="btn-tag-delete" data-tag="${escapeHtml(tag)}">Delete</button>`;
    ul.appendChild(li);
  });
}

function applyTheme(theme) {
  const v = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = v;
}

document.getElementById('btnSettings').addEventListener('click', async () => {
  const { settings = {}, tagList = [] } = await chrome.storage.local.get(['settings', 'tagList']);
  document.getElementById('excludeDomains').value = (settings.excludeDomains || []).join('\n');
  document.getElementById('timeGranularity').value = settings.timeGranularityMs ?? 1000;
  document.getElementById('themeSelect').value = (settings.theme === 'light' ? 'light' : 'dark');
  document.getElementById('keepIncognitoData').checked = settings.keepIncognitoData === true;
  document.getElementById('newTagName').value = '';
  renderSettingsTagList(Array.isArray(tagList) ? tagList : []);
  settingsDialog.showModal();
});
async function addTagFromInput() {
  const input = document.getElementById('newTagName');
  const name = input.value.trim();
  if (!name) return;
  const { tagList = [] } = await chrome.storage.local.get('tagList');
  const list = Array.isArray(tagList) ? tagList : [];
  if (list.includes(name)) return;
  list.push(name);
  list.sort();
  await chrome.storage.local.set({ tagList: list });
  cachedTagList = list;
  input.value = '';
  renderSettingsTagList(list);
}
document.getElementById('btnAddTag').addEventListener('click', () => addTagFromInput());
document.getElementById('newTagName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTagFromInput();
  }
});
document.getElementById('tagList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-tag-delete');
  if (!btn) return;
  const tag = btn.dataset.tag;
  if (!tag) return;
  if (!confirm(`Delete tag "${tag}"? This will remove it from all sites.`)) return;
  const { tagList = [], domainTags = {} } = await chrome.storage.local.get(['tagList', 'domainTags']);
  const list = (Array.isArray(tagList) ? tagList : []).filter(t => t !== tag);
  const nextTags = {};
  for (const [domain, tags] of Object.entries(domainTags || {})) {
    const next = (tags || []).filter(t => t !== tag);
    if (next.length) nextTags[domain] = next;
  }
  await chrome.storage.local.set({ tagList: list, domainTags: nextTags });
  cachedTagList = list;
  cachedDomainTags = nextTags;
  renderSettingsTagList(list);
  loadAndRender();
});

document.getElementById('settingsCancel').addEventListener('click', () => settingsDialog.close());
document.getElementById('settingsSave').addEventListener('click', async () => {
  const raw = document.getElementById('excludeDomains').value.trim();
  const excludeDomains = raw ? raw.split(/\n/).map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const timeGranularityMs = Math.max(1000, parseInt(document.getElementById('timeGranularity').value, 10) || 1000);
  const theme = document.getElementById('themeSelect').value === 'light' ? 'light' : 'dark';
  const keepIncognitoData = document.getElementById('keepIncognitoData').checked;
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: { ...settings, excludeDomains, timeGranularityMs, theme, keepIncognitoData }
  });
  applyTheme(theme);
  settingsDialog.close();
});

settingsDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  settingsDialog.close();
});

document.getElementById('datePicker').value = currentDateKey;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.days || changes.settings || changes.currentSession || changes.domainTags || changes.tagList)) {
    if (changes.settings?.newValue?.theme) applyTheme(changes.settings.newValue.theme);
    loadAndRender();
  }
});

(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  applyTheme(settings.theme);
  loadAndRender();
})();
