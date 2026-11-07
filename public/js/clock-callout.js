// Full-screen "PUT THE CLOCK ON EM!" splash for I'm Steve. It slams in over the whole screen,
// then shrinks and flies into the countdown (`target`), so the eye follows it to the clock.
// Used by both the host screen (app.js) and the TV view (present.js).

const DURATION_MS = 1900;

export function showClockCallout(target) {
  document.querySelector('.clock-callout')?.remove(); // never stack two

  const overlay = document.createElement('div');
  overlay.className = 'clock-callout';
  overlay.setAttribute('aria-hidden', 'true'); // the banner's live region already announces the clock
  const text = document.createElement('div');
  text.className = 'clock-callout-text';
  text.innerHTML = '<span>⏱ Put the clock</span><span>on em!</span>';
  overlay.append(text);

  // Where to fly to: the clock's centre, as an offset from the middle of the screen.
  const box = target && !target.hidden ? target.getBoundingClientRect() : null;
  const toX = box ? box.left + box.width / 2 - window.innerWidth / 2 : 0;
  const toY = box ? box.top + box.height / 2 - window.innerHeight / 2 : 0;
  overlay.style.setProperty('--to-x', `${Math.round(toX)}px`);
  overlay.style.setProperty('--to-y', `${Math.round(toY)}px`);

  document.body.append(overlay);
  // animationend can be skipped (hidden tab, reduced motion), so also clean up on a timer.
  const remove = () => overlay.remove();
  text.addEventListener('animationend', remove, { once: true });
  setTimeout(remove, DURATION_MS + 300);
}
