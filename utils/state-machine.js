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

const FocusModes = Object.freeze({
    UNINTERRUPTED_FLOW: 'UNINTERRUPTED_FLOW',
    FLEXIBLE_FOCUS: 'FLEXIBLE_FOCUS',
    SCHEDULED_BREAK: 'SCHEDULED_BREAK',
});

const FLEXIBLE_AUTO_RESUME_SECONDS = 2 * 60;
const SCHEDULED_BREAK_DURATION_SECONDS = 5 * 60;
const SCHEDULED_BREAK_INTERVAL_SECONDS = 15 * 60;

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
function createSessionData({ tabId, windowId, duration, url, mode }) {
    const now = Date.now();
    const selectedMode = Object.values(FocusModes).includes(mode)
        ? mode
        : FocusModes.UNINTERRUPTED_FLOW;

    return {
        session_state: StudyLockStates.LOCKED,
        locked_tab_id: tabId,
        locked_window_id: windowId,
        timer_duration_seconds: duration,
        session_start_timestamp: now,
        timer_running_since_timestamp: now,
        timer_elapsed_seconds: 0,
        timer_is_running: true,
        flexible_pause_started_at: null,
        flexible_auto_resume_at: null,
        focus_mode: selectedMode,
        break_schedule: [],
        scheduled_break_active: false,
        scheduled_break_ends_at: null,
        scheduled_next_break_elapsed_seconds: selectedMode === FocusModes.SCHEDULED_BREAK
            ? SCHEDULED_BREAK_INTERVAL_SECONDS
            : null,
        original_url: url,
    };
}

/**
 * Computes elapsed timer seconds based on running/paused state.
 * @param {object} session
 * @returns {number}
 */
function computeElapsedSeconds(session) {
    if (!session) return 0;
    const baseElapsed = Number(session.timer_elapsed_seconds) || 0;

    if (!session.timer_is_running || !session.timer_running_since_timestamp) {
        return Math.max(0, baseElapsed);
    }

    const liveElapsed = (Date.now() - session.timer_running_since_timestamp) / 1000;
    return Math.max(0, baseElapsed + liveElapsed);
}

/**
 * Computes remaining seconds from a session object.
 * @param {object} session
 * @returns {number} remaining seconds (clamped to 0)
 */
function computeRemainingSeconds(session) {
    if (!session || !session.timer_duration_seconds) return 0;
    const elapsed = computeElapsedSeconds(session);
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
        timer_running_since_timestamp: null,
        timer_elapsed_seconds: 0,
        timer_is_running: false,
        flexible_pause_started_at: null,
        flexible_auto_resume_at: null,
        focus_mode: FocusModes.UNINTERRUPTED_FLOW,
        break_schedule: [],
        scheduled_break_active: false,
        scheduled_break_ends_at: null,
        scheduled_next_break_elapsed_seconds: null,
        original_url: null,
    };
}

// Export for service worker (importScripts) context — no ES modules in MV3 service workers
// In content script context, these are just global variables since content_scripts injection makes them available.
if (typeof self !== 'undefined' && typeof self.StudyLockStates === 'undefined') {
    self.StudyLockStates = StudyLockStates;
    self.FocusModes = FocusModes;
    self.FLEXIBLE_AUTO_RESUME_SECONDS = FLEXIBLE_AUTO_RESUME_SECONDS;
    self.SCHEDULED_BREAK_DURATION_SECONDS = SCHEDULED_BREAK_DURATION_SECONDS;
    self.SCHEDULED_BREAK_INTERVAL_SECONDS = SCHEDULED_BREAK_INTERVAL_SECONDS;
    self.VALID_TRANSITIONS = VALID_TRANSITIONS;
    self.SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
    self.TIMER_CONSTRAINTS = TIMER_CONSTRAINTS;
    self.ALARM_NAME = ALARM_NAME;
    self.isValidTransition = isValidTransition;
    self.createSessionData = createSessionData;
    self.computeElapsedSeconds = computeElapsedSeconds;
    self.computeRemainingSeconds = computeRemainingSeconds;
    self.createIdleSession = createIdleSession;
}
