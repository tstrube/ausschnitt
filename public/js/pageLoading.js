// Opening a comic can take a while - its first pages are downloaded and
// split before the reader answers - and the old page would just sit there
// meanwhile. Any link into the reader shows a spinner over the page until
// the next one replaces it, turning the way the comic reads: clockwise
// left to right, counterclockwise right to left (the link's
// data-direction).
(() => {
    const overlay = document.createElement('div');
    overlay.className = 'page-loading';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div class="page-loading-spinner"></div>';

    document.addEventListener('click', event => {
        const link = event.target instanceof Element && event.target.closest('a[href^="/reader/"]');
        // Not when the link opens elsewhere (new tab, download, modifier keys).
        if (!link || event.defaultPrevented || event.button !== 0 || link.target
            || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        overlay.classList.toggle('rtl', link.dataset.direction === 'rtl');
        document.body.appendChild(overlay);
    });

    // Back to this page from the bfcache: it's still showing.
    window.addEventListener('pageshow', () => overlay.remove());
})();
