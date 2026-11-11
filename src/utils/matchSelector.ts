import { SelectorFingerprint } from '../types';

function queryCandidates(selector: string, root: Document | Element): Element[] {
    try {
        return Array.from(root.querySelectorAll(selector));
    } catch {
        // Selector may be invalid (e.g. stale/hand-typed CSS) - fall back to scoring instead of crashing.
        return [];
    }
}

interface ScoredElement {
    el: Element;
    score: number;
    /** Whether the score is backed by something specific to *this* element
     * (its own class list or its text), as opposed to purely generic shape
     * signals (tag/parentTag/sibling tags) that every sibling-like element
     * on the page (other list items, other links) shares equally. */
    specific: boolean;
}

function scoreElement(el: Element, fingerprint: SelectorFingerprint): ScoredElement {
    let score = 0;
    let specific = false;

    if (el.tagName.toLowerCase() === fingerprint.tag) score += 2;

    const elClasses = Array.from(el.classList);
    const common = elClasses.filter(c => fingerprint.classes.includes(c));
    if (common.length > 0) specific = true;
    score += common.length;

    if (el.parentElement?.tagName.toLowerCase() === fingerprint.parentTag) score += 1;

    const siblingTags = Array.from(el.parentElement?.children || []).map(
        sib => sib.tagName.toLowerCase()
    );
    const overlap = siblingTags.filter(tag => fingerprint.siblingTags.includes(tag));
    score += overlap.length * 0.5;

    const textContent = (el.textContent || '').trim();
    if (fingerprint.text && textContent.includes(fingerprint.text)) {
        score += 1;
        specific = true;
    }

    return { el, score, specific };
}

/**
 * Picks the highest-scoring candidate, but refuses to guess when the top
 * score is a tie between multiple elements and *none* of them won on
 * anything specific to them (class/text) - only on generic tag/parent/
 * sibling shape that every similar element on the page shares equally.
 * Concretely: a comic image with no distinguishing id/class, sitting in
 * an <a> with one sibling <img>, scores identically to a hamburger-menu
 * icon in the site header with the same shape - picking "whichever came
 * first in the DOM" there is a coin flip, not a match. Failing safe here
 * (like panelSplitter does) beats silently saving the wrong image/link.
 *
 * A tie where the winners *do* have specific signal (e.g. two elements
 * both matched via text "Previous") is a different, common, and harmless
 * case - many sites render nav twice (a desktop bar and a mobile-only
 * duplicate) and both copies point to the same place, so picking either
 * one is fine.
 */
function bestMatch(candidates: Element[], fingerprint: SelectorFingerprint): Element | null {
    const scored = candidates.map(el => scoreElement(el, fingerprint));

    let bestScore = -1;
    for (const s of scored) {
        if (s.score > bestScore) bestScore = s.score;
    }
    if (bestScore <= 0) return null;

    const winners = scored.filter(s => s.score === bestScore);
    if (winners.length === 1) return winners[0].el;

    const specificWinners = winners.filter(w => w.specific);
    if (specificWinners.length > 0) return specificWinners[0].el;

    return null;
}

/**
 * Tries the fingerprint's exact selector first (fast path). If that no longer
 * matches anything - e.g. the site's markup drifted since the selector was
 * recorded - falls back to scoring every element of the recorded tag against
 * the rest of the fingerprint, so minor DOM changes don't break navigation.
 */
export function matchElementByFingerprint(fingerprint: SelectorFingerprint, root: Document | Element): Element | null {
    const exactCandidates = queryCandidates(fingerprint.selector, root);
    // A selector that pins down exactly one element (typically an #id) is
    // trusted outright - no scoring gate. Scoring only matters once the
    // selector is ambiguous (matches several elements, e.g. a bare tag name
    // like "img" or "a" recorded when no id/class was ever found).
    if (exactCandidates.length === 1) return exactCandidates[0];
    if (exactCandidates.length > 1) {
        return bestMatch(exactCandidates, fingerprint);
    }

    if (!fingerprint.tag) return null;
    const fallbackCandidates = queryCandidates(fingerprint.tag, root);
    if (fallbackCandidates.length === 0) return null;

    return bestMatch(fallbackCandidates, fingerprint);
}

/**
 * "#", "", and "javascript:..." are how sites render a *disabled* nav
 * control as an <a> rather than removing the link entirely (e.g. "Next" on
 * a comic's own latest page). They're technically a valid href attribute,
 * but following one is either a same-page no-op (silently re-scraping the
 * current page as if it were new - it's how a duplicate page/panel of the
 * current strip ends up saved) or a thrown error. Treat them as absent.
 */
function isRealHref(href: string | null): href is string {
    if (!href) return false;
    const trimmed = href.trim();
    if (trimmed === '' || trimmed === '#') return false;
    if (trimmed.toLowerCase().startsWith('javascript:')) return false;
    return true;
}

/**
 * A matched element isn't always the one carrying the href - e.g. an older
 * saved selector might point at a <span> of text inside the real <a>, or at
 * a wrapping <li> around it. Rescue those by checking the element itself,
 * then its nearest linked ancestor, then its nearest linked descendant.
 */
export function resolveHref(el: Element): string | null {
    const own = el.getAttribute('href');
    if (isRealHref(own)) return own;

    const ancestorLink = el.closest('a[href]');
    const ancestorHref = ancestorLink?.getAttribute('href') ?? null;
    if (isRealHref(ancestorHref)) return ancestorHref;

    const descendantLink = el.querySelector('a[href]');
    const descendantHref = descendantLink?.getAttribute('href') ?? null;
    if (isRealHref(descendantHref)) return descendantHref;

    return null;
}
