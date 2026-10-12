// Console theme, for every page: 'system' follows the OS (no data-theme on <html>); 'light' or 'dark' is set as
// <html data-theme> and wins over the OS. The choice is kept in localStorage; without storage the console follows the OS.
// A classic script loaded synchronously in <head> (the CSP forbids inline scripts), so the stored choice is applied before
// first paint. A classic script cannot export, so the theme button reaches current() and choose() through window.bridgeTheme.
(() => {
  const key = 'herdr-bridge-theme';
  const root = document.documentElement;
  const explicit = (theme) => theme === 'light' || theme === 'dark';

  function apply(theme) {
    if (explicit(theme)) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  function stored() {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  window.bridgeTheme = {
    // The choice applied to this page: light | dark | system.
    current() {
      const theme = root.getAttribute('data-theme');
      return explicit(theme) ? theme : 'system';
    },
    // Applies a choice and stores it; 'system' drops the stored one. When storage fails the choice lasts until the page reloads.
    choose(theme) {
      apply(theme);
      try {
        if (explicit(theme)) localStorage.setItem(key, theme);
        else localStorage.removeItem(key);
      } catch {
        // Storage is blocked or full.
      }
    },
  };

  apply(stored());
})();
