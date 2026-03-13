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

const BREAK_ALARM_NAME = 'study-lock-break-end';

// ─────────────────────────────────────────────────────────
// In-Memory Cache (For zero-latency synchronous enforcement)
// ─────────────────────────────────────────────────────────
let cachedSession = null;

chrome.storage.local.get(SESSION_STORAGE_KEY).then(data => {
    cachedSession = data[SESSION_STORAGE_KEY] || createIdleSession();
});

chrome.storage.local.onChanged.addListener((changes) => {
    if (changes[SESSION_STORAGE_KEY]) {
        cachedSession = changes[SESSION_STORAGE_KEY].newValue || createIdleSession();
    }
});

// ─────────────────────────────────────────────────────────
// Helper: Get session from storage
// ─────────────────────────────────────────────────────────
async function getSession() {
    if (cachedSession) {
        cachedSession = await normalizeLockedSession(cachedSession);
        return cachedSession;
    }
    const data = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    cachedSession = data[SESSION_STORAGE_KEY] || createIdleSession();
    cachedSession = await normalizeLockedSession(cachedSession);
    return cachedSession;
}

async function setSession(session) {
    cachedSession = session;
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
}

async function normalizeLockedSession(session) {
    if (!session || session.session_state !== StudyLockStates.LOCKED) {
        return session;
    }

    if (
        session.focus_mode === FocusModes.SCHEDULED_BREAK
        && session.scheduled_break_active
        && session.scheduled_break_ends_at
        && Date.now() >= session.scheduled_break_ends_at
    ) {
        const previousThreshold = Number(session.scheduled_next_break_elapsed_seconds) || SCHEDULED_BREAK_INTERVAL_SECONDS;
        const nextThreshold = previousThreshold + SCHEDULED_BREAK_INTERVAL_SECONDS;
        const resumedSession = {
            ...resumeElapsed(session),
            scheduled_break_active: false,
            scheduled_break_ends_at: null,
            scheduled_next_break_elapsed_seconds: nextThreshold < session.timer_duration_seconds
                ? nextThreshold
                : null,
        };
        await setSession(resumedSession);
        await syncAlarmToSession(resumedSession);
        return resumedSession;
    }

    if (
        session.focus_mode === FocusModes.FLEXIBLE_FOCUS
        && session.timer_is_running === false
        && session.flexible_auto_resume_at
        && Date.now() >= session.flexible_auto_resume_at
    ) {
        const resumedSession = {
            ...resumeElapsed(session),
            flexible_pause_started_at: null,
            flexible_auto_resume_at: null,
        };
        await setSession(resumedSession);
        await syncAlarmToSession(resumedSession);
        return resumedSession;
    }

    return session;
}

async function syncAlarmToSession(session) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(BREAK_ALARM_NAME);

    if (!session || session.session_state !== StudyLockStates.LOCKED) return;

    if (
        session.focus_mode === FocusModes.SCHEDULED_BREAK
        && session.scheduled_break_active
        && session.scheduled_break_ends_at
    ) {
        const delayMs = Math.max(0, session.scheduled_break_ends_at - Date.now());
        if (delayMs > 0) {
            chrome.alarms.create(BREAK_ALARM_NAME, {
                delayInMinutes: delayMs / 60000,
            });
        }
        return;
    }

    if (session.timer_is_running === false) return;

    const remaining = computeRemainingSeconds(session);
    if (remaining <= 0) return;

    chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: remaining / 60,
    });
}

function snapshotElapsed(session) {
    return {
        ...session,
        timer_elapsed_seconds: computeElapsedSeconds(session),
        timer_running_since_timestamp: null,
        timer_is_running: false,
    };
}

function resumeElapsed(session) {
    return {
        ...session,
        timer_running_since_timestamp: Date.now(),
        timer_is_running: true,
    };
}

function isScheduledBreakOpen(session) {
    if (!session || session.session_state !== StudyLockStates.LOCKED) return false;
    if (session.focus_mode !== FocusModes.SCHEDULED_BREAK) return false;
    if (!session.scheduled_break_active) return false;
    if (session.timer_is_running) return false;
    if (!session.scheduled_break_ends_at) return false;
    return Date.now() < session.scheduled_break_ends_at;
}

async function ensureContentReady(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'GET_LOCK_STATUS' });
        return;
    } catch (e) {
        // Content script is not available on this tab yet.
    }

    await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['styles.css'],
    });

    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['utils/state-machine.js', 'content.js'],
    });
}

// ─────────────────────────────────────────────────────────
// Session Lifecycle
// ─────────────────────────────────────────────────────────

async function startSession({ tabId, windowId, duration, url, mode }) {
    // Guard against double-start (e.g., race from rapid popup clicks)
    const current = await getSession();
    if (current.session_state === StudyLockStates.LOCKED) return;

    const session = createSessionData({ tabId, windowId, duration, url, mode });
    await setSession(session);
    await syncAlarmToSession(session);

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

    try {
        await ensureContentReady(tabId);
    } catch (e) {
        console.warn('Study Lock: Could not prepare content script:', e);
    }

    // Tell the content script to activate lock UI
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'ACTIVATE_LOCK',
            duration: duration,
            startTimestamp: session.session_start_timestamp,
            mode: session.focus_mode,
            breakSchedule: session.break_schedule,
            flexibleAutoResumeSeconds: FLEXIBLE_AUTO_RESUME_SECONDS,
            timerIsRunning: session.timer_is_running,
            timerElapsedSeconds: computeElapsedSeconds(session),
            flexibleAutoResumeAt: session.flexible_auto_resume_at,
            scheduledBreakActive: session.scheduled_break_active,
            scheduledBreakEndsAt: session.scheduled_break_ends_at,
            scheduledNextBreakElapsedSeconds: session.scheduled_next_break_elapsed_seconds,
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
        if (isScheduledBreakOpen(cachedSession)) return;
        // Skip enforcement if locked tab is gone (e.g., browser restarted, awaiting reconnect)
        if (!cachedSession.locked_tab_id) return;
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
    if (isScheduledBreakOpen(session)) return;
    if (!session.locked_tab_id) return; // Tab not yet reconnected

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
        if (isScheduledBreakOpen(cachedSession)) return;
        if (!cachedSession.locked_tab_id) return; // Tab not yet reconnected
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
    if (isScheduledBreakOpen(session)) return;
    if (!session.locked_tab_id) return; // Tab not yet reconnected

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
    if (isScheduledBreakOpen(session)) return;
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

// Handle locked tab being closed — keep session alive so timer resumes when user returns
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;
    if (tabId !== session.locked_tab_id) return;

    // Clear tab/window IDs but keep session LOCKED — timer keeps counting down
    // Content script will reconnect when user navigates back to YouTube
    console.log('Study Lock: Locked tab closed — session timer continues in background.');
    await setSession({
        ...session,
        locked_tab_id: null,
        locked_window_id: null,
    });
});

// ─────────────────────────────────────────────────────────
// Event Listeners — Window Enforcement
// ─────────────────────────────────────────────────────────

// Re-focus Chrome if user Alt+Tabs away
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    // Synchronous Fast-Path
    if (cachedSession && cachedSession.session_state === StudyLockStates.LOCKED) {
        if (isScheduledBreakOpen(cachedSession)) return;
        if (!cachedSession.locked_window_id) return; // Window not yet reconnected
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
    if (isScheduledBreakOpen(session)) return;
    if (!session.locked_window_id) return; // Window not yet reconnected

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
    if (alarm.name === ALARM_NAME) {
        await endSession(StudyLockStates.COMPLETED);
        return;
    }

    if (alarm.name === BREAK_ALARM_NAME) {
        const session = await getSession();
        if (
            session.session_state === StudyLockStates.LOCKED
            && session.focus_mode === FocusModes.SCHEDULED_BREAK
            && session.scheduled_break_active
        ) {
            const previousThreshold = Number(session.scheduled_next_break_elapsed_seconds) || SCHEDULED_BREAK_INTERVAL_SECONDS;
            const nextThreshold = previousThreshold + SCHEDULED_BREAK_INTERVAL_SECONDS;
            const resumedSession = {
                ...resumeElapsed(session),
                scheduled_break_active: false,
                scheduled_break_ends_at: null,
                scheduled_next_break_elapsed_seconds: nextThreshold < session.timer_duration_seconds
                    ? nextThreshold
                    : null,
            };
            await setSession(resumedSession);
            await syncAlarmToSession(resumedSession);

            if (resumedSession.locked_tab_id) {
                chrome.tabs.update(resumedSession.locked_tab_id, { active: true }).catch(() => { });
            }
            if (resumedSession.locked_window_id) {
                chrome.windows.update(resumedSession.locked_window_id, {
                    focused: true,
                    state: 'fullscreen',
                }).catch(() => { });
            }

            if (resumedSession.locked_tab_id) {
                chrome.tabs.sendMessage(resumedSession.locked_tab_id, {
                    action: 'SHOW_WARNING',
                    message: '⏱ Break ended. Focus timer resumed.',
                }).catch(() => { });
            }
        }
    }
});

// ─────────────────────────────────────────────────────────
// Message Handler — Popup & Content Script Communication
// ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            switch (message.action) {
                case 'START_SESSION': {
                    const { tabId, windowId, duration, url, mode } = message;
                    await startSession({ tabId, windowId, duration, url, mode });
                    sendResponse({ success: true });
                    break;
                }

                case 'GET_SESSION': {
                    const session = await getSession();
                    const remaining = computeRemainingSeconds(session);
                    const elapsed = computeElapsedSeconds(session);
                    sendResponse({
                        ...session,
                        timer_remaining_seconds: remaining,
                        timer_elapsed_seconds_live: elapsed,
                    });
                    break;
                }

                case 'REQUEST_SCHEDULED_BREAK': {
                    const session = await getSession();
                    if (
                        session.session_state !== StudyLockStates.LOCKED
                        || session.focus_mode !== FocusModes.SCHEDULED_BREAK
                    ) {
                        sendResponse({ success: false, started: false });
                        break;
                    }

                    if (session.scheduled_break_active) {
                        sendResponse({
                            success: true,
                            started: false,
                            scheduled_break_active: true,
                            scheduled_break_ends_at: session.scheduled_break_ends_at,
                        });
                        break;
                    }

                    const nextBreakThreshold = Number(session.scheduled_next_break_elapsed_seconds);
                    if (!Number.isFinite(nextBreakThreshold) || nextBreakThreshold <= 0) {
                        sendResponse({ success: true, started: false });
                        break;
                    }

                    if (nextBreakThreshold >= session.timer_duration_seconds) {
                        sendResponse({ success: true, started: false });
                        break;
                    }

                    const elapsed = computeElapsedSeconds(session);
                    if (elapsed < nextBreakThreshold) {
                        sendResponse({
                            success: true,
                            started: false,
                            elapsed,
                            next_break_elapsed_seconds: nextBreakThreshold,
                        });
                        break;
                    }

                    const breakSession = {
                        ...snapshotElapsed(session),
                        scheduled_break_active: true,
                        scheduled_break_ends_at: Date.now() + (SCHEDULED_BREAK_DURATION_SECONDS * 1000),
                    };

                    await setSession(breakSession);
                    await syncAlarmToSession(breakSession);

                    sendResponse({
                        success: true,
                        started: true,
                        scheduled_break_active: true,
                        scheduled_break_ends_at: breakSession.scheduled_break_ends_at,
                        timer_remaining_seconds: computeRemainingSeconds(breakSession),
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

                case 'RECONNECT_SESSION': {
                    // Content script on YouTube is claiming this tab as the locked session tab
                    const reconSession = await getSession();
                    if (reconSession.session_state === StudyLockStates.LOCKED) {
                        const tabId = sender.tab?.id;
                        const windowId = sender.tab?.windowId;
                        if (tabId && windowId) {
                            try {
                                await ensureContentReady(tabId);
                            } catch (e) {
                                console.warn('Study Lock: Could not prepare reconnected tab:', e);
                            }

                            await setSession({
                                ...reconSession,
                                locked_tab_id: tabId,
                                locked_window_id: windowId,
                            });
                            // Re-create the alarm if it was lost (e.g., browser restart)
                            await syncAlarmToSession({
                                ...reconSession,
                                locked_tab_id: tabId,
                                locked_window_id: windowId,
                            });
                            // Fullscreen the reconnected window
                            try {
                                await chrome.windows.update(windowId, { focused: true, state: 'fullscreen' });
                            } catch (e) { /* noop */ }

                            chrome.tabs.sendMessage(tabId, {
                                action: 'ACTIVATE_LOCK',
                                duration: reconSession.timer_duration_seconds,
                                startTimestamp: reconSession.session_start_timestamp,
                                mode: reconSession.focus_mode,
                                breakSchedule: reconSession.break_schedule,
                                flexibleAutoResumeSeconds: FLEXIBLE_AUTO_RESUME_SECONDS,
                                timerIsRunning: reconSession.timer_is_running,
                                timerElapsedSeconds: computeElapsedSeconds(reconSession),
                                flexibleAutoResumeAt: reconSession.flexible_auto_resume_at,
                                scheduledBreakActive: reconSession.scheduled_break_active,
                                scheduledBreakEndsAt: reconSession.scheduled_break_ends_at,
                                scheduledNextBreakElapsedSeconds: reconSession.scheduled_next_break_elapsed_seconds,
                            }).catch(() => { });

                            console.log(`Study Lock: Session reconnected to tab ${tabId} (window ${windowId})`);
                        }
                    }
                    sendResponse({ success: true });
                    break;
                }

                case 'SET_FLEXIBLE_PAUSE_STATE': {
                    const pauseSession = await getSession();
                    if (
                        pauseSession.session_state !== StudyLockStates.LOCKED
                        || pauseSession.focus_mode !== FocusModes.FLEXIBLE_FOCUS
                    ) {
                        sendResponse({ success: false });
                        break;
                    }

                    const now = Date.now();
                    const shouldPause = Boolean(message.paused);
                    let nextSession = pauseSession;

                    if (shouldPause && pauseSession.timer_is_running) {
                        nextSession = {
                            ...snapshotElapsed(pauseSession),
                            flexible_pause_started_at: now,
                            flexible_auto_resume_at: now + (FLEXIBLE_AUTO_RESUME_SECONDS * 1000),
                        };
                    }

                    if (!shouldPause && !pauseSession.timer_is_running) {
                        nextSession = {
                            ...resumeElapsed(pauseSession),
                            flexible_pause_started_at: null,
                            flexible_auto_resume_at: null,
                        };
                    }

                    await setSession(nextSession);
                    await syncAlarmToSession(nextSession);

                    sendResponse({
                        success: true,
                        timer_remaining_seconds: computeRemainingSeconds(nextSession),
                        timer_is_running: nextSession.timer_is_running,
                        flexible_auto_resume_at: nextSession.flexible_auto_resume_at,
                    });
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
// Service Worker Install & Startup Recovery
// ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    console.log('Study Lock: Extension installed.');
});

// On browser restart, check if a persisted session has already expired
chrome.runtime.onStartup.addListener(async () => {
    const session = await getSession();
    if (session.session_state !== StudyLockStates.LOCKED) return;

    const remaining = computeRemainingSeconds(session);
    if (remaining <= 0) {
        // Timer expired while the browser was closed
        console.log('Study Lock: Session expired during browser closure — completing.');
        await setSession(createIdleSession());
        chrome.alarms.clear(ALARM_NAME);
    } else {
        // Session still active — re-create alarm if timer is running
        await syncAlarmToSession(session);
        console.log(`Study Lock: Resumed persisted session — ${Math.round(remaining)}s remaining.`);
    }
});
