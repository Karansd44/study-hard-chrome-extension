/**
 * Study Lock — Content Script
 * 
 * Injected into YouTube pages.
 * Responsibilities:
 * - Render timer overlay, warning flash, and success screen
 * - Enforce fullscreen via Fullscreen API
 * - Block keyboard shortcuts at DOM level
 * - Communicate with background service worker
 */

(() => {
    'use strict';

    // ─────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────

    const OVERLAY_ID = 'study-lock-timer-overlay';
    const WARNING_ID = 'study-lock-warning-overlay';
    const SUCCESS_ID = 'study-lock-success-overlay';
    const CONTAINER_ID = 'study-lock-container';

    const MOTIVATIONAL_QUOTES = [
        { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
        { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
        { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
        { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
        { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
        { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
        { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
        { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
        { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
        { text: "The harder you work for something, the greater you'll feel when you achieve it.", author: "Anonymous" },
        { text: "Small daily improvements over time lead to stunning results.", author: "Robin Sharma" },
        { text: "Your future is created by what you do today, not tomorrow.", author: "Robert Kiyosaki" },
    ];

    // ─────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────

    let isLocked = false;
    let timerInterval = null;
    let sessionStartTimestamp = null;
    let sessionDuration = null;

    let currentMode = FocusModes.UNINTERRUPTED_FLOW;
    let breakSchedule = [];
    let flexibleAutoResumeSeconds = FLEXIBLE_AUTO_RESUME_SECONDS;
    let flexibleAutoResumeAt = null;
    let scheduledBreakActive = false;
    let scheduledBreakEndsAt = null;
    let scheduledNextBreakElapsedSeconds = null;
    let scheduledBreakLastCheckAt = 0;

    let timerElapsedAtSync = 0;
    let timerSyncedAt = 0;
    let timerIsRunning = true;

    let suppressPauseHandler = false;
    let pauseGraceTimeout = null;

    let playerPauseButton = null;
    let videoPauseHandler = null;
    let videoPlayHandler = null;
    let playButtonClickHandler = null;

    // ─────────────────────────────────────────────────────────
    // DOM Helpers
    // ─────────────────────────────────────────────────────────

    function getOrCreateContainer() {
        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            document.body.appendChild(container);
        }
        return container;
    }

    function removeElement(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    function formatTime(totalSeconds) {
        const mins = Math.floor(totalSeconds / 60);
        const secs = Math.floor(totalSeconds % 60);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function getModeLabel(mode) {
        switch (mode) {
            case FocusModes.FLEXIBLE_FOCUS:
                return 'Flexible Focus';
            case FocusModes.SCHEDULED_BREAK:
                return 'Scheduled Break';
            default:
                return 'Uninterrupted';
        }
    }

    function getElapsedSeconds() {
        if (!timerIsRunning) return Math.max(0, timerElapsedAtSync);
        return Math.max(0, timerElapsedAtSync + ((Date.now() - timerSyncedAt) / 1000));
    }

    function getRemainingSeconds() {
        return Math.max(0, (sessionDuration || 0) - getElapsedSeconds());
    }

    function shouldAllowPause() {
        if (!isLocked) return true;
        if (currentMode === FocusModes.FLEXIBLE_FOCUS) return true;
        if (currentMode === FocusModes.SCHEDULED_BREAK) return scheduledBreakActive;
        return false;
    }

    function clearPauseGraceTimer() {
        if (pauseGraceTimeout) {
            clearTimeout(pauseGraceTimeout);
            pauseGraceTimeout = null;
        }
    }

    function updatePauseAffordances() {
        if (!playerPauseButton) return;

        const pauseAllowed = shouldAllowPause();
        playerPauseButton.classList.toggle('study-lock-control-disabled', !pauseAllowed);
        playerPauseButton.setAttribute('aria-disabled', String(!pauseAllowed));
        playerPauseButton.title = pauseAllowed
            ? ''
            : currentMode === FocusModes.SCHEDULED_BREAK
                ? 'Pause available during scheduled breaks only.'
                : 'Pause unavailable in this focus mode.';
    }

    // ─────────────────────────────────────────────────────────
    // Timer Overlay
    // ─────────────────────────────────────────────────────────

    // Track document-level drag listeners so we can remove them on cleanup
    let dragMoveHandler = null;
    let dragUpHandler = null;

    function createTimerOverlay(duration, startTimestamp) {
        removeElement(OVERLAY_ID);
        // Remove any stale drag listeners from a previous overlay
        if (dragMoveHandler) document.removeEventListener('mousemove', dragMoveHandler);
        if (dragUpHandler) document.removeEventListener('mouseup', dragUpHandler);

        const container = getOrCreateContainer();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'study-lock-timer';

        const lockIcon = document.createElement('span');
        lockIcon.className = 'study-lock-timer-icon';
        lockIcon.textContent = '🔒';

        const timeDisplay = document.createElement('span');
        timeDisplay.className = 'study-lock-timer-time';
        timeDisplay.textContent = formatTime(duration);

        const modeDisplay = document.createElement('span');
        modeDisplay.className = 'study-lock-timer-mode';
        modeDisplay.textContent = getModeLabel(currentMode);

        const auxDisplay = document.createElement('span');
        auxDisplay.className = 'study-lock-timer-aux';
        auxDisplay.id = 'study-lock-timer-aux';

        const progressBar = document.createElement('div');
        progressBar.className = 'study-lock-timer-progress';
        const progressFill = document.createElement('div');
        progressFill.className = 'study-lock-timer-progress-fill';
        progressBar.appendChild(progressFill);

        overlay.appendChild(lockIcon);
        overlay.appendChild(timeDisplay);
        overlay.appendChild(modeDisplay);
        overlay.appendChild(auxDisplay);
        overlay.appendChild(progressBar);
        container.appendChild(overlay);

        // Make draggable
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        overlay.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            // Get computed style to handle initial 'bottom/left' vs 'top/left'
            const rect = overlay.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            // Switch to top/left positioning for easier dragging math
            overlay.style.bottom = 'auto';
            overlay.style.right = 'auto';
            overlay.style.left = `${initialLeft}px`;
            overlay.style.top = `${initialTop}px`;
            overlay.style.cursor = 'grabbing';

            e.preventDefault(); // Prevent text selection while dragging
        });

        dragMoveHandler = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            overlay.style.left = `${initialLeft + dx}px`;
            overlay.style.top = `${initialTop + dy}px`;
        };

        dragUpHandler = () => {
            if (isDragging) {
                isDragging = false;
                overlay.style.cursor = 'grab';
            }
        };

        document.addEventListener('mousemove', dragMoveHandler);
        document.addEventListener('mouseup', dragUpHandler);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('study-lock-timer--visible');
        });

        return { timeDisplay, progressFill };
    }

    function startTimerOverlay(duration, startTimestamp, options = {}) {
        sessionDuration = duration;
        sessionStartTimestamp = startTimestamp;
        timerElapsedAtSync = Number(options.timerElapsedSeconds) || 0;
        timerSyncedAt = Date.now();
        timerIsRunning = options.timerIsRunning !== false;
        flexibleAutoResumeAt = options.flexibleAutoResumeAt || null;

        const { timeDisplay, progressFill } = createTimerOverlay(duration, startTimestamp);

        // Clear any existing interval
        if (timerInterval) clearInterval(timerInterval);

        timerInterval = setInterval(() => {
            const remaining = getRemainingSeconds();
            const elapsed = Math.max(0, sessionDuration - remaining);
            const progress = (elapsed / sessionDuration) * 100;

            timeDisplay.textContent = formatTime(remaining);
            progressFill.style.width = `${progress}%`;

            const aux = document.getElementById('study-lock-timer-aux');
            if (aux) {
                if (currentMode === FocusModes.FLEXIBLE_FOCUS && !timerIsRunning) {
                    const msLeft = Math.max(0, (Number(flexibleAutoResumeAt) || 0) - Date.now());
                    aux.textContent = `Auto-resume in ${formatTime(msLeft / 1000)}`;
                } else if (currentMode === FocusModes.SCHEDULED_BREAK) {
                    if (scheduledBreakActive && scheduledBreakEndsAt) {
                        const breakLeft = Math.max(0, (scheduledBreakEndsAt - Date.now()) / 1000);
                        aux.textContent = `Break time ${formatTime(breakLeft)} left`;
                    } else if (Number.isFinite(Number(scheduledNextBreakElapsedSeconds))) {
                        const untilBreak = Math.max(0, Number(scheduledNextBreakElapsedSeconds) - getElapsedSeconds());
                        aux.textContent = `Next break in ${formatTime(untilBreak)}`;
                    } else {
                        aux.textContent = 'Pause locked until session end';
                    }
                } else {
                    aux.textContent = '';
                }
            }

            // Add urgency class in last 60 seconds
            const overlay = document.getElementById(OVERLAY_ID);
            if (overlay) {
                if (remaining <= 60) {
                    overlay.classList.add('study-lock-timer--urgent');
                }
                if (remaining <= 10) {
                    overlay.classList.add('study-lock-timer--final');
                }
            }

            if (remaining <= 0) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        }, 250);
    }

    function stopTimerOverlay() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        removeElement(OVERLAY_ID);
        // Clean up document-level drag listeners to prevent memory leaks
        if (dragMoveHandler) {
            document.removeEventListener('mousemove', dragMoveHandler);
            dragMoveHandler = null;
        }
        if (dragUpHandler) {
            document.removeEventListener('mouseup', dragUpHandler);
            dragUpHandler = null;
        }
    }

    // ─────────────────────────────────────────────────────────
    // Warning Flash Overlay
    // ─────────────────────────────────────────────────────────

    let warningTimeout = null;

    function showWarning(message) {
        removeElement(WARNING_ID);
        if (warningTimeout) clearTimeout(warningTimeout);

        const container = getOrCreateContainer();

        const warning = document.createElement('div');
        warning.id = WARNING_ID;
        warning.className = 'study-lock-warning';

        const icon = document.createElement('div');
        icon.className = 'study-lock-warning-icon';
        icon.textContent = '⚠️';

        const text = document.createElement('div');
        text.className = 'study-lock-warning-text';
        text.textContent = message;

        warning.appendChild(icon);
        warning.appendChild(text);
        container.appendChild(warning);

        // Fade in
        requestAnimationFrame(() => {
            warning.classList.add('study-lock-warning--visible');
        });

        // Auto-dismiss after 1.5s
        warningTimeout = setTimeout(() => {
            warning.classList.remove('study-lock-warning--visible');
            warning.classList.add('study-lock-warning--hiding');
            setTimeout(() => removeElement(WARNING_ID), 300);
        }, 1500);
    }


    // ─────────────────────────────────────────────────────────
    // Fullscreen Enforcement (via background service worker)
    // The DOM Fullscreen API requires a user gesture, which content
    // scripts don't have when receiving messages. Instead, we delegate
    // to background.js which uses chrome.windows.update({ state: 'fullscreen' })
    // — this API works without a user gesture.
    // ─────────────────────────────────────────────────────────

    function requestFullscreenViaBackground() {
        chrome.runtime.sendMessage({ action: 'ENFORCE_FULLSCREEN' }).catch(() => { });
    }

    // ─────────────────────────────────────────────────────────
    // Keyboard Shortcut Blocking
    // ─────────────────────────────────────────────────────────

    function blockKeyboard(e) {
        if (!isLocked) return;

        // Block Escape
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }

        // Block F11
        if (e.key === 'F11') {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Block pause shortcuts when pause is disallowed for the current mode
        const lowerKey = String(e.key || '').toLowerCase();
        const pauseShortcutPressed = lowerKey === ' ' || lowerKey === 'spacebar' || lowerKey === 'k';
        if (pauseShortcutPressed && !shouldAllowPause()) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            showWarning('🔒 Pause is not available right now.');
            return false;
        }

        // During scheduled breaks users can switch tabs/windows.
        if (currentMode === FocusModes.SCHEDULED_BREAK && scheduledBreakActive) {
            return;
        }

        // Block Ctrl/Cmd/Alt-based shortcuts
        if (e.ctrlKey || e.metaKey || e.altKey) {
            const blockedKeys = [
                't', 'n', 'w', 'l', 'tab', 'pagedown', 'pageup',
                '1', '2', '3', '4', '5', '6', '7', '8', '9',
                'arrowleft', 'arrowright'
            ];
            if (blockedKeys.includes(e.key.toLowerCase())) {
                e.preventDefault();
                e.stopPropagation();
                showWarning('🔒 Tab switching and keyboard shortcuts are disabled!');
                return false;
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // Success Toast Notification
    // ─────────────────────────────────────────────────────────

    const TOAST_ID = 'study-lock-toast';
    let toastTimeout = null;

    function showCompletionToast(totalSeconds) {
        removeElement(TOAST_ID);
        if (toastTimeout) clearTimeout(toastTimeout);

        const container = getOrCreateContainer();
        const minutes = Math.round(totalSeconds / 60);

        const toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.className = 'study-lock-toast';

        const toastIcon = document.createElement('div');
        toastIcon.className = 'study-lock-toast-icon';
        toastIcon.textContent = '✨';

        const toastText = document.createElement('div');
        toastText.className = 'study-lock-toast-text';

        const toastTitle = document.createElement('p');
        toastTitle.className = 'study-lock-toast-title';
        toastTitle.textContent = 'Session Complete';

        const toastSubtitle = document.createElement('p');
        toastSubtitle.className = 'study-lock-toast-subtitle';
        toastSubtitle.textContent = `${minutes} minute${minutes !== 1 ? 's' : ''} of focus. Great job!`;

        toastText.appendChild(toastTitle);
        toastText.appendChild(toastSubtitle);
        toast.appendChild(toastIcon);
        toast.appendChild(toastText);

        container.appendChild(toast);

        // Fade in
        requestAnimationFrame(() => {
            toast.classList.add('study-lock-toast--visible');
        });

        // Auto-dismiss after 5s
        toastTimeout = setTimeout(() => {
            toast.classList.remove('study-lock-toast--visible');
            setTimeout(() => removeElement(TOAST_ID), 400);
        }, 5000);
    }

    // ─────────────────────────────────────────────────────────
    // Anti-Pause & Visibility Enforcement
    // ─────────────────────────────────────────────────────────

    let playbackInterval = null;

    async function syncFlexiblePauseState(paused) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'SET_FLEXIBLE_PAUSE_STATE',
                paused,
            });
            if (!response || !response.success) return;
            timerIsRunning = Boolean(response.timer_is_running);
            timerElapsedAtSync = (sessionDuration || 0) - Number(response.timer_remaining_seconds || 0);
            timerSyncedAt = Date.now();
            flexibleAutoResumeAt = response.flexible_auto_resume_at || null;
        } catch (e) {
            // Ignore sync failures; local enforcement still runs.
        }
    }

    async function maybeStartScheduledBreak() {
        if (!isLocked || currentMode !== FocusModes.SCHEDULED_BREAK) return;
        if (scheduledBreakActive || !timerIsRunning) return;
        if (!Number.isFinite(Number(scheduledNextBreakElapsedSeconds))) return;
        if (Date.now() - scheduledBreakLastCheckAt < 1000) return;

        const elapsed = getElapsedSeconds();
        if (elapsed < Number(scheduledNextBreakElapsedSeconds)) return;

        scheduledBreakLastCheckAt = Date.now();
        try {
            const response = await chrome.runtime.sendMessage({ action: 'REQUEST_SCHEDULED_BREAK' });
            if (!response || !response.success) return;
            if (!response.started) return;

            timerElapsedAtSync = getElapsedSeconds();
            timerIsRunning = false;
            timerSyncedAt = Date.now();
            scheduledBreakActive = true;
            scheduledBreakEndsAt = response.scheduled_break_ends_at || null;

            showWarning('☕ Break started. Pause and tab switching are allowed for 5 minutes.');
        } catch (e) {
            // Ignore transient messaging issues.
        }
    }

    function forceVideoPlay(video) {
        if (!video) return;
        suppressPauseHandler = true;
        video.play().catch(() => { }).finally(() => {
            setTimeout(() => {
                suppressPauseHandler = false;
            }, 0);
        });
    }

    function scheduleFlexibleAutoResume(video, autoResumeAt = null) {
        clearPauseGraceTimer();
        flexibleAutoResumeAt = autoResumeAt || (Date.now() + (flexibleAutoResumeSeconds * 1000));
        const delayMs = Math.max(0, flexibleAutoResumeAt - Date.now());

        pauseGraceTimeout = setTimeout(() => {
            if (!isLocked || currentMode !== FocusModes.FLEXIBLE_FOCUS) return;
            if (!video.paused) return;

            forceVideoPlay(video);
            timerIsRunning = true;
            timerSyncedAt = Date.now();
            flexibleAutoResumeAt = null;
            syncFlexiblePauseState(false);
            updatePauseAffordances();
            showWarning('⏱ Pause limit reached. Session resumed.');
        }, delayMs);
    }

    function enforcePlayback() {
        if (!isLocked) return;
        const video = document.querySelector('video');
        if (!video) return;

        updatePauseAffordances();

        if (currentMode === FocusModes.UNINTERRUPTED_FLOW && video.paused) {
            forceVideoPlay(video);
            showWarning('🔒 Pause is unavailable in Uninterrupted Flow.');
            return;
        }

        if (currentMode === FocusModes.FLEXIBLE_FOCUS && timerIsRunning && video.paused) {
            forceVideoPlay(video);
            showWarning('⏱ Focus timer resumed playback.');
            return;
        }

        if (currentMode === FocusModes.SCHEDULED_BREAK && !scheduledBreakActive && timerIsRunning) {
            maybeStartScheduledBreak();
        }

        if (currentMode === FocusModes.SCHEDULED_BREAK && scheduledBreakActive && scheduledBreakEndsAt && Date.now() >= scheduledBreakEndsAt) {
            scheduledBreakActive = false;
            scheduledBreakEndsAt = null;
            if (Number.isFinite(Number(scheduledNextBreakElapsedSeconds))) {
                const nextBreak = Number(scheduledNextBreakElapsedSeconds) + SCHEDULED_BREAK_INTERVAL_SECONDS;
                scheduledNextBreakElapsedSeconds = nextBreak < sessionDuration ? nextBreak : null;
            }
            timerIsRunning = true;
            timerSyncedAt = Date.now();
            showWarning('⏱ Break ended. Focus timer resumed.');
        }

        if (currentMode === FocusModes.SCHEDULED_BREAK && video.paused && !scheduledBreakActive) {
            forceVideoPlay(video);
            showWarning('🔒 Pause allowed only during scheduled breaks.');
            return;
        }
    }

    function handleVisibilityChange() {
        if (!isLocked) return;
        if (currentMode === FocusModes.SCHEDULED_BREAK && scheduledBreakActive) {
            document.body.classList.remove('study-lock-hidden-blur');
            return;
        }
        if (document.hidden) {
            document.body.classList.add('study-lock-hidden-blur');
            // Aggressively tell the background script to pull focus back to this tab
            chrome.runtime.sendMessage({ action: 'ENFORCE_FULLSCREEN' }).catch(() => { });
        } else {
            document.body.classList.remove('study-lock-hidden-blur');
        }
    }

    function handleVideoPaused() {
        if (!isLocked || suppressPauseHandler) return;
        const video = document.querySelector('video');
        if (!video) return;

        if (!shouldAllowPause()) {
            forceVideoPlay(video);
            showWarning(
                currentMode === FocusModes.SCHEDULED_BREAK
                    ? '🔒 Pause allowed only during scheduled breaks.'
                    : '🔒 Pause is disabled until timer ends.'
            );
            return;
        }

        if (currentMode === FocusModes.FLEXIBLE_FOCUS) {
            timerElapsedAtSync = getElapsedSeconds();
            timerIsRunning = false;
            timerSyncedAt = Date.now();
            scheduleFlexibleAutoResume(video);
            syncFlexiblePauseState(true);
            updatePauseAffordances();
        }
    }

    function handleVideoPlayed() {
        if (!isLocked) return;

        if (currentMode === FocusModes.FLEXIBLE_FOCUS) {
            clearPauseGraceTimer();
            flexibleAutoResumeAt = null;
            timerElapsedAtSync = getElapsedSeconds();
            timerIsRunning = true;
            timerSyncedAt = Date.now();
            syncFlexiblePauseState(false);
            updatePauseAffordances();
        }
    }

    function attachVideoGuards() {
        const video = document.querySelector('video');
        if (!video) return;

        videoPauseHandler = () => handleVideoPaused();
        videoPlayHandler = () => handleVideoPlayed();
        video.addEventListener('pause', videoPauseHandler, true);
        video.addEventListener('play', videoPlayHandler, true);

        playerPauseButton = document.querySelector('.ytp-play-button');
        updatePauseAffordances();

        playButtonClickHandler = (event) => {
            if (!isLocked || shouldAllowPause()) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('.ytp-play-button')) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            showWarning('🔒 Pause is disabled in this mode.');
        };
        document.addEventListener('click', playButtonClickHandler, true);

        if (currentMode === FocusModes.FLEXIBLE_FOCUS && !timerIsRunning && video.paused) {
            scheduleFlexibleAutoResume(video, flexibleAutoResumeAt);
        }
    }

    function detachVideoGuards() {
        const video = document.querySelector('video');
        if (video && videoPauseHandler) {
            video.removeEventListener('pause', videoPauseHandler, true);
        }
        if (video && videoPlayHandler) {
            video.removeEventListener('play', videoPlayHandler, true);
        }
        videoPauseHandler = null;
        videoPlayHandler = null;

        if (playButtonClickHandler) {
            document.removeEventListener('click', playButtonClickHandler, true);
            playButtonClickHandler = null;
        }

        if (playerPauseButton) {
            playerPauseButton.classList.remove('study-lock-control-disabled');
            playerPauseButton.removeAttribute('aria-disabled');
            playerPauseButton.removeAttribute('title');
            playerPauseButton = null;
        }
    }

    // ─────────────────────────────────────────────────────────
    // Session Lifecycle
    // ─────────────────────────────────────────────────────────

    function activateLock(duration, startTimestamp, options = {}) {
        isLocked = true;
        currentMode = options.mode || FocusModes.UNINTERRUPTED_FLOW;
        breakSchedule = Array.isArray(options.breakSchedule) ? options.breakSchedule : [];
        flexibleAutoResumeSeconds = Number(options.flexibleAutoResumeSeconds) || FLEXIBLE_AUTO_RESUME_SECONDS;
        scheduledBreakActive = Boolean(options.scheduledBreakActive);
        scheduledBreakEndsAt = options.scheduledBreakEndsAt || null;
        scheduledNextBreakElapsedSeconds = Number.isFinite(Number(options.scheduledNextBreakElapsedSeconds))
            ? Number(options.scheduledNextBreakElapsedSeconds)
            : null;

        // Start timer overlay
        startTimerOverlay(duration, startTimestamp, options);

        // Attach keyboard blocker
        document.addEventListener('keydown', blockKeyboard, true);

        // Attach visibility listener
        document.addEventListener('visibilitychange', handleVisibilityChange);

        attachVideoGuards();
        updatePauseAffordances();

        // Start playback enforcer interval (runs every 0.5 second)
        playbackInterval = setInterval(enforcePlayback, 500);

        // Request fullscreen via background (window-level, no user gesture needed)
        requestFullscreenViaBackground();

        // Hide distracting YouTube elements
        document.body.classList.add('study-lock-active');
    }

    function cleanup() {
        isLocked = false;
        scheduledBreakActive = false;
        scheduledBreakEndsAt = null;
        scheduledNextBreakElapsedSeconds = null;
        scheduledBreakLastCheckAt = 0;

        clearPauseGraceTimer();
        stopTimerOverlay();
        removeElement(WARNING_ID);

        if (playbackInterval) {
            clearInterval(playbackInterval);
            playbackInterval = null;
        }

        detachVideoGuards();

        document.removeEventListener('keydown', blockKeyboard, true);
        document.removeEventListener('visibilitychange', handleVisibilityChange);

        document.body.classList.remove('study-lock-active');
        document.body.classList.remove('study-lock-hidden-blur');

        // Trigger a window resize so YouTube recalculates its video player dimensions back to normal
        window.dispatchEvent(new Event('resize'));
    }

    // ─────────────────────────────────────────────────────────
    // Message Listener from Background
    // ─────────────────────────────────────────────────────────

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.action) {
            case 'ACTIVATE_LOCK':
                activateLock(message.duration, message.startTimestamp, {
                    mode: message.mode,
                    breakSchedule: message.breakSchedule,
                    flexibleAutoResumeSeconds: message.flexibleAutoResumeSeconds,
                    timerIsRunning: message.timerIsRunning,
                    timerElapsedSeconds: message.timerElapsedSeconds,
                    flexibleAutoResumeAt: message.flexibleAutoResumeAt,
                    scheduledBreakActive: message.scheduledBreakActive,
                    scheduledBreakEndsAt: message.scheduledBreakEndsAt,
                    scheduledNextBreakElapsedSeconds: message.scheduledNextBreakElapsedSeconds,
                });
                sendResponse({ success: true });
                break;

            case 'SESSION_COMPLETE': {
                // Trigger Freedom Release Sequence Animations
                const timerEl = document.getElementById(OVERLAY_ID);
                if (timerEl) {
                    timerEl.classList.add('study-lock-timer--shattering');
                }

                const flashEl = document.createElement('div');
                flashEl.className = 'study-lock-freedom-flash';
                getOrCreateContainer().appendChild(flashEl);

                // Delay cleanup to allow animations to run
                setTimeout(() => {
                    cleanup();
                    showCompletionToast(sessionDuration || message.totalDuration || 0);
                    if (flashEl) flashEl.remove();
                }, 600);

                sendResponse({ success: true });
                break;
            }

            case 'SESSION_INTERRUPTED': {
                cleanup();
                sendResponse({ success: true });
                break;
            }

            case 'SHOW_WARNING':
                showWarning(message.message);
                sendResponse({ success: true });
                break;

            case 'GET_LOCK_STATUS':
                sendResponse({ isLocked });
                break;

            default:
                sendResponse({ error: 'Unknown action' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // Recovery: Check if session was active when page loaded
    // ─────────────────────────────────────────────────────────

    (async () => {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'GET_SESSION' });
            if (response && response.session_state === 'LOCKED') {
                const remaining = response.timer_remaining_seconds;
                if (remaining > 0) {
                    // Tell background to update stored tab/window IDs to this tab
                    await chrome.runtime.sendMessage({ action: 'RECONNECT_SESSION' });
                    activateLock(
                        response.timer_duration_seconds,
                        response.session_start_timestamp,
                        {
                            mode: response.focus_mode,
                            breakSchedule: response.break_schedule,
                            flexibleAutoResumeSeconds: FLEXIBLE_AUTO_RESUME_SECONDS,
                            timerIsRunning: response.timer_is_running,
                            timerElapsedSeconds: response.timer_elapsed_seconds_live,
                            flexibleAutoResumeAt: response.flexible_auto_resume_at,
                            scheduledBreakActive: response.scheduled_break_active,
                            scheduledBreakEndsAt: response.scheduled_break_ends_at,
                            scheduledNextBreakElapsedSeconds: response.scheduled_next_break_elapsed_seconds,
                        }
                    );
                }
            }
        } catch (e) {
            // Extension context may not be ready yet — that's fine
        }
    })();
})();
