const CHANNEL = 'music-game-spotify-player';
const EMBED_API_URL = 'https://open.spotify.com/embed/iframe-api/v1';
const status = document.getElementById('player-status');
const embedElement = document.getElementById('spotify-embed');
const initialUri = new URLSearchParams(location.search).get('uri');
let controller = null;
const pendingCommands = [];

function isTrackUri(uri) {
  return /^spotify:track:[A-Za-z0-9]+$/.test(uri ?? '');
}

function reportError(error) {
  const message = error?.message || String(error);
  status.textContent = `Spotify player error: ${message}`;
  status.classList.add('error');
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ channel: CHANNEL, type: 'error', message }, location.origin);
  }
}

function sendToOpener(message) {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ channel: CHANNEL, ...message }, location.origin);
  }
}

function runCommand(message) {
  if (!controller) {
    pendingCommands.push(message);
    return;
  }

  try {
    switch (message.type) {
      case 'load':
        if (!isTrackUri(message.uri)) throw new Error('The game sent an invalid Spotify track URI.');
        controller.loadEntity(message.uri);
        status.textContent = 'Game track loaded. Use Spotify’s Play control if it does not start.';
        if (message.play) window.setTimeout(() => controller?.play(), 500);
        break;
      case 'play':
        controller.play();
        break;
      case 'pause':
        controller.pause();
        break;
      case 'restart':
        controller.restart();
        break;
      default:
        break;
    }
  } catch (error) {
    reportError(error);
  }
}

window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.opener ||
    event.data?.channel !== CHANNEL
  ) return;
  runCommand(event.data);
});

window.onSpotifyIframeApiReady = (IFrameAPI) => {
  if (!isTrackUri(initialUri)) {
    reportError(new Error('The game did not provide a valid Spotify track.'));
    return;
  }

  try {
    IFrameAPI.createController(embedElement, {
      uri: initialUri,
      width: '100%',
      height: 352,
    }, (embedController) => {
      controller = embedController;
      controller.addListener('playback_update', (event) => {
        const isPaused = Boolean(event?.data?.isPaused);
        status.textContent = isPaused ? 'Spotify player is paused.' : 'Playing in Spotify player.';
        sendToOpener({ type: 'playback', isPaused });
      });
      status.textContent = 'Spotify player ready. Use its controls to start playback.';
      sendToOpener({ type: 'ready', uri: initialUri });
      for (const command of pendingCommands.splice(0)) runCommand(command);
    });
  } catch (error) {
    reportError(error);
  }
};

const apiScript = document.createElement('script');
apiScript.src = EMBED_API_URL;
apiScript.async = true;
apiScript.onerror = () => reportError(new Error('Could not load Spotify’s Embed API.'));
document.head.append(apiScript);
