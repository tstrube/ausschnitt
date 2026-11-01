// Registers the service worker that makes Ausschnitt installable as an app
// (see public/sw.js). Browsers only allow this on HTTPS or localhost - over
// plain HTTP the site simply works without it.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed', err));
    });
}
