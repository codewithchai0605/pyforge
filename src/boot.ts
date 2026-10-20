/**
 * This is intentionally the *only* thing www/index.html loads directly
 * (see its comments) — everything else the app actually needs gets loaded
 * by this file instead of being hard-coded into the HTML. That's the whole
 * point: index.html is written once and never touched again, even as the
 * real bundle's contents change; only this file (and utils/build/config.ts,
 * which controls the fixed filenames referenced below) needs to agree with
 * the build output.
 *
 * Deliberately has no dependency on the app itself (no editor, no plugins,
 * no xtags import beyond what's needed to build the CSS asset below) —
 * its own job has to work before any of that exists, and keeping it small
 * is also what keeps it a genuinely separate, tiny Rolldown chunk instead
 * of dragging shared code into a second bundle.
 */
import '@/styles/app.css';

function injectStylesheet(href: string): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function injectScript(src: string): void {
  const script = document.createElement('script');
  script.src = src;
  document.body.appendChild(script);
}

// Fixed filenames — see utils/build/config.ts's output section for why
// there's no hash to look up here. `import '@/styles/app.css'` above is
// what makes the css plugin actually emit css/app.css in the first place;
// this is what puts it on the page.
injectStylesheet('css/app.css');
injectScript('js/main.js');
