// Page navigation goes through these functions so tests can replace them:
// jsdom cannot navigate, and its window.location methods cannot be redefined.
export const assign = (url) => window.location.assign(url);
export const replace = (url) => window.location.replace(url);
export const reload = () => window.location.reload();

// The query string of the current address, and dropping it from the address bar without navigating.
export const query = () => window.location.search;
export const clearQuery = () => window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
