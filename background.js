/**
 * Website Time Tracker - Service Worker (MV3)
 * Tracks time per hostname when: tab active, window focused, user not idle.
 * All data in chrome.storage.local.
 *
 * State is centralized in TrackerState to reduce race conditions from async events.
 */

const ALARM_PERSIST = 'persist';
const PERSIST_INTERVAL_MIN = 0.5;
const IDLE_THRESHOLD_SEC = 60;
const DEFAULT_GRANULARITY_MS = 1000;

// ─── Pure utilities ─────────────────────────────────────────────────────────

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
    timeGranularityMs: typeof s.timeGranularityMs === 'number' ? s.timeGranularityMs : DEFAULT_GRANULARITY_MS,
    keepIncognitoData: s.keepIncognitoData === true
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

// ─── Centralized state (single source of truth) ──────────────────────────────

class TrackerState {
  constructor() {
    this.session = null;       // { domain, start, persistedAt, tabId, windowId, wasIncognito }
    this.focusedWindowId = null;
    this.incognitoWindowIds = new Set();
    this.isIdle = false;
    this.pendingWrite = null;
  }

  hasSession() {
    return this.session?.domain != null && this.session?.start != null;
  }

  /** Snapshot for endSession; safe to use after clearSession since we capture before clearing. */
  snapshot() {
    if (!this.session) return null;
    return {
      domain: this.session.domain,
      start: this.session.start,
      persistedAt: this.session.persistedAt,
      tabIdToCheck: this.session.tabId,
      wasIncognito: this.session.wasIncognito
    };
  }

  clearSession() {
    this.session = null;
    this.pendingWrite = null;
  }

  reset() {
    this.session = null;
    this.focusedWindowId = null;
    this.incognitoWindowIds.clear();
    this.isIdle = false;
    this.pendingWrite = null;
  }
}

const state = new TrackerState();

// ─── Session persistence (writes to storage) ────────────────────────────────

async function endSession(override) {
  const useOverride = override && override.domain != null && override.start != null;
  const domain = useOverride ? override.domain : state.session?.domain;
  const start = useOverride ? override.start : state.session?.start;
  const persistedAt = useOverride ? override.persistedAt : state.session?.persistedAt;
  const tabIdToCheck = useOverride && override.tabIdToCheck !== undefined ? override.tabIdToCheck : state.session?.tabId;
  const wasIncognito = useOverride && override.wasIncognito !== undefined ? override.wasIncognito : state.session?.wasIncognito;

  if (domain != null && start != null) {
    state.clearSession();
  }
  if (domain == null || start == null) return;

  const settings = await getSettings();
  if (!shouldTrack(domain, settings.excludeDomains)) return;

  if (!settings.keepIncognitoData && wasIncognito) {
    return;
  }

  const now = Date.now();
  const increment = roundMs(now - (persistedAt ?? start), settings.timeGranularityMs);

  const key = getDateKey();
  const data = await chrome.storage.local.get({ days: {} });
  const days = data.days || {};
  if (!days[key]) days[key] = { domains: {}, timeline: [] };
  const day = days[key];
  if (!day.domains[domain]) day.domains[domain] = { ms: 0 };
  if (increment > 0) day.domains[domain].ms += increment;
  day.timeline.push({ start, end: now, domain });
  await chrome.storage.local.set({ days, currentSession: null, _pendingSession: null });
}

async function persistRunningTotal() {
  if (!state.hasSession()) return;
  const s = state.session;
  const settings = await getSettings();
  if (!shouldTrack(s.domain, settings.excludeDomains)) {
    state.clearSession();
    await chrome.storage.local.set({ currentSession: null });
    return;
  }
  if (!settings.keepIncognitoData && s.wasIncognito) return;

  const now = Date.now();
  const from = s.persistedAt ?? s.start;
  const delta = roundMs(now - from, settings.timeGranularityMs);
  if (delta <= 0) {
    s.persistedAt = now;
    return;
  }

  const key = getDateKey();
  const data = await chrome.storage.local.get({ days: {} });
  const days = data.days || {};
  if (!days[key]) days[key] = { domains: {}, timeline: [] };
  const day = days[key];
  if (!day.domains[s.domain]) day.domains[s.domain] = { ms: 0 };
  day.domains[s.domain].ms += delta;
  s.persistedAt = now;
  await chrome.storage.local.set({ days });
  state.pendingWrite = null;
}

// ─── Tracker actions (centralized entry points) ───────────────────────────────

function stopTracking() {
  if (!state.hasSession()) return null;
  if (state.pendingWrite) return state.pendingWrite;

  const snapshot = state.snapshot();
  state.clearSession();

  const promise = endSession(snapshot);
  state.pendingWrite = promise;
  promise.finally(() => { state.pendingWrite = null; });
  return promise;
}

async function startTracking(hostname, tabId) {
  const settings = await getSettings();
  if (!shouldTrack(hostname, settings.excludeDomains)) return;

  const now = Date.now();
  let windowId = null;
  let wasIncognito = false;

  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      wasIncognito = tab?.incognito ?? false;
      windowId = tab?.windowId ?? null;
      if (tab?.incognito && tab?.windowId) {
        state.incognitoWindowIds.add(tab.windowId);
      }
    } catch {
      wasIncognito = false;
    }
  }

  state.session = {
    domain: hostname,
    start: now,
    persistedAt: now,
    tabId: tabId ?? null,
    windowId,
    wasIncognito
  };

  const pendingSession = {
    domain: hostname,
    start: now,
    persistedAt: now,
    windowId: windowId ?? undefined,
    wasIncognito
  };
  await chrome.storage.local.set({
    currentSession: { domain: hostname, start: now },
    _pendingSession: pendingSession
  });
}

// ─── Event handlers ──────────────────────────────────────────────────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_PERSIST);
  if (!existing) {
    chrome.alarms.create(ALARM_PERSIST, { periodInMinutes: PERSIST_INTERVAL_MIN });
  }
}

async function handleActiveTab(tabId, windowId) {
  // Recover from durable pending session when window is gone (SW restart / last incognito closed)
  if (!state.hasSession()) {
    const stored = await chrome.storage.local.get({ _pendingSession: null });
    const pending = stored._pendingSession;
    if (pending?.domain != null && pending?.start != null && pending?.windowId != null && pending.windowId !== windowId) {
      const pendingWindowGone = await chrome.windows.get(pending.windowId).then(() => false, () => true);
      if (pendingWindowGone) {
        await endSession({
          domain: pending.domain,
          start: pending.start,
          persistedAt: pending.persistedAt,
          tabIdToCheck: undefined,
          wasIncognito: pending.wasIncognito !== false
        });
        await chrome.storage.local.set({ _pendingSession: null });
        state.focusedWindowId = windowId;
      }
    }
  }

  // End session when switching to a different window
  if (windowId !== state.focusedWindowId) {
    const w = stopTracking();
    if (w) await w;
    state.focusedWindowId = windowId;
  } else if (state.hasSession() && state.session.windowId != null && windowId !== state.session.windowId) {
    const w = stopTracking();
    if (w) await w;
    state.focusedWindowId = windowId;
  }

  if (tabId == null) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    const hostname = hostnameFromUrl(tab?.url);
    const url = tab?.url || '';
    const tabStillLoading = !url || url === 'about:blank';

    if (tabId !== state.session?.tabId && state.hasSession() &&
        (hostname === state.session.domain || (hostname == null && tabStillLoading))) {
      state.session.tabId = tabId;
      return;
    }

    if (tabId !== state.session?.tabId) {
      const w = stopTracking();
      if (w) await w;
    }

    if (hostname && state.focusedWindowId === windowId) {
      await startTracking(hostname, tabId);
    } else {
      const w = stopTracking();
      if (w) await w;
      if (!hostname) await chrome.storage.local.set({ currentSession: null });
    }
  } catch {
    const w = stopTracking();
    if (w) await w;
    await chrome.storage.local.set({ currentSession: null }).catch(() => {});
  }
}

async function handleWindowFocus(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    stopTracking();
    state.focusedWindowId = null;
    return;
  }

  const wasFocused = state.focusedWindowId;
  state.focusedWindowId = windowId;

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

async function onIdleStateChange(idleState) {
  const nowIdle = idleState !== 'active';
  if (nowIdle && !state.isIdle) {
    state.isIdle = true;
    stopTracking();
  } else if (!nowIdle && state.isIdle) {
    state.isIdle = false;
    try {
      const win = await chrome.windows.getLastFocused();
      if (win?.id != null) {
        state.focusedWindowId = win.id;
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tab) await handleActiveTab(tab.id, win.id);
      }
    } catch {}
  }
}

async function onTabActivated(activeInfo) {
  if (activeInfo.windowId !== state.focusedWindowId) {
    const w = stopTracking();
    if (w) await w;
    state.focusedWindowId = activeInfo.windowId;
  }
  await handleActiveTab(activeInfo.tabId, activeInfo.windowId);
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.url === undefined) return;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || active.id !== tabId) return;
  if (active.windowId !== state.focusedWindowId) return;

  const url = tab?.url || changeInfo.url;
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    stopTracking();
    return;
  }
  if (hostname === state.session?.domain && tabId === state.session?.tabId) return;

  const w = stopTracking();
  if (w) await w;
  await startTracking(hostname, tabId);
}

async function reconcileWithCurrentTab() {
  if (!state.hasSession()) return;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null && win.id !== state.focusedWindowId) {
      const w = stopTracking();
      if (w) await w;
      state.focusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) await handleActiveTab(tab.id, win.id);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.focusedWindowId });
    if (!tab || tab.id !== state.session?.tabId) {
      const w = stopTracking();
      if (w) await w;
      if (tab) await handleActiveTab(tab.id, state.focusedWindowId);
    }
  } catch {
    stopTracking();
  }
}

async function onTabRemoved(tabId) {
  if (tabId !== state.session?.tabId) return;

  const write = stopTracking();
  if (write) await write;

  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null) {
      state.focusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) await handleActiveTab(tab.id, win.id);
    }
  } catch {}
}

// ─── Listener registration ──────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onRemoved.addListener(onTabRemoved);

chrome.windows.onRemoved.addListener(async (windowId) => {
  if (state.incognitoWindowIds.has(windowId)) {
    state.incognitoWindowIds.delete(windowId);
    if (state.hasSession() &&
        (windowId === state.focusedWindowId || windowId === state.session.windowId)) {
      const write = stopTracking();
      if (write) await write;
    }
  }
});

chrome.windows.onFocusChanged.addListener(handleWindowFocus);
chrome.idle.onStateChanged.addListener(onIdleStateChange);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_PERSIST) return;
  await persistRunningTotal();
  await reconcileWithCurrentTab();
});

// ─── Storage sync (incognito bridge – kept for compatibility; service worker uses single partition) ───

let lastProcessedSyncTimestamp = 0;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes._incognitoSyncPending?.newValue) {
    const syncMarker = changes._incognitoSyncPending.newValue;
    const syncData = syncMarker.data;
    const syncTimestamp = syncMarker.timestamp || 0;

    if (syncTimestamp <= lastProcessedSyncTimestamp) return;
    lastProcessedSyncTimestamp = syncTimestamp;

    (async () => {
      try {
        const { days: incognitoDays, domainTags: incognitoDomainTags, tagList: incognitoTagList } = syncData;
        const regularData = await chrome.storage.local.get(['days', 'domainTags', 'tagList']);
        const regularDays = regularData.days || {};
        const regularDomainTags = regularData.domainTags || {};
        const regularTagList = regularData.tagList || [];

        if (incognitoDays) {
          for (const [dateKey, incognitoDay] of Object.entries(incognitoDays)) {
            if (!regularDays[dateKey]) regularDays[dateKey] = { domains: {}, timeline: [] };
            const regularDay = regularDays[dateKey];

            for (const [domain, incognitoDomainData] of Object.entries(incognitoDay.domains || {})) {
              if (!regularDay.domains[domain]) regularDay.domains[domain] = { ms: 0 };
              regularDay.domains[domain].ms = (regularDay.domains[domain].ms || 0) + (incognitoDomainData.ms || 0);
            }

            if (incognitoDay.timeline) {
              const existingBlocks = new Map();
              (regularDay.timeline || []).forEach(block => {
                existingBlocks.set(`${block.start}-${block.end}-${block.domain}`, block);
              });
              incognitoDay.timeline.forEach(block => {
                const key = `${block.start}-${block.end}-${block.domain}`;
                if (!existingBlocks.has(key)) existingBlocks.set(key, block);
              });
              regularDay.timeline = Array.from(existingBlocks.values()).sort((a, b) => (a.start || 0) - (b.start || 0));
            }
          }
        }

        if (incognitoDomainTags) Object.assign(regularDomainTags, incognitoDomainTags);

        if (incognitoTagList && Array.isArray(incognitoTagList)) {
          const tagSet = new Set(regularTagList);
          incognitoTagList.forEach(tag => tagSet.add(tag));
          const mergedTagList = Array.from(tagSet).sort();
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags,
            tagList: mergedTagList,
            _incognitoSyncPending: null
          });
        } else {
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags,
            _incognitoSyncPending: null
          });
        }
      } catch {}
    })();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_INCOGNITO_TO_REGULAR') {
    (async () => {
      try {
        const { days: incognitoDays, domainTags: incognitoDomainTags, tagList: incognitoTagList } = message.data;
        const regularData = await chrome.storage.local.get(['days', 'domainTags', 'tagList']);
        const regularDays = regularData.days || {};
        const regularDomainTags = regularData.domainTags || {};
        const regularTagList = regularData.tagList || [];

        if (incognitoDays) {
          for (const [dateKey, incognitoDay] of Object.entries(incognitoDays)) {
            if (!regularDays[dateKey]) regularDays[dateKey] = { domains: {}, timeline: [] };
            const regularDay = regularDays[dateKey];

            for (const [domain, incognitoDomainData] of Object.entries(incognitoDay.domains || {})) {
              if (!regularDay.domains[domain]) regularDay.domains[domain] = { ms: 0 };
              regularDay.domains[domain].ms = (regularDay.domains[domain].ms || 0) + (incognitoDomainData.ms || 0);
            }

            if (incognitoDay.timeline) {
              regularDay.timeline = (regularDay.timeline || []).concat(incognitoDay.timeline);
              regularDay.timeline.sort((a, b) => (a.start || 0) - (b.start || 0));
            }
          }
        }

        if (incognitoDomainTags) Object.assign(regularDomainTags, incognitoDomainTags);

        if (incognitoTagList && Array.isArray(incognitoTagList)) {
          const tagSet = new Set(regularTagList);
          incognitoTagList.forEach(tag => tagSet.add(tag));
          const mergedTagList = Array.from(tagSet).sort();
          await chrome.storage.local.set({ days: regularDays, domainTags: regularDomainTags, tagList: mergedTagList });
        } else {
          await chrome.storage.local.set({ days: regularDays, domainTags: regularDomainTags });
        }
      } catch (err) {
        console.error('Error syncing incognito data to regular storage:', err);
      }
    })();
    return true;
  }
});

// ─── Startup / install ──────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  state.reset();
  await chrome.storage.local.set({ currentSession: null });
  await ensureAlarm();
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.id != null) {
      state.focusedWindowId = win.id;
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
      state.focusedWindowId = win.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (tab) {
        const hostname = hostnameFromUrl(tab.url);
        if (hostname) await startTracking(hostname, tab.id);
      }
    }
  } catch {}
});
