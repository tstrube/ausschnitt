(() => {
    const elementsToSelect = ['selector_image', 'selector_next', 'selector_back', 'selector_first', 'selector_latest'];
    const stepLabels = [
        'Click the <strong>comic image</strong>',
        'Click the <strong>Next page</strong> button',
        'Click the <strong>Back page</strong> button',
        'Click the <strong>First page</strong> button',
        'Click the <strong>Latest page</strong> button'
    ];
    let currentIndex = 0;
    const selectors = {};
    const selectedElements = new Set();

    const iframe = document.getElementById('comicFrame');
    const retryBtn = document.getElementById('retryBtn');
    const browseModeBtn = document.getElementById('browseModeBtn');
    const currentStepLabel = document.getElementById('currentStepLabel');

    // Next/Latest are often rendered as *disabled* (no real link) on the
    // one page they're most naturally selected from - the comic's own
    // latest page. Browse mode lets the user click through the site's own
    // links (e.g. "Previous") to reach an older page where those controls
    // are live, without leaving the picker or losing selections made so
    // far. Every click still goes through our own /proxy (never a direct
    // iframe navigation - the site's X-Frame-Options/CSP would just block
    // it), reusing findRealLink to resolve whatever was clicked to a URL.
    let browseMode = false;

    function updateStepLabel() {
        if (!currentStepLabel) return;
        currentStepLabel.innerHTML = currentIndex < stepLabels.length
            ? stepLabels[currentIndex]
            : 'All elements selected - saving...';
    }

    updateStepLabel();

    function getClassList(el) {
        return el.className && typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean)
            : [];
    }

    // A selector's exact-match fast path is only as good as how uniquely it
    // pins down this one element. Prefers the element's own id/class; if it
    // has neither, walks *all* the way up to <body> looking for an
    // ancestor with one. If truly nothing on the page distinguishes this
    // element's lineage (rare, but real on sites with fully class-free
    // markup), falls back to an nth-child structural path rather than a
    // bare tag name - a bare tag name matches every element like it on the
    // page (every <img>, every <a>, every <li>), so a comic's image could
    // tie in score with, say, the site's menu icon.
    function buildSelector(el) {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `#${CSS.escape(el.id)}`;

        const ownClasses = getClassList(el);
        if (ownClasses.length) return `${tag}.${ownClasses.map(c => CSS.escape(c)).join('.')}`;

        const body = el.ownerDocument.body;
        for (let ancestor = el.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
            if (ancestor.id) return `#${CSS.escape(ancestor.id)} ${tag}`;
            const ancestorClasses = getClassList(ancestor);
            if (ancestorClasses.length) {
                return `${ancestor.tagName.toLowerCase()}.${ancestorClasses.map(c => CSS.escape(c)).join('.')} ${tag}`;
            }
        }

        return buildStructuralPath(el);
    }

    // Last-resort selector: a chain of ":nth-child(n)" steps from the
    // nearest identifiable ancestor (or <body>) down to this element, so
    // it's unique to this one spot in the tree instead of matching every
    // element of the same tag on the page.
    function buildStructuralPath(el) {
        const body = el.ownerDocument.body;
        const steps = [];
        let node = el;
        while (node && node !== body && node.parentElement) {
            const index = Array.from(node.parentElement.children).indexOf(node) + 1;
            steps.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
            if (node.parentElement.id) {
                steps.unshift(`#${CSS.escape(node.parentElement.id)}`);
                return steps.join(' > ');
            }
            node = node.parentElement;
        }
        steps.unshift('body');
        return steps.join(' > ');
    }

    // Builds the same shape the server's SelectorFingerprint matcher expects,
    // so navigation can still find the element later even if the exact
    // selector stops matching after a markup change on the comic's site.
    function buildFingerprint(el) {
        const classes = getClassList(el);
        const parent = el.parentElement;
        return {
            selector: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            classes,
            parentTag: parent ? parent.tagName.toLowerCase() : '',
            siblingTags: parent ? Array.from(parent.children).map(c => c.tagName.toLowerCase()) : [],
            text: (el.textContent || '').trim().slice(0, 50) || undefined
        };
    }

    // "#", "", and "javascript:..." are how sites render a *disabled* nav
    // control (e.g. "Next" while already on the latest page) as an <a>
    // rather than removing the link - technically an href, but not a real
    // navigation target. Must match the server's matchSelector.ts rule.
    function isRealHref(href) {
        if (!href) return false;
        const trimmed = href.trim();
        if (trimmed === '' || trimmed === '#') return false;
        if (trimmed.toLowerCase().startsWith('javascript:')) return false;
        return true;
    }

    function realHrefOf(el) {
        return isRealHref(el.getAttribute('href')) ? el.getAttribute('href') : null;
    }

    // Finds a real, followable link at, above, or inside el - or null if
    // there isn't one anywhere nearby (a JS-only button, an icon with no
    // enclosing <a>, or a disabled control with only a "#"/empty href).
    function findRealLink(el) {
        if (realHrefOf(el)) return el;
        for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.tagName === 'A' && realHrefOf(ancestor)) return ancestor;
        }
        const descendants = el.querySelectorAll ? el.querySelectorAll('a[href]') : [];
        for (const d of descendants) {
            if (realHrefOf(d)) return d;
        }
        return null;
    }

    // The exact node under the cursor is often not the useful one - clicking
    // "Next" might land on a <span> of text inside the real <a>, or on a
    // wrapping <li> around it. Resolve to the element that actually carries
    // what's needed later (src for the image, href for nav links).
    function resolveTarget(el, isImageStep) {
        if (isImageStep) {
            if (el.tagName.toLowerCase() === 'img') return el;
            return el.querySelector('img') || el.closest('img') || el;
        }
        return findRealLink(el) || el;
    }

    function currentIsImageStep() {
        return elementsToSelect[currentIndex] === 'selector_image';
    }

    function waitForIframeContent(selector = 'img', tries = 10, delay = 500) {
        return new Promise((resolve, reject) => {
            let attempt = 0;
            const check = () => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    const el = doc.querySelector(selector);
                    if (el) return resolve();
                } catch (err) {
                    // Cross-origin issue or not ready
                }
                attempt++;
                if (attempt >= tries) return reject('Timeout: iframe content not ready');
                setTimeout(check, delay);
            };
            check();
        });
    }

    function markSelected(el) {
        selectedElements.add(el);
        el.style.outline = '3px solid #2ecc71';
        el.style.outlineOffset = '1px';
    }

    function describeElement(el) {
        const id = el.id ? `#${el.id}` : '';
        const cls = getClassList(el).map(c => `.${c}`).join('');
        return `<${el.tagName.toLowerCase()}>${id}${cls}`;
    }

    function enableSelectionListeners() {
        const doc = iframe.contentDocument || iframe.contentWindow.document;

        doc.addEventListener('mouseover', e => {
            if (browseMode || currentIndex >= elementsToSelect.length) return;
            const target = resolveTarget(e.target, currentIsImageStep());
            if (selectedElements.has(target)) return;
            e.preventDefault();
            e.stopPropagation();
            target.style.outline = '3px solid orange';
        }, true);

        doc.addEventListener('mouseout', e => {
            if (browseMode || currentIndex >= elementsToSelect.length) return;
            const target = resolveTarget(e.target, currentIsImageStep());
            if (selectedElements.has(target)) return;
            e.preventDefault();
            e.stopPropagation();
            target.style.outline = '';
        }, true);

        doc.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();

            if (browseMode) {
                const link = findRealLink(e.target);
                if (!link) return;
                iframe.src = `/proxy?url=${encodeURIComponent(link.getAttribute('href'))}`;
                return;
            }

            if (currentIndex >= elementsToSelect.length) return;

            const isImageStep = currentIsImageStep();
            const el = resolveTarget(e.target, isImageStep);

            // A nav step must resolve to a real, followable link - reject
            // the click instead of silently recording a button/span/icon
            // that navigation can never actually use (e.g. this exact page
            // has no next page, so "Next" is a dead <a href="#">, or the
            // control is JS-only with no href anywhere in it at all).
            if (!isImageStep && !findRealLink(el)) {
                showToast(
                    "That doesn't lead anywhere from this page (no real link found) - " +
                    'if this is a "Next"/"Latest" button, it may be disabled because you\'re ' +
                    'already on the newest page, turn on Browse mode below, click "Previous" ' +
                    'a couple of times to reach an older page, then select it from there.',
                    { type: 'error', duration: 8000 }
                );
                return;
            }

            selectors[elementsToSelect[currentIndex]] = buildFingerprint(el);
            markSelected(el);
            showToast(`Selected: ${describeElement(el)}`, { duration: 2000 });

            currentIndex++;
            updateStepLabel();
            if (currentIndex >= elementsToSelect.length) {
                finishSelection();
            }
        }, true);
    }

    if (browseModeBtn) {
        browseModeBtn.addEventListener('click', () => {
            browseMode = !browseMode;
            browseModeBtn.textContent = browseMode ? 'Stop Browsing' : 'Browse Site';
            browseModeBtn.classList.toggle('btn-warning', browseMode);
            browseModeBtn.classList.toggle('btn-outline-light', !browseMode);
        });
    }

    // There's no way to correct a selection once made, so there's nothing
    // left to confirm by the time the last one is picked - save immediately
    // instead of making the user click a separate Finish button.
    function finishSelection() {
        fetch(`/select/${comicId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(selectors)
        }).then(res => res.json())
            .then(data => {
                if (data.success) {
                    window.location.href = `/reader/${comicId}`;
                } else {
                    showToast('Failed to save selectors.', { type: 'error' });
                }
            }).catch(() => {
                showToast('Error saving selectors.', { type: 'error' });
            });
    }

    function showRetryButton() {
        retryBtn.style.display = 'inline-block';
    }

    function hideRetryButton() {
        retryBtn.style.display = 'none';
    }

    iframe.addEventListener('load', () => {
        waitForIframeContent('img, a, div', 10, 500)
            .then(() => {
                enableSelectionListeners();
            })
            .catch(err => {
                console.warn(err);
                showToast('Could not detect content in the page preview. Try retrying.', { type: 'error' });
                showRetryButton();
            });
    });

    retryBtn.addEventListener('click', () => {
        hideRetryButton();
        waitForIframeContent('img, a, div', 20, 1000) // Longer retry
            .then(() => {
                enableSelectionListeners();
            })
            .catch(err => {
                console.warn(err);
                showToast('Still could not detect content. The site may block being shown in a frame.', { type: 'error' });
                showRetryButton();
            });
    });
})();
