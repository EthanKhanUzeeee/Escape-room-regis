'use strict';
/*
 * The lite version of the public pages, for slow phones and mobile data: no animations, film grain, blur or web fonts.
 * It's on when the visitor picks it, when the link ends in ?lite (share it as /?lite), or when the phone's Data Saver is on.
 * Loaded in <head>, so the web fonts are only fetched for the full version.
 */
(function () {
  const KEY = 'escape-room:lite';
  const FONTS = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&family=Special+Elite&family=Cinzel:wght@700&family=Cormorant+SC:wght@700&family=IM+Fell+English+SC&display=swap';
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const store = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private browsing: the choice lasts for this visit */ } };

  const params = new URLSearchParams(location.search);
  let lite;
  if (params.has('lite')) {
    lite = params.get('lite') !== '0';
    store(lite);
  } else {
    const saved = read();
    lite = saved === null ? !!(navigator.connection && navigator.connection.saveData) : saved === '1';
  }
  root.classList.toggle('lite', lite);

  if (!lite) {
    const add = (attrs) => { const l = document.createElement('link'); Object.assign(l, attrs); document.head.appendChild(l); };
    add({ rel: 'preconnect', href: 'https://fonts.googleapis.com' });
    add({ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' });
    add({ rel: 'stylesheet', href: FONTS });
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const b of document.querySelectorAll('[data-lite-toggle]')) {
      const short = b.dataset.liteToggle === 'short';
      b.textContent = lite ? (short ? 'Full' : 'Switch to the full version') : (short ? 'Lite' : 'Switch to the lite version (faster on slow phones)');
      if (short) {
        // the spoken name starts with the word on the button
        const name = lite ? 'Full version: show the full design' : 'Lite version: a faster, simpler page for slow phones and mobile data';
        b.setAttribute('aria-label', name);
        b.title = name;
      }
      b.addEventListener('click', () => {
        store(!lite);
        // reload so the fonts and effects load (or don't) from the start
        if (params.has('lite')) {
          params.delete('lite');
          const q = params.toString();
          history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
        }
        location.reload();
      });
    }
  });
})();
