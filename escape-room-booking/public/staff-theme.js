'use strict';
/*
 * Light or dark for the staff dashboard and door scanner: the mode picked with the toggle, otherwise the device setting.
 * Loaded in <head>, before the screen draws, so it never flashes the wrong colours.
 * The public booking pages are always dark and don't load this.
 */
(function () {
  const KEY = 'escape-room:staff-theme';
  const root = document.documentElement;
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const device = () => (darkQuery.matches ? 'dark' : 'light');
  const apply = (theme) => { root.dataset.theme = theme; };

  apply(saved() || device());
  darkQuery.addEventListener('change', () => { if (!saved()) apply(device()); });

  document.addEventListener('DOMContentLoaded', () => {
    const buttons = document.querySelectorAll('[data-theme-toggle]');
    const label = () => {
      for (const b of buttons) b.setAttribute('aria-label', root.dataset.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    };
    label();
    for (const b of buttons) {
      b.addEventListener('click', () => {
        const next = root.dataset.theme === 'light' ? 'dark' : 'light';
        apply(next);
        try { localStorage.setItem(KEY, next); } catch { /* private browsing: the choice lasts until the page closes */ }
        label();
      });
    }
  });
})();
