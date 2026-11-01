import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { matchElementByFingerprint, resolveHref } from './matchSelector';
import { SelectorFingerprint } from '../types';

function makeDoc(html: string): Document {
    return new JSDOM(html).window.document;
}

test('matches the exact selector when it still exists', () => {
    const doc = makeDoc('<div><img id="strip" src="a.png"></div>');
    const fingerprint: SelectorFingerprint = {
        selector: '#strip', tag: 'img', classes: [], parentTag: 'div', siblingTags: []
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el?.getAttribute('src'), 'a.png');
});

test('falls back to tag+text scoring when the exact selector no longer matches anything', () => {
    // Simulates a site markup change: the recorded "#gone" id is no longer
    // present, so it must fall back to scoring every <a> against the rest
    // of the fingerprint (parentTag/siblingTags/text) to find "Next".
    const doc = makeDoc(`
        <ul>
          <li><a href="/1">First</a></li>
          <li><a href="/2">Previous</a></li>
          <li><a href="/3">Next</a></li>
        </ul>
    `);
    const fingerprint: SelectorFingerprint = {
        selector: '#gone', tag: 'a', classes: [], parentTag: 'li', siblingTags: ['li'], text: 'Next'
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el?.getAttribute('href'), '/3');
});

test('ambiguous selector matching every anchor is disambiguated by text score', () => {
    // This is the exact shape of real, already-stored production data:
    // selector "a" matches every link on the page.
    const doc = makeDoc(`
        <div id="sidebar"><a href="/other">Some other link</a></div>
        <ul id="nav">
          <li><a href="/1">First</a></li>
          <li><a href="/2">Previous</a></li>
          <li><a href="/3">Next</a></li>
          <li><a href="/4">Latest</a></li>
        </ul>
    `);
    const fingerprint: SelectorFingerprint = {
        selector: 'a', tag: 'a', classes: [], parentTag: 'li', siblingTags: ['li'], text: 'Latest'
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el?.getAttribute('href'), '/4');
});

test('invalid CSS selector syntax does not throw and still falls back', () => {
    const doc = makeDoc('<div><a href="/ok">Next</a></div>');
    const fingerprint: SelectorFingerprint = {
        selector: 'a[href=unquoted space]', // invalid CSS - querySelectorAll would throw
        tag: 'a', classes: [], parentTag: 'div', siblingTags: [], text: 'Next'
    };

    assert.doesNotThrow(() => matchElementByFingerprint(fingerprint, doc));
    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el?.getAttribute('href'), '/ok');
});

test('returns null when nothing matches at all', () => {
    const doc = makeDoc('<div></div>');
    const fingerprint: SelectorFingerprint = {
        selector: '.missing', tag: 'span', classes: [], parentTag: '', siblingTags: []
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el, null);
});

test('resolveHref uses the element\'s own href when it has one', () => {
    const doc = makeDoc('<a id="a" href="/direct">Next</a>');
    assert.equal(resolveHref(doc.getElementById('a')!), '/direct');
});

test('resolveHref rescues a click that landed on a wrapping <li> around the real <a>', () => {
    // This is the exact shape of real, already-stored production data: an
    // old selection captured the <li>, which has no href of its own.
    const doc = makeDoc('<li id="li"><a href="/from-child">Next</a></li>');
    assert.equal(resolveHref(doc.getElementById('li')!), '/from-child');
});

test('resolveHref rescues a click that landed on a <span> of text inside the real <a>', () => {
    // A selection that captured a <span class="nav-label"> inside the actual
    // link instead of the link itself.
    const doc = makeDoc('<a href="/from-parent"><span id="span">Next</span></a>');
    assert.equal(resolveHref(doc.getElementById('span')!), '/from-parent');
});

test('resolveHref returns null for a genuinely disabled/link-less element', () => {
    const doc = makeDoc('<div id="disabled" class="nav-next-disabled"></div>');
    assert.equal(resolveHref(doc.getElementById('disabled')!), null);
});

test('resolveHref treats a "#" placeholder href as no link at all', () => {
    // A comic's own "Next"/"Latest" can render as a live
    // <a href="#" style="pointer-events:none"> when there is no next page.
    // "#" would resolve to the same page and store it again as a "new" page
    // on every Next, so it must count as no link at all.
    const doc = makeDoc('<a id="a" href="#" style="pointer-events:none">Next</a>');
    assert.equal(resolveHref(doc.getElementById('a')!), null);
});

test('resolveHref keeps looking past a disabled ancestor link for a real descendant link', () => {
    const doc = makeDoc('<a href="#"><span id="span">Next</span></a>');
    assert.equal(resolveHref(doc.getElementById('span')!), null);
});

test('bestMatch picks either one of a genuine tie when both won on specific signal', () => {
    // A site that renders its nav twice (a desktop bar and a duplicate for
    // the mobile layout) - both "Previous" links tie on every score
    // component, including a real text match. Unlike the no-signal
    // hamburger-icon tie, this one is safe to resolve (either copy points to
    // the same URL) - refusing to guess would break every such site.
    const doc = makeDoc(`
        <ul id="mobile-nav"><li><a href="/2">Previous</a></li></ul>
        <ul id="nav"><li><a href="/2">Previous</a></li></ul>
    `);
    const fingerprint: SelectorFingerprint = {
        selector: 'a', tag: 'a', classes: [], parentTag: 'li', siblingTags: ['a'], text: 'Previous'
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el?.getAttribute('href'), '/2');
});

test('bestMatch refuses to guess between tied candidates with no distinguishing signal', () => {
    // An image selector with no id/class anywhere in its ancestry falls back
    // to matching every <img> on the page. Here the comic image and a header
    // menu icon have the exact same shape (an <img>, alone, inside an <a>)
    // and tie 3.5 to 3.5 - picking whichever comes first in the DOM would
    // save the menu icon as a comic page.
    const doc = makeDoc(`
        <a class="menu-toggle"><img id="hamburger" src="menu.png"></a>
        <div class="page"><a href="/c/1"><img id="comic" src="strip.png"></a></div>
    `);
    const fingerprint: SelectorFingerprint = {
        selector: 'img', tag: 'img', classes: [], parentTag: 'a', siblingTags: ['img']
    };

    const el = matchElementByFingerprint(fingerprint, doc);
    assert.equal(el, null);
});
