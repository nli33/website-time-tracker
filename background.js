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
let lastTabIncognito = false;  // track if the tab being tracked is incognito
let lastFocusedWindowId = null;
let lastTrackedWindowId = null;  // window of the tab we're currently tracking (so we can end session when that window closes)
let incognitoWindowIds = new Set();  // track which windows are incognito
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
    timeGranularityMs: typeof s.timeGranularityMs === 'number' ? s.timeGranularityMs : DEFAULT_GRANULARITY_MS,
    keepIncognitoData: s.keepIncognitoData === true
  };
}

/**
 * Write data to regular storage when in incognito context and keepIncognitoData is enabled.
 * Uses chrome.storage.local.set() with a special key that will be picked up by storage.onChanged
 * listener in regular context, or directly merges if we can access regular storage.
 * 
 * Note: With split storage, chrome.storage.local in incognito context writes to incognito storage.
 * We use a workaround: write to a special key that the regular context can read and merge.
 */
async function writeToRegularStorage(data) {
  try {
    // Try message-based sync first
    await chrome.runtime.sendMessage({
      type: 'SYNC_INCOGNITO_TO_REGULAR',
      data: data
    }).catch(() => {
      // If message fails, use storage-based sync as fallback
      // Write to a special key that indicates this should be synced
      chrome.storage.local.set({
        _incognitoSyncPending: {
          timestamp: Date.now(),
          data: data
        }
      }).catch(() => {});
    });
  } catch (err) {
  }
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
 * @param {{ domain?, start?, persistedAt?, tabIdToCheck?, wasIncognito? } | void} override - If provided (by stopTracking), use these so we don't rely on globals that may already be overwritten by another handler.
 */
async function endSession(override) {
  const useOverride = override && override.domain != null && override.start != null;
  const domain = useOverride ? override.domain : lastDomain;
  const start = useOverride ? override.start : lastStartTimestamp;
  const persistedAt = useOverride ? override.persistedAt : lastPersistedAt;
  const tabIdToCheck = useOverride && override.tabIdToCheck !== undefined ? override.tabIdToCheck : lastTabId;
  const wasIncognito = useOverride && override.wasIncognito !== undefined ? override.wasIncognito : lastTabIncognito;
  // Always clear once we've claimed this session so we don't double-end it (duplicate blocks) and so concurrent stopTracking() returns early.
  if (domain != null && start != null) {
    lastDomain = null;
    lastStartTimestamp = null;
    lastPersistedAt = null;
    lastTabId = null;
    lastTabIncognito = false;
    lastTrackedWindowId = null;
  }
  if (domain == null || start == null) return;

  const settings = await getSettings();
  if (!shouldTrack(domain, settings.excludeDomains)) return;

  // When "Keep incognito data" is off, do not persist incognito sessions to storage at all (so they never appear in the timeline).
  if (!settings.keepIncognitoData && wasIncognito) {
    pendingWrite = null;
    return;
  }

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
  await chrome.storage.local.set({ days, currentSession: null, _pendingSession: null });

  // Do not call writeToRegularStorage here: the service worker has a single storage partition, so
  // the write above already saved this session. Syncing would merge the same data again and double-count.
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
  // When "Keep incognito data" is off, do not persist incognito session time to storage.
  if (!settings.keepIncognitoData && lastTabIncognito) return;
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

  // Do not sync incognito→regular here: the alarm runs every ~30s, so we would merge the same
  // cumulative incognito data repeatedly and multiply totals (~n× after n syncs). Sync only when
  // we flush (endSession, onTabRemoved, onWindowRemoved).

  pendingWrite = null;
}

function stopTracking() {
  if (lastDomain == null || lastStartTimestamp == null) return null;
  if (pendingWrite) return pendingWrite;
  // Capture full session at invoke time so endSession uses it even if another handler overwrites globals before endSession runs.
  const sessionOverride = {
    domain: lastDomain,
    start: lastStartTimestamp,
    persistedAt: lastPersistedAt,
    tabIdToCheck: lastTabId,
    wasIncognito: lastTabIncognito
  };
  pendingWrite = endSession(sessionOverride);
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
  // Track if this tab is incognito and track its window
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      lastTabIncognito = tab?.incognito ?? false;
      lastTrackedWindowId = tab?.windowId ?? null;
      if (tab?.incognito && tab?.windowId) {
        incognitoWindowIds.add(tab.windowId);
      }
    } catch (err) {
      lastTabIncognito = false;
    }
  } else {
    lastTabIncognito = false;
  }
  const pendingSession = {
    domain: hostname,
    start: now,
    persistedAt: now,
    windowId: lastTrackedWindowId ?? undefined,
    wasIncognito: lastTabIncognito
  };
  await chrome.storage.local.set({
    currentSession: { domain: hostname, start: now },
    _pendingSession: pendingSession
  });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_PERSIST);
  if (!existing) {
    chrome.alarms.create(ALARM_PERSIST, { periodInMinutes: PERSIST_INTERVAL_MIN });
  }
}

async function handleActiveTab(tabId, windowId) {
  // Recover from durable pending session only when that window is gone (last incognito closed); avoids writing stale pending from a previous run/SW restart
  if (lastTabId == null && lastDomain == null) {
    const stored = await chrome.storage.local.get({ _pendingSession: null });
    const pending = stored._pendingSession;
    if (pending?.domain != null && pending?.start != null && pending?.windowId != null && pending.windowId !== windowId) {
      const pendingWindowGone = await chrome.windows.get(pending.windowId).then(() => false, () => true);
      if (pendingWindowGone) {
        // Treat undefined wasIncognito as incognito so we don't persist when "Keep incognito data" is off (avoids one stray block from recovered pending).
        await endSession({
          domain: pending.domain,
          start: pending.start,
          persistedAt: pending.persistedAt,
          tabIdToCheck: undefined,
          wasIncognito: pending.wasIncognito !== false
        });
        await chrome.storage.local.set({ _pendingSession: null });
        lastFocusedWindowId = windowId;
      }
    }
  }
  // End session when switching to a different window (focus may have already moved, so also check lastTrackedWindowId)
  if (windowId !== lastFocusedWindowId) {
    const w = stopTracking();
    if (w) await w;
    lastFocusedWindowId = windowId;
  } else if (lastDomain != null && lastTrackedWindowId != null && windowId !== lastTrackedWindowId) {
    // Same "focused" window id but we're tracking a session in another window (e.g. incognito closed, focus already moved) — end that session
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
      const w = stopTracking();
      if (w) await w;
      // Clear currentSession so the UI doesn't show a stale "live" session (e.g. after closing incognito and landing on chrome://extensions)
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
  // Check if this tab was incognito before it's removed
  let wasIncognitoTab = false;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    wasIncognitoTab = tab?.incognito ?? false;
  } catch {}
  if (tabId === lastTabId) {
    const write = stopTracking();
    if (write) await write;
    // No writeToRegularStorage: service worker has one storage; stopTracking already wrote there.
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
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Check if this is a tracked incognito window (we track these when we start tracking tabs in them)
  if (incognitoWindowIds.has(windowId)) {
    incognitoWindowIds.delete(windowId);
    // End current session if it belonged to this window (focus may have already moved, so check lastTrackedWindowId too)
    if (lastDomain != null && (windowId === lastFocusedWindowId || windowId === lastTrackedWindowId)) {
      const write = stopTracking();
      if (write) await write;
    }
    // No writeToRegularStorage: service worker has one storage; stopTracking already wrote there.
  }
});
chrome.windows.onFocusChanged.addListener(handleWindowFocus);
chrome.idle.onStateChanged.addListener(onIdleStateChange);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_PERSIST) return;
  await persistRunningTotal();
  await reconcileWithCurrentTab();
});

// Storage change listener to handle incognito sync via storage bridge
let lastProcessedSyncTimestamp = 0;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes._incognitoSyncPending?.newValue) {
    const syncMarker = changes._incognitoSyncPending.newValue;
    const syncData = syncMarker.data;
    const syncTimestamp = syncMarker.timestamp || 0;
    
    // Deduplicate: only process if this is a new sync (different timestamp)
    if (syncTimestamp <= lastProcessedSyncTimestamp) return;
    lastProcessedSyncTimestamp = syncTimestamp;
    // Merge incognito data into regular storage (this runs in regular context)
    (async () => {
      try {
        const { days: incognitoDays, domainTags: incognitoDomainTags, tagList: incognitoTagList } = syncData;
        const regularData = await chrome.storage.local.get(['days', 'domainTags', 'tagList']);
        const regularDays = regularData.days || {};
        const regularDomainTags = regularData.domainTags || {};
        const regularTagList = regularData.tagList || [];
        
        // Merge days
        if (incognitoDays) {
          for (const [dateKey, incognitoDay] of Object.entries(incognitoDays)) {
            if (!regularDays[dateKey]) {
              regularDays[dateKey] = { domains: {}, timeline: [] };
            }
            const regularDay = regularDays[dateKey];
            
            // Merge domains
            for (const [domain, incognitoDomainData] of Object.entries(incognitoDay.domains || {})) {
              if (!regularDay.domains[domain]) {
                regularDay.domains[domain] = { ms: 0 };
              }
              regularDay.domains[domain].ms = (regularDay.domains[domain].ms || 0) + (incognitoDomainData.ms || 0);
            }
            
            // Merge timeline blocks (deduplicate by start/end/domain)
            if (incognitoDay.timeline) {
              const existingBlocks = new Map();
              (regularDay.timeline || []).forEach(block => {
                const key = `${block.start}-${block.end}-${block.domain}`;
                existingBlocks.set(key, block);
              });
              incognitoDay.timeline.forEach(block => {
                const key = `${block.start}-${block.end}-${block.domain}`;
                if (!existingBlocks.has(key)) {
                  existingBlocks.set(key, block);
                }
              });
              regularDay.timeline = Array.from(existingBlocks.values()).sort((a, b) => (a.start || 0) - (b.start || 0));
            }
          }
        }
        
        // Merge domain tags
        if (incognitoDomainTags) {
          Object.assign(regularDomainTags, incognitoDomainTags);
        }
        
        // Merge tag list
        if (incognitoTagList && Array.isArray(incognitoTagList)) {
          const tagSet = new Set(regularTagList);
          incognitoTagList.forEach(tag => tagSet.add(tag));
          const mergedTagList = Array.from(tagSet).sort();
          
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags,
            tagList: mergedTagList,
            _incognitoSyncPending: null // Clear the sync marker
          });
        } else {
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags,
            _incognitoSyncPending: null
          });
        }
      } catch (err) {}
    })();
  }
});

// Message handler to sync incognito data to regular storage
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_INCOGNITO_TO_REGULAR') {
    // This handler should run in regular context and write to regular storage
    (async () => {
      try {
        // Verify we're not in incognito context by checking if sender is incognito
        // If sender is incognito, this handler should write to regular storage
        // (chrome.storage.local in regular context writes to regular storage)
        const { days: incognitoDays, currentSession: incognitoSession, domainTags: incognitoDomainTags, tagList: incognitoTagList } = message.data;
        
        // Get current regular storage
        const regularData = await chrome.storage.local.get(['days', 'domainTags', 'tagList']);
        const regularDays = regularData.days || {};
        const regularDomainTags = regularData.domainTags || {};
        const regularTagList = regularData.tagList || [];
        
        // Merge incognito days into regular days
        if (incognitoDays) {
          for (const [dateKey, incognitoDay] of Object.entries(incognitoDays)) {
            if (!regularDays[dateKey]) {
              regularDays[dateKey] = { domains: {}, timeline: [] };
            }
            const regularDay = regularDays[dateKey];
            
            // Merge domains
            for (const [domain, incognitoDomainData] of Object.entries(incognitoDay.domains || {})) {
              if (!regularDay.domains[domain]) {
                regularDay.domains[domain] = { ms: 0 };
              }
              regularDay.domains[domain].ms = (regularDay.domains[domain].ms || 0) + (incognitoDomainData.ms || 0);
            }
            
            // Merge timeline blocks
            if (incognitoDay.timeline) {
              regularDay.timeline = (regularDay.timeline || []).concat(incognitoDay.timeline);
              // Sort timeline by start time
              regularDay.timeline.sort((a, b) => (a.start || 0) - (b.start || 0));
            }
          }
        }
        
        // Merge domain tags (incognito tags take precedence for same domain)
        if (incognitoDomainTags) {
          Object.assign(regularDomainTags, incognitoDomainTags);
        }
        
        // Merge tag list (union, keep unique)
        if (incognitoTagList && Array.isArray(incognitoTagList)) {
          const tagSet = new Set(regularTagList);
          incognitoTagList.forEach(tag => tagSet.add(tag));
          const mergedTagList = Array.from(tagSet).sort();
          
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags,
            tagList: mergedTagList
          });
        } else {
          await chrome.storage.local.set({
            days: regularDays,
            domainTags: regularDomainTags
          });
        }
      } catch (err) {
        console.error('Error syncing incognito data to regular storage:', err);
      }
    })();
    return true; // Keep message channel open for async response
  }
});

chrome.runtime.onStartup.addListener(async () => {
  lastDomain = null;
  lastStartTimestamp = null;
  lastPersistedAt = null;
  lastTabId = null;
  lastTabIncognito = false;
  lastFocusedWindowId = null;
  incognitoWindowIds.clear();
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
