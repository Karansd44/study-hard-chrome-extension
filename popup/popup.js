/**
 * Study Lock — Popup Script
 * 
 * Handles timer setup, validates YouTube URLs,
 * and communicates with the background service worker.
 */

(function () {
    'use strict';

    // ─── DOM References ───
    const setupSection = document.getElementById('popup-setup');
    const statusSection = document.getElementById('popup-status');
    const errorSection = document.getElementById('popup-error');
    const errorText = document.getElementById('popup-error-text');
    const startBtn = document.getElementById('start-btn');
    const customInput = document.getElementById('custom-minutes');
    const statusTime = document.getElementById('popup-status-time');
    const statusMode = document.getElementById('popup-status-mode');
    const presetButtons = document.querySelectorAll('.popup-preset');
    const modeButtons = document.querySelectorAll('.popup-mode');

    let selectedMinutes = null;
    let selectedMode = 'UNINTERRUPTED_FLOW';
    let currentTab = null;
    let statusInterval = null;

    // ─── Utilities ───

    function formatTime(totalSeconds) {
        const mins = Math.floor(totalSeconds / 60);
        const secs = Math.floor(totalSeconds % 60);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function isYouTubeVideo(url) {
        try {
            const u = new URL(url);
            return (
                (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
                u.pathname === '/watch' &&
                u.searchParams.has('v')
            );
        } catch {
            return false;
        }
    }

    function showSection(section) {
        setupSection.style.display = 'none';
        statusSection.style.display = 'none';
        errorSection.style.display = 'none';
        section.style.display = 'flex';
    }

    function formatModeLabel(mode) {
        switch (mode) {
            case 'FLEXIBLE_FOCUS':
                return 'Flexible Focus';
            case 'SCHEDULED_BREAK':
                return 'Scheduled Break';
            default:
                return 'Uninterrupted Flow';
        }
    }

    function setSelectedMode(mode) {
        selectedMode = mode;
        modeButtons.forEach((btn) => {
            btn.classList.toggle('popup-mode--active', btn.dataset.mode === mode);
        });
    }

    function setSelectedMinutes(mins) {
        selectedMinutes = mins;

        // Update preset button states
        presetButtons.forEach((btn) => {
            const btnMins = parseInt(btn.dataset.minutes);
            btn.classList.toggle('popup-preset--active', btnMins === mins);
        });

        // Update custom input if it doesn't match a preset
        const isPreset = [15, 30, 45, 60].includes(mins);
        if (!isPreset) {
            customInput.value = mins;
        } else {
            customInput.value = '';
        }

        // Enable start button
        startBtn.disabled = false;
        startBtn.classList.add('popup-start-btn--ready');
    }

    // ─── Event Handlers ───

    modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            setSelectedMode(btn.dataset.mode || 'UNINTERRUPTED_FLOW');
        });
    });

    // Preset buttons
    presetButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            setSelectedMinutes(parseInt(btn.dataset.minutes));
        });
    });

    // Custom input
    customInput.addEventListener('input', () => {
        const val = parseInt(customInput.value);
        if (val >= 5 && val <= 120) {
            selectedMinutes = val;
            presetButtons.forEach((b) => b.classList.remove('popup-preset--active'));
            startBtn.disabled = false;
            startBtn.classList.add('popup-start-btn--ready');
        } else {
            selectedMinutes = null;
            startBtn.disabled = true;
            startBtn.classList.remove('popup-start-btn--ready');
        }
    });

    // Start session
    startBtn.addEventListener('click', async () => {
        if (!selectedMinutes || !currentTab) return;

        startBtn.disabled = true;
        startBtn.querySelector('.popup-start-btn-text').textContent = 'LOCKING...';

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'START_SESSION',
                tabId: currentTab.id,
                windowId: currentTab.windowId,
                duration: selectedMinutes * 60, // Convert to seconds
                mode: selectedMode,
                url: currentTab.url,
            });

            if (response && response.success) {
                window.close(); // Close popup
            } else {
                startBtn.querySelector('.popup-start-btn-text').textContent = 'ERROR — TRY AGAIN';
                startBtn.disabled = false;
            }
        } catch (err) {
            console.error('Study Lock: Failed to start session:', err);
            startBtn.querySelector('.popup-start-btn-text').textContent = 'ERROR — TRY AGAIN';
            startBtn.disabled = false;
        }
    });

    // ─── Active Session Status ───

    function startStatusPolling() {
        updateStatus();
        statusInterval = setInterval(updateStatus, 1000);
    }

    async function updateStatus() {
        try {
            const session = await chrome.runtime.sendMessage({ action: 'GET_SESSION' });
            if (session && session.session_state === 'LOCKED') {
                statusTime.textContent = formatTime(session.timer_remaining_seconds);
                statusMode.textContent = formatModeLabel(session.focus_mode);
            } else {
                // Session ended — refresh the popup view
                clearInterval(statusInterval);
                init();
            }
        } catch (e) { /* noop */ }
    }

    // ─── Initialization ───

    async function init() {
        try {
            // Check if a session is already active
            const session = await chrome.runtime.sendMessage({ action: 'GET_SESSION' });

            if (session && session.session_state === 'LOCKED' && session.timer_remaining_seconds > 0) {
                statusMode.textContent = formatModeLabel(session.focus_mode);
                showSection(statusSection);
                startStatusPolling();
                return;
            }

            // No active session — check if we're on a YouTube video
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !isYouTubeVideo(tab.url)) {
                errorText.textContent = 'Navigate to a YouTube video to start a focus session.';
                showSection(errorSection);
                return;
            }

            // We're on a YouTube video — show the setup UI
            currentTab = tab;
            setSelectedMode('UNINTERRUPTED_FLOW');
            showSection(setupSection);

        } catch (err) {
            console.error('Study Lock: Popup init error:', err);
            errorText.textContent = 'Something went wrong. Please try again.';
            showSection(errorSection);
        }
    }

    init();
})();
