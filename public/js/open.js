// open.html: shows the spinner (turning the way the comic reads, ?dir=rtl
// counterclockwise), then replaces itself with ?to= - so Back from the
// reader doesn't land here again. Only a notification's own reader address
// is followed; anything else goes to the home page rather than letting a
// crafted link send someone off-site.
(() => {
    const params = new URLSearchParams(location.search);
    const to = params.get('to') || '';
    if (params.get('dir') === 'rtl') document.querySelector('.page-loading').classList.add('rtl');
    // After the spinner's first frame is on screen: the browser keeps
    // showing this page until the reader answers.
    requestAnimationFrame(() => setTimeout(() => {
        location.replace(/^\/reader\/\d+\/open\/[a-z]+$/.test(to) ? to : '/');
    }, 0));
})();
