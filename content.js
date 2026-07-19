(function () {
  'use strict';

  /* ============================================================
     CONFIG
     ============================================================ */
  const DEBOUNCE_MS   = 300;
  const TEXT_CHARS     = 80;
  const STORAGE_KEY   = 'gts_data';
  const INJECTED_ATTR = 'data-gts-injected';

  /* ============================================================
     SITE DETECTION
     ============================================================ */
  const h = location.hostname;
  let SITE = null;

  if (h.includes('gemini.google.com')) {
    SITE = {
      id: 'gemini',
      getChatId() {
        const m = location.pathname.match(/\/app\/([^/?]+)/);
        return m ? m[1] : '';
      },
      getMessageGroups() {
        const groups = [];
        const turns = document.querySelectorAll('infinite-scroller > div');
        for (const turn of turns) {
          const userEl  = turn.querySelector('user-query') || turn.querySelector('[class*="user-query"]');
          const modelEl = turn.querySelector('model-response') || turn.querySelector('model-response message-content') || turn.querySelector('[class*="model-response"]');
          if (userEl) {
            groups.push({ role: 'user',  element: userEl,  container: turn });
          }
          if (modelEl) {
            groups.push({ role: 'model', element: modelEl, container: turn });
          }
        }
        return groups;
      },
    };
  } else if (h.includes('perplexity.ai')) {
    SITE = {
      id: 'perplexity',
      getChatId() {
        const m = location.pathname.match(/\/search\/([^/?]+)/);
        return m ? m[1] : 'home';
      },
      getMessageGroups() {
        const groups = [];
        const queries   = document.querySelectorAll('span.select-text');
        const responses = document.querySelectorAll('div[id^="markdown-content-"]');

        for (const q of queries) {
          const container = findTurnParent(q, 'span.select-text');
          groups.push({ role: 'user',  element: q, container });
        }
        for (const r of responses) {
          const container = findTurnParent(r, 'div[id^="markdown-content-"]');
          groups.push({ role: 'model', element: r, container });
        }

        // Sort by DOM order for consistent key generation
        groups.sort((a, b) => {
          const pos = a.element.compareDocumentPosition(b.element);
          return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
        });

        return groups;
      },
    };
  }

  if (!SITE) return; // Not a supported site

  /** For Perplexity: find the closest ancestor that acts as the "turn" container.
   *  Walk up until we find a parent that doesn't contain OTHER messages of the same type. */
  function findTurnParent(el, selector) {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const siblings = parent.querySelectorAll(selector);
      if (siblings.length === 1) return parent;
      // If there are multiple, check if THIS element is the only direct child match
      // in the immediate children (not deeply nested)
      const directMatches = Array.from(parent.children).filter(
        c => c.matches(selector) || c.querySelector(selector)
      );
      if (directMatches.length <= 1) return parent;
      parent = parent.parentElement;
    }
    // Fallback: use the element's own parent
    return el.parentElement || el;
  }

  /* ============================================================
     STATE
     ============================================================ */
  let cache = {};
  let debounceTimer = null;
  let lastUrl = '';

  /* ============================================================
     UTILITIES
     ============================================================ */

  function fnv1a(str) {
    let h2 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h2 ^= str.charCodeAt(i);
      h2  = Math.imul(h2, 0x01000193);
    }
    return (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function fmt(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
         + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function makeKey(cid, role, text, occurrence) {
    const prefix = text.substring(0, TEXT_CHARS);
    return cid + '::' + role + '::' + fnv1a(prefix) + '::' + occurrence;
  }

  /* ============================================================
     STORAGE
     ============================================================ */

  function loadStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (r) => {
        cache = r[STORAGE_KEY] || {};
        resolve();
      });
    });
  }

  function save(key, data) {
    cache[key] = data;
    chrome.storage.local.set({ [STORAGE_KEY]: cache });
  }

  /* ============================================================
     INJECT
     ============================================================ */

  function injectBefore(el, container, timeStr) {
    // For Perplexity: the container from findTurnParent may still be visually
    // inside the bubble. Walk up until we find a parent that looks like a
    // turn-level container (the element's path to root has no sibling divs).
    let parent = container || el.parentElement;
    if (SITE.id === 'perplexity') {
      parent = findOuterContainer(el);
    }
    // Check if a timestamp already exists as first child
    if (parent.firstElementChild && parent.firstElementChild.classList &&
        parent.firstElementChild.classList.contains('gts-timestamp')) return;

    const ts = document.createElement('div');
    ts.className   = 'gts-timestamp';
    ts.textContent = timeStr;
    parent.insertBefore(ts, parent.firstChild);
  }

  /** Walk up from el until we find a parent where the path-element has no siblings.
   *  This gives us the outermost "single-message" container. */
  function findOuterContainer(el) {
    let child = el;
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      // If parent has only one child (or one meaningful child), we've found the boundary
      if (parent.children.length <= 1) {
        child = parent;
        parent = parent.parentElement;
        continue;
      }
      // If parent has multiple children, the previous container was the right one
      break;
    }
    return child;
  }

  /* ============================================================
     MAIN SCAN
     ============================================================ */

  async function scan() {
    const cid = SITE.getChatId();
    if (!cid) return;

    const groups = SITE.getMessageGroups();

    // Track per-role occurrence count for duplicate message disambiguation
    const counters = {};

    for (const group of groups) {
      const el = group.element;

      // Skip if already injected on THIS element
      if (el.hasAttribute(INJECTED_ATTR)) continue;

      const text = (el.textContent || '').trim();
      if (!text) continue;

      // Increment counter for this role
      counters[group.role] = (counters[group.role] || 0) + 1;
      const occurrence = counters[group.role];

      const key = makeKey(cid, group.role, text, occurrence);

      let timeStr;
      if (cache[key]) {
        timeStr = cache[key].t;
      } else {
        timeStr = fmt(new Date());
        save(key, { t: timeStr, r: group.role });
      }

      injectBefore(el, group.container, timeStr);
      el.setAttribute(INJECTED_ATTR, '1');
    }
  }

  function debouncedScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, DEBOUNCE_MS);
  }

  /* ============================================================
     SPA NAVIGATION
     ============================================================ */

  function checkUrlChange() {
    const cur = location.href;
    if (cur !== lastUrl) {
      lastUrl = cur;
      setTimeout(debouncedScan, 200);
    }
  }

  /* ============================================================
     DEBUG  (run window.__gts_debug() in console)
     ============================================================ */

  function debug() {
    console.group('[GTS] Debug — ' + SITE.id);
    console.log('URL:', location.href);
    console.log('Chat ID:', SITE.getChatId());
    console.log('Storage entries:', Object.keys(cache).length);

    const groups = SITE.getMessageGroups();
    console.log('Message groups found:', groups.length);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const text = (g.element.textContent || '').trim().substring(0, 60);
      const injected = g.element.hasAttribute(INJECTED_ATTR);
      console.log('  [' + i + '] role=' + g.role + ' injected=' + injected + ' text="' + text + '…"');
    }

    if (SITE.id === 'perplexity') {
      const queries   = document.querySelectorAll('span.select-text');
      const responses = document.querySelectorAll('div[id^="markdown-content-"]');
      console.log('span.select-text found:', queries.length);
      console.log('div[id^="markdown-content-"] found:', responses.length);

      // Also show broader search
      const prose = document.querySelectorAll('.prose');
      console.log('.prose found:', prose.length);
    }

    if (SITE.id === 'gemini') {
      const userQ  = document.querySelectorAll('user-query');
      const modelR = document.querySelectorAll('model-response');
      const turns  = document.querySelectorAll('infinite-scroller > div');
      console.log('user-query found:', userQ.length);
      console.log('model-response found:', modelR.length);
      console.log('infinite-scroller > div found:', turns.length);

      if (turns.length > 0) {
        for (let i = 0; i < Math.min(turns.length, 3); i++) {
          const t = turns[i];
          const children = Array.from(t.children).map(c => c.tagName);
          console.log('  turn[' + i + '] children:', children);
        }
      }
    }

    console.groupEnd();
    return 'Debug output in console.';
  }

  window.__gts_debug = debug;

  /* ============================================================
     BOOT
     ============================================================ */

  async function init() {
    await loadStorage();

    const obs = new MutationObserver(debouncedScan);
    obs.observe(document.body, { childList: true, subtree: true });

    const urlObs = new MutationObserver(checkUrlChange);
    urlObs.observe(document, { subtree: true, childList: true });
    window.addEventListener('popstate', debouncedScan);

    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      history[fn] = function () {
        orig.apply(this, arguments);
        checkUrlChange();
      };
    }

    lastUrl = location.href;
    setTimeout(scan, 500);
  }

  init();
})();
