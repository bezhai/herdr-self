// Page navigation goes through these functions so tests can replace them:
// jsdom cannot navigate, and its window.location methods cannot be redefined.
export const assign = (url) => window.location.assign(url);
export const replace = (url) => window.location.replace(url);
export const reload = () => window.location.reload();
