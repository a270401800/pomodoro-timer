// ===== Constants =====
const WORK_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;
const LONG_BREAK_SECONDS = 15 * 60;
const LONG_BREAK_INTERVAL = 4;
const TICK_MS = 250;
const CIRCUMFERENCE = 2 * Math.PI * 105; // ~659.73

// ===== State =====
const state = {
  mode: 'work',          // 'work' | 'break'
  status: 'idle',        // 'idle' | 'running' | 'paused'
  totalSeconds: WORK_SECONDS,
  secondsRemaining: WORK_SECONDS,
  endTime: null,         // absolute timestamp when timer will finish
  completedSession: 0,   // sessions completed in current cycle (for long break)
  completedToday: 0,     // total work sessions completed today
  soundEnabled: true,
  alwaysOnTop: false,
};

// ===== DOM Elements =====
const els = {
  ringProgress: document.getElementById('ring-progress'),
  ringSvg: document.querySelector('.timer-ring'),
  timerDigits: document.getElementById('timer-digits'),
  modeLabel: document.getElementById('mode-label'),
  btnPrimary: document.getElementById('btn-primary'),
  btnPrimaryIcon: document.getElementById('btn-primary-icon'),
  btnPrimaryText: document.getElementById('btn-primary-text'),
  btnReset: document.getElementById('btn-reset'),
  btnSkip: document.getElementById('btn-skip'),
  btnSound: document.getElementById('btn-sound'),
  soundIcon: document.getElementById('sound-icon'),
  btnPin: document.getElementById('btn-pin'),
  pinIcon: document.getElementById('pin-icon'),
  sessionCount: document.getElementById('session-count'),
  focusTime: document.getElementById('focus-time'),
  longBreakIndicator: document.getElementById('long-break-indicator'),
};

// ===== Audio =====
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playChime(type) {
  if (!state.soundEnabled) return;

  try {
    const ctx = getAudioContext();
    const frequencies = type === 'work-done'
      ? [523.25, 659.25, 783.99]  // C5, E5, G5 - ascending
      : [783.99, 659.25, 523.25]; // G5, E5, C5 - descending

    const startTime = ctx.currentTime;

    frequencies.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = freq;

      const t = startTime + i * 0.22;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.3, t + 0.01);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.12);
      gain.gain.linearRampToValueAtTime(0, t + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    });
  } catch (e) {
    // Audio not available, silent fail
  }
}

// ===== Persistence =====
const STORAGE_KEY = 'pomodoro-sessions';

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // localStorage full or unavailable
  }
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayCount() {
  const sessions = loadSessions();
  return sessions[getTodayKey()] || 0;
}

function incrementTodayCount() {
  const sessions = loadSessions();
  const today = getTodayKey();
  sessions[today] = (sessions[today] || 0) + 1;
  // Prune entries older than 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(sessions)) {
    if (new Date(key) < thirtyDaysAgo) {
      delete sessions[key];
    }
  }
  saveSessions(sessions);
  state.completedToday = sessions[today];
}

function loadPreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem('pomodoro-prefs') || '{}');
    if (typeof prefs.soundEnabled === 'boolean') state.soundEnabled = prefs.soundEnabled;
    if (typeof prefs.alwaysOnTop === 'boolean') state.alwaysOnTop = prefs.alwaysOnTop;
  } catch {
    // defaults
  }
}

function savePreferences() {
  try {
    localStorage.setItem('pomodoro-prefs', JSON.stringify({
      soundEnabled: state.soundEnabled,
      alwaysOnTop: state.alwaysOnTop,
    }));
  } catch {
    // silent
  }
}

// ===== Timer Logic =====
let tickInterval = null;

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getTotalSeconds() {
  if (state.mode === 'work') return WORK_SECONDS;
  return isLongBreakDue() ? LONG_BREAK_SECONDS : BREAK_SECONDS;
}

function isLongBreakDue() {
  // Long break is due when mode is 'break' and we've completed LONG_BREAK_INTERVAL work sessions
  return state.mode === 'break' && state.completedSession > 0 && state.completedSession % LONG_BREAK_INTERVAL === 0;
}

function startTimer() {
  if (state.status === 'idle') {
    // Fresh start
    state.totalSeconds = getTotalSeconds();
    state.secondsRemaining = state.totalSeconds;
  }
  // Resume from paused: secondsRemaining already has the correct value
  state.endTime = Date.now() + state.secondsRemaining * 1000;
  state.status = 'running';

  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, TICK_MS);
  tick(); // immediate update
  updateUI();
}

function pauseTimer() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  state.secondsRemaining = Math.max(0, Math.ceil((state.endTime - Date.now()) / 1000));
  state.status = 'paused';
  updateUI();
}

function resetTimer() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  state.mode = 'work';
  state.status = 'idle';
  state.totalSeconds = WORK_SECONDS;
  state.secondsRemaining = WORK_SECONDS;
  state.endTime = null;
  updateUI();
}

function skipSession() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  state.status = 'idle';
  state.endTime = null;
  state.secondsRemaining = 0;
  handleSessionComplete();
}

function tick() {
  if (state.status !== 'running') return;

  const remaining = Math.max(0, Math.ceil((state.endTime - Date.now()) / 1000));
  state.secondsRemaining = remaining;

  updateTimerDisplay(remaining);

  if (remaining <= 0) {
    handleTimerFinished();
  }
}

function handleTimerFinished() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  state.status = 'idle';
  state.secondsRemaining = 0;

  // Pulse animation
  els.timerDigits.classList.add('finished');
  setTimeout(() => els.timerDigits.classList.remove('finished'), 2000);

  handleSessionComplete();
}

function handleSessionComplete() {
  if (state.mode === 'work') {
    // Work session completed
    state.completedSession++;
    incrementTodayCount();

    playChime('work-done');
    notify('番茄钟完成！🍅',
      `${WORK_SECONDS / 60} 分钟专注结束，休息一下吧！`);

    state.mode = 'break';
    state.totalSeconds = getTotalSeconds();
    state.secondsRemaining = state.totalSeconds;
  } else {
    // Break session completed
    playChime('break-done');
    notify('休息结束！☕',
      '休息时间到，继续专注吧！');

    state.mode = 'work';
    state.totalSeconds = WORK_SECONDS;
    state.secondsRemaining = WORK_SECONDS;
  }

  updateUI();

  // Update tray
  if (window.electronAPI) {
    window.electronAPI.updateTrayTitle(formatTime(state.secondsRemaining), state.status);
  }
}

function notify(title, body) {
  if (window.electronAPI) {
    window.electronAPI.notify(title, body);
  }
}

// ===== UI Updates =====
function updateTimerDisplay(seconds) {
  els.timerDigits.textContent = formatTime(seconds);

  // Update progress ring
  const progress = state.totalSeconds > 0 ? 1 - (seconds / state.totalSeconds) : 1;
  const offset = CIRCUMFERENCE * progress;
  els.ringProgress.setAttribute('stroke-dashoffset', offset.toString());

  // Update tray
  if (window.electronAPI && state.status === 'running') {
    window.electronAPI.updateTrayTitle(formatTime(seconds), state.status);
  }
}

function updateUI() {
  updateTimerDisplay(state.secondsRemaining);

  // Mode label
  els.modeLabel.textContent = state.mode === 'work' ? '专注' : '休息';
  els.modeLabel.className = 'mode-label ' + state.mode;

  // Ring color
  const isBreak = state.mode === 'break';
  els.ringProgress.classList.toggle('break-mode', isBreak);
  els.ringSvg.classList.toggle('break-mode', isBreak);

  // Primary button
  els.btnPrimary.classList.toggle('break-mode', isBreak);

  if (state.status === 'running') {
    els.btnPrimaryIcon.textContent = '⏸';
    els.btnPrimaryText.textContent = '暂停';
  } else if (state.status === 'paused') {
    els.btnPrimaryIcon.textContent = '▶';
    els.btnPrimaryText.textContent = '继续';
  } else {
    els.btnPrimaryIcon.textContent = '▶';
    els.btnPrimaryText.textContent = '开始';
  }

  // Reset button: disabled when idle with full time
  const isIdleAtFull = state.status === 'idle' &&
    state.secondsRemaining === getTotalSeconds() &&
    state.mode === 'work';
  els.btnReset.disabled = isIdleAtFull;

  // Skip button text
  els.btnSkip.querySelector('span:last-child').textContent =
    state.mode === 'work' ? '跳过' : '跳过休息';

  // Stats
  els.sessionCount.textContent = `今日 ${state.completedToday} 次专注`;
  const totalMin = state.completedToday * WORK_SECONDS / 60;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) {
    els.focusTime.textContent = `今日专注 ${hours} 小时 ${mins} 分钟`;
  } else {
    els.focusTime.textContent = `今日专注 ${mins} 分钟`;
  }

  // Long break indicator
  els.longBreakIndicator.style.display = isLongBreakDue() ? 'flex' : 'none';

  // Sound button
  els.btnSound.classList.toggle('muted', !state.soundEnabled);
  els.soundIcon.textContent = state.soundEnabled ? '🔊' : '🔇';
  els.btnSound.classList.toggle('active', state.soundEnabled);

  // Pin button
  els.btnPin.classList.toggle('active', state.alwaysOnTop);
}

// ===== Event Handlers =====
els.btnPrimary.addEventListener('click', () => {
  // Initialize audio context on first user interaction
  getAudioContext();

  if (state.status === 'running') {
    pauseTimer();
  } else {
    startTimer();
  }
});

els.btnReset.addEventListener('click', () => {
  resetTimer();
});

els.btnSkip.addEventListener('click', () => {
  skipSession();
});

els.btnSound.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  savePreferences();
  updateUI();
});

els.btnPin.addEventListener('click', () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  savePreferences();
  if (window.electronAPI) {
    window.electronAPI.setAlwaysOnTop(state.alwaysOnTop);
  }
  updateUI();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    getAudioContext();
    if (state.status === 'running') {
      pauseTimer();
    } else {
      startTimer();
    }
  }
  if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && e.target === document.body) {
    e.preventDefault();
    resetTimer();
  }
  if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey && e.target === document.body) {
    e.preventDefault();
    skipSession();
  }
});

// IPC: Listen for tray menu actions
if (window.electronAPI) {
  window.electronAPI.onTimerAction((action) => {
    switch (action) {
      case 'pause':
        if (state.status === 'running') pauseTimer();
        break;
      case 'resume':
        if (state.status === 'paused') startTimer();
        break;
      case 'reset':
        resetTimer();
        break;
    }
  });

  window.electronAPI.onAlwaysOnTopChanged((flag) => {
    state.alwaysOnTop = flag;
    savePreferences();
    updateUI();
  });
}

// ===== Initialization =====
function init() {
  state.completedToday = getTodayCount();
  loadPreferences();

  // Set up ring
  els.ringProgress.style.strokeDasharray = CIRCUMFERENCE.toString();
  els.ringProgress.style.strokeDashoffset = '0';

  // Apply always-on-top
  if (state.alwaysOnTop && window.electronAPI) {
    window.electronAPI.setAlwaysOnTop(true);
  }

  updateUI();
}

document.addEventListener('DOMContentLoaded', init);
