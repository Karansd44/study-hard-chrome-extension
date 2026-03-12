/**
 * Study Lock — Background Service Worker
 * 
 * Responsibilities:
 * - Session state management (source of truth)
 * - Tab/window event listeners for enforcing the lock
 * - Alarm-based timer for reliable session expiry
 * - Message passing to content script and popup
 */

importScripts('utils/state-machine.js');

// ─────────────────────────────────────────────────────────
// In-Memory Cache (For zero-latency synchronous enforcement)
// ─────────────────────────────────────────────────────────
let cachedSession = null;

chrome.storage.session.get(SESSION_STORAGE_KEY).then(data => {
    cachedSession = data[SESSION_STORAGE_KEY] || createIdleSession();
});

chrome.storage.session.onChanged.addListener((changes) => {
    if (changes[SESSION_STORAGE_KEY]) {
        cachedSession = changes[SESSION_STORAGE_KEY].newValue || createIdleSession();
    }
});

// ─────────────────────────────────────────────────────────
// Helper: Get session from storage
// ─────────────────────────────────────────────────────────
async function getSession() {
    if (cachedSession) return cachedSession;
    const data = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    cachedSession = data[SESSION_STORAGE_KEY] || createIdleSession();
    return cachedSession;
}

async function setSession(session) {
    cachedSession = session;
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: session });
}

// ─────────────────────────────────────────────────────────
// Session Lifecycle
// ─────────────────────────────────────────────────────────

async function startSession({ tabId, windowId, duration, url }) {
    // Guard against double-start (e.g., race from rapid popup clicks)
    const current = await getSession();
    if (current.session_state === StudyLockStates.LOCKED) return;

    const session = createSessionData({ tabId, windowId, duration, url });
    await setSession(session);

    // Create an alarm for reliable session expiry
    chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: duration / 60,
    });

    // Fullscreen the window
    try {
        await chrome.windows.update(windowId, { focused: true, state: 'fullscreen' });
    } catch (e) {
        console.warn('Study Lock: Could not fullscreen window:', e);
    }

    // Ensure the locked tab is active
    try {
        await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
        console.warn('Study Lock: Could not activate tab:', e);
    }

    // Tell the content script to activate lock UI
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'ACTIVATE_LOCK',
            duration: duration,
            startTimestamp: session.session_start_timestamp,
        });
    } catch (e) {
        console.warn('Study Lock: Could not message content script:', e);
    }

    console.log(`Study Lock: Session started — ${duration}s on tab ${tabId}`);
}

async function endSession(reason = StudyLockStates.COMPLETED) {
    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;

    const newState = reason === StudyLockStates.COMPLETED
        ? StudyLockStates.COMPLETED
        : StudyLockStates.INTERRUPTED;

    // Update storage
    await setSession({
        ...session,
        session_state: newState,
    });

    // Clear the alarm
    chrome.alarms.clear(ALARM_NAME);

    // Exit fullscreen
    try {
        await chrome.windows.update(session.locked_window_id, { state: 'normal' });
    } catch (e) {
        console.warn('Study Lock: Could not restore window:', e);
    }

    // Notify content script
    try {
        await chrome.tabs.sendMessage(session.locked_tab_id, {
            action: newState === StudyLockStates.COMPLETED ? 'SESSION_COMPLETE' : 'SESSION_INTERRUPTED',
            totalDuration: session.timer_duration_seconds,
        });
    } catch (e) {
        console.warn('Study Lock: Could not notify content script of session end:', e);
    }

    console.log(`Study Lock: Session ended — ${newState}`);

    // Reset to IDLE immediately — setTimeout is unreliable in MV3 service workers
    // (Chrome can terminate the worker before the callback fires)
    await setSession(createIdleSession());
}

// ─────────────────────────────────────────────────────────
// Event Listeners — Tab Enforcement
// ─────────────────────────────────────────────────────────

// Prevent switching to other tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // 1. Synchronous Fast-Path (Zero-latency tab block)
    if (cachedSession && cachedSession.session_state === StudyLockStates.LOCKED) {
        if (activeInfo.tabId !== cachedSession.locked_tab_id) {
            chrome.tabs.update(cachedSession.locked_tab_id, { active: true }).catch(() => { });
            if (cachedSession.locked_window_id) {
                chrome.windows.update(cachedSession.locked_window_id, { focused: true }).catch(() => { });
            }
            chrome.tabs.sendMessage(cachedSession.locked_tab_id, {
                action: 'SHOW_WARNING',
                message: '🔒 Focus Session Active — Stay on track!',
            }).catch(() => { });
        }
        return; // Handled synchronously
    }

    // 2. Async Slow-Path (if service worker just woke up)
    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;

    if (activeInfo.tabId !== session.locked_tab_id) {
        try {
            await chrome.tabs.update(session.locked_tab_id, { active: true });
            if (session.locked_window_id) {
                await chrome.windows.update(session.locked_window_id, { focused: true });
            }
        } catch (e) {
            console.warn('Study Lock: Could not re-focus locked tab:', e);
        }

        try {
            await chrome.tabs.sendMessage(session.locked_tab_id, {
                action: 'SHOW_WARNING',
                message: '🔒 Focus Session Active — Stay on track!',
            });
        } catch (e) { /* noop */ }
    }
});

// Prevent creating new tabs
chrome.tabs.onCreated.addListener(async (tab) => {
    // Synchronous Fast-Path
    if (cachedSession && cachedSession.session_state === StudyLockStates.LOCKED) {
        chrome.tabs.remove(tab.id).catch(() => { });
        chrome.tabs.update(cachedSession.locked_tab_id, { active: true }).catch(() => { });
        chrome.tabs.sendMessage(cachedSession.locked_tab_id, {
            action: 'SHOW_WARNING',
            message: '🔒 New tabs are blocked during your session!',
        }).catch(() => { });
        return;
    }

    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;

    try {
        await chrome.tabs.remove(tab.id);
    } catch (e) {
        console.warn('Study Lock: Could not close new tab:', e);
    }

    try {
        await chrome.tabs.update(session.locked_tab_id, { active: true });
        await chrome.tabs.sendMessage(session.locked_tab_id, {
            action: 'SHOW_WARNING',
            message: '🔒 New tabs are blocked during your session!',
        });
    } catch (e) { /* noop */ }
});

// Prevent navigating away from the original YouTube video
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!changeInfo.url) return;

    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;
    if (tabId !== session.locked_tab_id) return;

    // Allow same video URL (with minor param changes like timestamp)
    const currentBase = new URL(changeInfo.url);
    const lockedBase = new URL(session.original_url);

    const currentVideoId = currentBase.searchParams.get('v');
    const lockedVideoId = lockedBase.searchParams.get('v');

    if (currentVideoId !== lockedVideoId || currentBase.hostname !== lockedBase.hostname) {
        try {
            await chrome.tabs.update(tabId, { url: session.original_url });
            await chrome.tabs.sendMessage(session.locked_tab_id, {
                action: 'SHOW_WARNING',
                message: '🔒 Navigation is locked during your session!',
            });
        } catch (e) {
            console.warn('Study Lock: Could not redirect back:', e);
        }
    }
});

// Handle locked tab being closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;
    if (tabId !== session.locked_tab_id) return;

    console.warn('Study Lock: Locked tab was closed — interrupting session.');
    await endSession(StudyLockStates.INTERRUPTED);
});

// ─────────────────────────────────────────────────────────
// Event Listeners — Window Enforcement
// ─────────────────────────────────────────────────────────

// Re-focus Chrome if user Alt+Tabs away
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    // Synchronous Fast-Path
    if (cachedSession && cachedSession.session_state === StudyLockStates.LOCKED) {
        if (windowId === chrome.windows.WINDOW_ID_NONE || windowId !== cachedSession.locked_window_id) {
            chrome.windows.update(cachedSession.locked_window_id, {
                focused: true,
                state: 'fullscreen',
            }).catch(() => { });
        }
        return;
    }

    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;

    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId !== session.locked_window_id) {
        try {
            await chrome.windows.update(session.locked_window_id, {
                focused: true,
                state: 'fullscreen',
            });
        } catch (e) {
            console.warn('Study Lock: Could not reclaim window focus:', e);
        }
    }
});

// ─────────────────────────────────────────────────────────
// Alarm Handler — Session Expiry
// ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    await endSession(StudyLockStates.COMPLETED);
});

// ─────────────────────────────────────────────────────────
// Message Handler — Popup & Content Script Communication
// ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            switch (message.action) {
                case 'START_SESSION': {
                    const { tabId, windowId, duration, url } = message;
                    await startSession({ tabId, windowId, duration, url });
                    sendResponse({ success: true });
                    break;
                }

                case 'GET_SESSION': {
                    const session = await getSession();
                    const remaining = computeRemainingSeconds(session);
                    sendResponse({
                        ...session,
                        timer_remaining_seconds: remaining,
                    });
                    break;
                }

                case 'END_SESSION': {
                    await endSession(message.reason || StudyLockStates.INTERRUPTED);
                    sendResponse({ success: true });
                    break;
                }

                case 'ENFORCE_FULLSCREEN': {
                    const fsSession = await getSession();
                    if (fsSession.session_state === StudyLockStates.LOCKED && fsSession.locked_window_id) {
                        try {
                            await chrome.windows.update(fsSession.locked_window_id, {
                                focused: true,
                                state: 'fullscreen',
                            });
                        } catch (e) {
                            console.warn('Study Lock: Could not enforce fullscreen:', e);
                        }
                    }
                    sendResponse({ success: true });
                    break;
                }

                case 'EXIT_FULLSCREEN': {
                    const exitSession = await getSession();
                    if (exitSession.locked_window_id) {
                        try {
                            await chrome.windows.update(exitSession.locked_window_id, { state: 'normal' });
                        } catch (e) {
                            console.warn('Study Lock: Could not exit fullscreen:', e);
                        }
                    }
                    sendResponse({ success: true });
                    break;
                }

                default:
                    sendResponse({ error: 'Unknown action' });
            }
        } catch (err) {
            console.error('Study Lock background error:', err);
            sendResponse({ error: err.message });
        }
    })();

    // Return true to indicate async sendResponse
    return true;
});

// ─────────────────────────────────────────────────────────
// Service Worker Install
// ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    console.log('Study Lock: Extension installed.');
});
