/**
 * Study Lock — State Machine
 * States: IDLE → SETUP → LOCKED → COMPLETED | INTERRUPTED
 * 
 * Shared between background.js (via importScripts) and content.js (via content_scripts injection).
 */

const StudyLockStates = Object.freeze({
    IDLE: 'IDLE',
    SETUP: 'SETUP',
    LOCKED: 'LOCKED',
    COMPLETED: 'COMPLETED',
    INTERRUPTED: 'INTERRUPTED',
});

const VALID_TRANSITIONS = Object.freeze({
    [StudyLockStates.IDLE]: [StudyLockStates.SETUP],
    [StudyLockStates.SETUP]: [StudyLockStates.LOCKED, StudyLockStates.IDLE],
    [StudyLockStates.LOCKED]: [StudyLockStates.COMPLETED, StudyLockStates.INTERRUPTED],
    [StudyLockStates.COMPLETED]: [StudyLockStates.IDLE],
    [StudyLockStates.INTERRUPTED]: [StudyLockStates.IDLE],
});

const SESSION_STORAGE_KEY = 'study_lock_session';

const TIMER_CONSTRAINTS = Object.freeze({
    MIN_MINUTES: 5,
    MAX_MINUTES: 120,
});

const ALARM_NAME = 'study-lock-timer';

/**
 * Validates whether a state transition is allowed.
 * @param {string} from - Current state
 * @param {string} to - Target state
 * @returns {boolean}
 */
function isValidTransition(from, to) {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Creates a fresh session object for storage.
 * @param {object} params
 * @returns {object}
 */
function createSessionData({ tabId, windowId, duration, url }) {
    return {
        session_state: StudyLockStates.LOCKED,
        locked_tab_id: tabId,
        locked_window_id: windowId,
        timer_duration_seconds: duration,
        session_start_timestamp: Date.now(),
        original_url: url,
    };
}

/**
 * Computes remaining seconds from a session object.
 * @param {object} session
 * @returns {number} remaining seconds (clamped to 0)
 */
function computeRemainingSeconds(session) {
    if (!session || !session.session_start_timestamp) return 0;
    const elapsed = (Date.now() - session.session_start_timestamp) / 1000;
    return Math.max(0, session.timer_duration_seconds - elapsed);
}

/**
 * Returns an IDLE state session object.
 * @returns {object}
 */
function createIdleSession() {
    return {
        session_state: StudyLockStates.IDLE,
        locked_tab_id: null,
        locked_window_id: null,
        timer_duration_seconds: 0,
        session_start_timestamp: null,
        original_url: null,
    };
}

// Export for service worker (importScripts) context — no ES modules in MV3 service workers
// In content script context, these are just global variables since content_scripts injection makes them available.
if (typeof self !== 'undefined' && typeof self.StudyLockStates === 'undefined') {
    self.StudyLockStates = StudyLockStates;
    self.VALID_TRANSITIONS = VALID_TRANSITIONS;
    self.SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
    self.TIMER_CONSTRAINTS = TIMER_CONSTRAINTS;
    self.ALARM_NAME = ALARM_NAME;
    self.isValidTransition = isValidTransition;
    self.createSessionData = createSessionData;
    self.computeRemainingSeconds = computeRemainingSeconds;
    self.createIdleSession = createIdleSession;
}
