/**
 * Website Time Tracker - Service Worker (MV3)
 * Tracks time per hostname when: tab active, window focused, user not idle.
 * All data in chrome.storage.local. Incognito uses split storage.
 */

const ALARM_PERSIST = 'persist';
const PERSIST_INTERVAL_MIN = 0.5;
const IDLE_THRESHOLD_SEC = 60;
const DEFAULT_GRANULARITY_MS = 1000;

let lastDomain = null;
let lastStartTimestamp = null;  // real session start (for timeline block)
let lastPersistedAt = null;    // last time we wrote to storage (for incremental total only)
let lastTabId = null;
let lastFocusedWindowId = null;
let isIdle = false;
let pendingWrite = null;

function getDateKey() {
  const d = new Date();
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

async function getSettings() {
  const raw = await chrome.storage.local.get({ settings: {} });
  const s = raw.settings || {};
  return {
    excludeDomains: Array.isArray(s.excludeDomains) ? s.excludeDomains : [],
    timeGranularityMs: typeof s.timeGranularityMs === 'number' ? s.timeGranularityMs : DEFAULT_GRANULARITY_MS
  };
}

function shouldTrack(hostname, excludeDomains) {
  if (!hostname) return false;
  return !excludeDomains.includes(hostname);
}

function roundMs(ms, granularityMs) {
  if (!granularityMs || granularityMs <= 0) return ms;
  return Math.floor(ms / granularityMs) * granularityMs;
}

/**
 * End current session: write one timeline block (start → now) and update domain total.
 * Call on tab switch, tab close, window unfocus, idle. Clears in-memory state.
 */
async function endSession() {
  const domain = lastDomain;
  const start = lastStartTimestamp;
  const persistedAt = lastPersistedAt;
  lastDomain = null;
  lastStartTimestamp = null;
  lastPersistedAt = null;
  lastTabId = null;
  if (domain == null || start == null) return;

  const settings = await getSettings();
  if (!shouldTrack(domain, settings.excludeDomains)) return;

  const now = Date.now();
  // Only add time since last persist (rest was already added by persistRunningTotal)
  const increment = roundMs(now - (persistedAt ?? start), settings.timeGranularityMs);

  const key = getDateKey();
  const data = await chrome.storage.local.get({ days: {} });
  const days = data.days || {};
  if (!days[key]) days[key] = { domains: {}, timeline: [] };
  const day = days[key];
  if (!day.domains[domain]) day.domains[domain] = { ms: 0 };
  if (increment > 0) day.domains[domain].ms += increment;
  // Timeline block always uses full session duration (start → now)
  day.timeline.push({ start, end: now, domain });
  await chrome.storage.local.set({ days, currentSession: null });
  pendingWrite = null;
}

/**
 * Persist running total only (no new timeline block). Call on periodic alarm.
 * Keeps domain total up to date so we don't lose time on crash; timeline block is written when session ends.
 */
async function persistRunningTotal() {
  if (lastDomain == null || lastStartTimestamp == null) return;
  const settings = await getSettings();
  if (!shouldTrack(lastDomain, settings.excludeDomains)) {
    lastDomain = null;
    lastStartTimestamp = null;
    lastPersistedAt = null;
    lastTabId = null;
    await chrome.storage.local.set({ currentSession: null });
    return;
  }
  const now = Date.now();
  const from = lastPersistedAt ?? lastStartTimestamp;
  const delta = roundMs(now - from, settings.timeGranularityMs);
  if (delta <= 0) {
    lastPersistedAt = now;
    return;
  }
  const key = getDateKey();
  const data = await chrome.storage.local.get({ days: {} });
  const days = data.days || {};
  if (!days[key]) days[key] = { domains: {}, timeline: [] };
  const day = days[key];
  if (!day.domains[lastDomain]) day.domains[lastDomain] = { ms: 0 };
  day.domains[lastDomain].ms += delta;
  lastPersistedAt = now;  // do not change lastStartTimestamp (needed for correct timeline block)
  await chrome.storage.local.set({ days });
  pendingWrite = null;
}

function stopTracking() {
  if (lastDomain == null || lastStartTimestamp == null) return null;
  if (pendingWrite) return pendingWrite;
  pendingWrite = endSession();
  pendingWrite.finally(() => { pendingWrite = null; });
  return pendingWrite;
}

async function startTracking(hostname, tabId) {
  const settings = await getSettings();
  if (!shouldTrack(hostname, settings.excludeDomains)) return;
  lastDomain = hostname;
  const now = Date.now();
  lastStartTimestamp = now;
  lastPersistedAt = now;
  lastTabId = tabId ?? null;
  await chrome.storage.local.set({ currentSession: { domain: hostname, start: now } });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_PERSIST);
  if (!existing) {
    chrome.alarms.create(ALARM_PERSIST, { periodInMinutes: PERSIST_INTERVAL_MIN });
  }
}

async function handleActiveTab(tabId, windowId) {
  if (windowId !== lastFocusedWindowId) {
    const w = stopTracking();
    if (w) await w;
    lastFocusedWindowId = windowId;
  }
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const hostname = hostnameFromUrl(tab?.url);
    const url = tab?.url || '';
    const tabStillLoading = !url || url === 'about:blank';
    if (tabId !== lastTabId && lastDomain != null && (hostname === lastDomain || (hostname == null && tabStillLoading))) {
      lastTabId = tabId;
      return;
    }
    if (tabId !== lastTabId) {
      const w = stopTracking();
      if (w) await w;
    }
    if (hostname && lastFocusedWindowId === windowId) {
      await startTracking(hostname, tabId);
    } else {
      stopTracking();
    }
  } catch {
    stopTracking();
  }
}

async function handleWindowFocus(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    stopTracking();
    lastFocusedWindowId = null;
    return;
  }
  const wasFocused = lastFocusedWindowId;
  lastFocusedWindowId = windowId;
  if (wasFocused !== windowId) {
    const w = stopTracking();
    if (w) await w;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await handleActiveTab(tab.id, windowId);
  } catch {
    stopTracking();
  }
}

async function onIdleStateChange(state) {
  const nowIdle = state !== 'active';
  if (nowIdle && !isIdle) {
    isIdle = true;
    stopTracking();
  } else if (!nowIdle && isIdle) {
    isIdle = false;
    try {
      const win = await chrome.windows.getLastFocused();
      if (win?.id != null) {
        lastFocusedWindowId = win.id;
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tab) await handleActiveTab(tab.id, win.id);
      }
    } catch {}
  }
}

async function onTabActivated(activeInfo) {
  if (activeInfo.windowId !== lastFocusedWindowId) {
    const w = stopTracking();
    if (w) await w;
    lastFocusedWindowId = activeInfo.windowId;
  }
  await handleActiveTab(activeInfo.tabId, activeInfo.windowId);
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.url === undefined) return;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || active.id !== tabId) return;
  if (active.windowId !== lastFocusedWindowId) return;
  const url = tab?.url || changeInfo.url;
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    stopTracking();
    return;
  }
  if (hostname === lastDomain && tabId === lastTabId) return;
  const w = stopTracking();
  if (w) await w;
  await startTracking(hostname, tabId);
}

/** If the active tab/window doesn't match our state, end session and sync to current tab. */
async function reconcileWithCurrentTab() {
  if (lastDomain == null) return;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null && win.id !== lastFocusedWindowId) {
      const w = stopTracking();
      if (w) await w;
      lastFocusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) await handleActiveTab(tab.id, win.id);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: lastFocusedWindowId });
    if (!tab || tab.id !== lastTabId) {
      const w = stopTracking();
      if (w) await w;
      if (tab) await handleActiveTab(tab.id, lastFocusedWindowId);
    }
  } catch {
    stopTracking();
  }
}

async function onTabRemoved(tabId) {
  if (tabId === lastTabId) {
    const write = stopTracking();
    if (write) await write;
    try {
      const win = await chrome.windows.getLastFocused();
      if (win?.id != null) {
        lastFocusedWindowId = win.id;
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tab) await handleActiveTab(tab.id, win.id);
      }
    } catch {}
  }
}

chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.windows.onFocusChanged.addListener(handleWindowFocus);
chrome.idle.onStateChanged.addListener(onIdleStateChange);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_PERSIST) return;
  await persistRunningTotal();
  await reconcileWithCurrentTab();
});

chrome.runtime.onStartup.addListener(async () => {
  lastDomain = null;
  lastStartTimestamp = null;
  lastPersistedAt = null;
  lastTabId = null;
  lastFocusedWindowId = null;
  isIdle = false;
  pendingWrite = null;
  await chrome.storage.local.set({ currentSession: null });
  await ensureAlarm();
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null) {
      lastFocusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) await handleActiveTab(tab.id, win.id);
    }
  } catch {}
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const data = await chrome.storage.local.get({ days: {}, settings: {}, domainTags: {}, tagList: [] });
  const updates = {};
  if (!data.settings || typeof data.settings.timeGranularityMs !== 'number') {
    updates.settings = { excludeDomains: [], timeGranularityMs: DEFAULT_GRANULARITY_MS };
  }
  if (!Array.isArray(data.tagList) || data.tagList.length === 0) updates.tagList = ['Social', 'Study', 'Work'];
  if (!data.domainTags || typeof data.domainTags !== 'object') updates.domainTags = {};
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null) {
      lastFocusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) {
        const hostname = hostnameFromUrl(tab.url);
        if (hostname) await startTracking(hostname, tab.id);
      }
    }
  } catch {}
});
