// TV / audience view. Renders the snapshot the host screen publishes (see publishPresentation in
// app.js). It never sees hidden answers: the host only sends answers that have been revealed.
import { CATEGORIES, clockUrgency, turnClockReading } from './game.js';
import { PRESENT_CHANNEL, PRESENT_STORAGE_KEY } from './present-sync.js';

const $ = (id) => document.getElementById(id);
let snapshot = null;
let previousAnswers = {};

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(PRESENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function accept(next) {
  if (!next || next.version !== 1) return;
  if (snapshot && next.sentAt < snapshot.sentAt) return; // ignore stale copies (e.g. a late storage event)
  snapshot = next;
  render();
}

function clockRunning(s) {
  return Boolean(s?.clock?.deadlineAt) && turnActive(s);
}

function turnActive(s) {
  return Boolean(s.turnName) && !s.complete && ['turn', 'manual'].includes(s.phase);
}

function idleText(s) {
  if (s.phase === 'game-over') {
    const top = s.standings[0]?.total ?? 0;
    const winners = s.standings.filter((row) => row.total === top).map((row) => row.name);
    return `${winners.length > 1 ? 'Tie' : 'Winner'}: ${winners.join(' and ')}! 🏆`;
  }
  if (s.phase === 'reveal' || s.complete) return 'Round complete';
  return 'Listen up…';
}

function renderBanner(s) {
  const active = turnActive(s);
  $('present-banner').classList.toggle('idle', !active);
  $('present-banner').classList.toggle('winner', s.phase === 'game-over');
  $('present-now-label').hidden = !active;
  $('present-turn').textContent = active ? s.turnName : idleText(s);
  $('present-next').hidden = !active || !s.upNextName;
  $('present-next-name').textContent = s.upNextName ?? '';
}

function renderAnswers(s) {
  for (const category of CATEGORIES) {
    const el = $(`present-${category}`);
    const value = s.answers[category];
    const wasShown = previousAnswers[category] != null;
    el.textContent = value ?? '?';
    el.classList.toggle('hidden', value == null);
    // Shrink long titles so three answers still fit the card at TV size.
    el.classList.toggle('long', (value?.length ?? 0) > 22);
    el.classList.toggle('very-long', (value?.length ?? 0) > 40);
    if (value != null && !wasShown) {
      el.classList.remove('just-revealed');
      void el.offsetWidth; // restart the animation
      el.classList.add('just-revealed');
    } else if (value == null) {
      el.classList.remove('just-revealed');
    }
  }
  previousAnswers = { ...s.answers };
  $('present-cover').hidden = !s.image;
  if (s.image) $('present-cover').src = s.image;
  else $('present-cover').removeAttribute('src');
  $('present-album').hidden = !s.album;
  $('present-album').textContent = s.album ? `from ${s.album}` : '';
}

function renderStandings(s) {
  const roundByName = new Map(s.round.map((row) => [row.name, row]));
  $('present-goal').textContent = `· to ${s.targetScore}`;
  $('present-board').classList.toggle('many', s.standings.length > 7);
  $('present-standings').replaceChildren(...s.standings.map((row) => {
    const tr = document.createElement('tr');
    const live = roundByName.get(row.name);
    if (row.rank === 1 && row.total > 0) tr.classList.add('leader');
    if (live?.current && turnActive(s)) tr.classList.add('current');
    if (live?.out) tr.classList.add('out');
    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(row.rank);
    const name = document.createElement('td');
    name.textContent = row.name;
    if (row.members?.length) {
      const members = document.createElement('span');
      members.className = 'members';
      members.textContent = row.members.join(', ');
      name.append(members);
    }
    const thisSong = document.createElement('td');
    thisSong.className = 'num gain';
    thisSong.textContent = live?.points ? `+${live.points}` : '';
    const total = document.createElement('td');
    total.className = 'num';
    total.textContent = String(row.total);
    tr.append(rank, name, thisSong, total);
    return tr;
  }));
}

function renderClock() {
  const reading = clockRunning(snapshot) ? turnClockReading(snapshot.clock) : null;
  $('present-clock').hidden = !reading;
  $('present-clock').textContent = reading ? String(reading.left) : '';
  $('present-banner').dataset.urgency = clockUrgency(reading?.left ?? null);
  $('present-bar').hidden = !reading;
  $('present-bar-fill').style.width = `${(reading?.fraction ?? 0) * 100}%`;
}

function render() {
  const s = snapshot;
  const playing = Boolean(s && s.roundNumber > 0 && s.phase !== 'idle');
  $('present-waiting').hidden = playing;
  $('present-song').hidden = !playing;
  $('present-banner').hidden = !playing;
  $('present-board').hidden = !s || !s.standings.length;
  document.body.classList.toggle('present-has-board', Boolean(s?.standings.length));
  if (!s) return;
  $('present-meta').textContent = playing ? `Song ${s.roundNumber} · ${s.mode === 'im-steve' ? 'I’m Steve' : 'No Steve'}` : '';
  if (playing) {
    renderAnswers(s);
    renderBanner(s);
  } else {
    previousAnswers = {};
  }
  renderStandings(s);
  renderClock();
}

if (typeof BroadcastChannel === 'function') {
  const channel = new BroadcastChannel(PRESENT_CHANNEL);
  channel.addEventListener('message', (event) => accept(event.data));
  channel.postMessage({ type: 'hello' }); // ask an open host screen for a fresh snapshot
}
// Fallback (and cross-window backup): the host also writes every snapshot to localStorage.
window.addEventListener('storage', (event) => {
  if (event.key === PRESENT_STORAGE_KEY && event.newValue) {
    try {
      accept(JSON.parse(event.newValue));
    } catch {
      // ignore malformed values
    }
  }
});

// ---------- Full screen + hide the mouse pointer on the TV ----------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function syncFullscreenButton() {
  const button = $('present-fullscreen');
  button.hidden = !document.documentElement.requestFullscreen || Boolean(document.fullscreenElement);
}

$('present-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFullscreen();
});
document.addEventListener('fullscreenchange', syncFullscreenButton);
syncFullscreenButton();

let idleTimer = null;
function wakePointer() {
  document.body.classList.remove('pointer-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('pointer-idle'), 3000);
}
document.addEventListener('mousemove', wakePointer);
wakePointer();

accept(readStored());
render();
setInterval(renderClock, 250);
