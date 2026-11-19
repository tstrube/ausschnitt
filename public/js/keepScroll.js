// Settings pages save each change by submitting its form, and the server
// answers with the same page - which would open at the top. Right before a
// change submits, remembers where on screen the changed control was; on the
// page that comes back (same path) scrolls so it's there again - even if a
// hint above it now takes another line. Falls back to the plain scroll
// position for a control without an id.
(() => {
    const key = `keepScroll:${location.pathname}`;
    try {
        const raw = sessionStorage.getItem(key);
        if (raw !== null) {
            sessionStorage.removeItem(key);
            const saved = JSON.parse(raw);
            const control = saved.id && document.getElementById(saved.id);
            const anchor = control && ((control.labels && control.labels[0]) || control);
            // Instantly - Bootstrap makes scrolling smooth, which would slide
            // the page into place in view.
            window.scrollTo({
                top: anchor ? anchor.getBoundingClientRect().top + window.scrollY - saved.top : saved.y,
                behavior: 'instant'
            });
        }
    } catch {
        // No storage (private mode) or nothing usable - the page opens at the
        // top as before.
    }

    function remember(control) {
        // A toggle button's input is visually hidden; its label is what's
        // on screen.
        const anchor = control && ((control.labels && control.labels[0]) || control);
        try {
            sessionStorage.setItem(key, JSON.stringify({
                y: window.scrollY,
                id: control && control.id ? control.id : null,
                top: anchor ? anchor.getBoundingClientRect().top : 0
            }));
        } catch {
            // As above.
        }
    }

    // Capture phase: runs before a form's own onchange submits it
    // (form.submit() fires no submit event).
    document.addEventListener('change', event => {
        if (event.target instanceof Element && event.target.closest('form')) remember(event.target);
    }, true);
    document.addEventListener('submit', event => remember(event.submitter || null), true);
})();
