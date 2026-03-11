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

    // ─────────────────────────────────────────────────────────
    // Timer Overlay
    // ─────────────────────────────────────────────────────────

    function createTimerOverlay(duration, startTimestamp) {
        removeElement(OVERLAY_ID);
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

        const progressBar = document.createElement('div');
        progressBar.className = 'study-lock-timer-progress';
        const progressFill = document.createElement('div');
        progressFill.className = 'study-lock-timer-progress-fill';
        progressBar.appendChild(progressFill);

        overlay.appendChild(lockIcon);
        overlay.appendChild(timeDisplay);
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

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            overlay.style.left = `${initialLeft + dx}px`;
            overlay.style.top = `${initialTop + dy}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                overlay.style.cursor = 'grab';
            }
        });

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('study-lock-timer--visible');
        });

        return { timeDisplay, progressFill };
    }

    function startTimerOverlay(duration, startTimestamp) {
        sessionDuration = duration;
        sessionStartTimestamp = startTimestamp;

        const { timeDisplay, progressFill } = createTimerOverlay(duration, startTimestamp);

        // Clear any existing interval
        if (timerInterval) clearInterval(timerInterval);

        timerInterval = setInterval(() => {
            const elapsed = (Date.now() - sessionStartTimestamp) / 1000;
            const remaining = Math.max(0, sessionDuration - elapsed);
            const progress = ((sessionDuration - remaining) / sessionDuration) * 100;

            timeDisplay.textContent = formatTime(remaining);
            progressFill.style.width = `${progress}%`;

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
        }, 250); // Update 4x/sec for smooth display
    }

    function stopTimerOverlay() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        removeElement(OVERLAY_ID);
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

        toast.innerHTML = `
            <div class="study-lock-toast-icon">✨</div>
            <div class="study-lock-toast-text">
                <p class="study-lock-toast-title">Session Complete</p>
                <p class="study-lock-toast-subtitle">${minutes} minute${minutes !== 1 ? 's' : ''} of focus. Great job!</p>
            </div>
        `;

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

    function enforcePlayback() {
        if (!isLocked) return;
        const video = document.querySelector('video');
        if (video && video.paused) {
            video.play().catch(() => { });
            showWarning('🔒 Video pausing is disabled during your session!');
        }
    }

    function handleVisibilityChange() {
        if (!isLocked) return;
        if (document.hidden) {
            document.body.classList.add('study-lock-hidden-blur');
            // Aggressively tell the background script to pull focus back to this tab
            chrome.runtime.sendMessage({ action: 'ENFORCE_FULLSCREEN' }).catch(() => { });
        } else {
            document.body.classList.remove('study-lock-hidden-blur');
        }
    }

    // ─────────────────────────────────────────────────────────
    // Session Lifecycle
    // ─────────────────────────────────────────────────────────

    function activateLock(duration, startTimestamp) {
        isLocked = true;

        // Start timer overlay
        startTimerOverlay(duration, startTimestamp);

        // Attach keyboard blocker
        document.addEventListener('keydown', blockKeyboard, true);

        // Attach visibility listener
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Start playback enforcer interval (runs every 1 second)
        playbackInterval = setInterval(enforcePlayback, 1000);

        // Request fullscreen via background (window-level, no user gesture needed)
        requestFullscreenViaBackground();

        // Inject Digital Shutters if they don't exist
        const container = getOrCreateContainer();
        if (!document.getElementById('study-lock-shutter-top')) {
            const top = document.createElement('div');
            top.id = 'study-lock-shutter-top';
            top.className = 'study-lock-shutter study-lock-shutter-top';
            container.appendChild(top);

            const bottom = document.createElement('div');
            bottom.id = 'study-lock-shutter-bottom';
            bottom.className = 'study-lock-shutter study-lock-shutter-bottom';
            container.appendChild(bottom);
        }

        // Hide distracting YouTube elements
        document.body.classList.add('study-lock-active');

        // Trigger shutter animation on next frame
        requestAnimationFrame(() => {
            document.body.classList.add('study-lock-shutters-active');
        });
    }

    function cleanup() {
        isLocked = false;

        stopTimerOverlay();
        removeElement(WARNING_ID);

        if (playbackInterval) {
            clearInterval(playbackInterval);
            playbackInterval = null;
        }

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
                activateLock(message.duration, message.startTimestamp);
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

                document.body.classList.remove('study-lock-shutters-active');

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
                document.body.classList.remove('study-lock-shutters-active');
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
                    activateLock(
                        response.timer_duration_seconds,
                        response.session_start_timestamp
                    );
                }
            }
        } catch (e) {
            // Extension context may not be ready yet — that's fine
        }
    })();
})();
