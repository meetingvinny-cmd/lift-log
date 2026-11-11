// ui/install.js - shown when the app is opened in a browser tab, not from the icon.
// No setting skips this screen. In a tab every route but Install and Phone check comes here.
import { el, glyph } from './dom.js';
import { t } from './strings.js';

function step(n, text, extra) {
  return el('div', { class: 'row' },
    el('span', { class: 'step-no num', 'aria-hidden': 'true' }, String(n)),
    el('span', { class: 'grow' }, text),
    extra || null);
}

export function renderInstall() {
  return el('section', { class: 'screen no-bar', id: 'install' },
    el('p', { class: 'label' }, t('install.title')),
    el('h1', {}, t('install.head')),
    el('p', { class: 'lead' }, t('install.why')),
    el('div', { class: 'card' },
      step(1, t('install.step1'), el('span', { class: 'step-glyph' }, glyph('share'))),
      step(2, t('install.step2')),
      step(3, t('install.step3'))),
    el('p', { class: 'small', id: 'install-addressbar' }, t('install.addressbar')),
    el('p', {}, el('span', { class: 'pill pill-info' }, t('install.tab'))),
    el('a', { class: 'btn btn-secondary', href: '#/check', id: 'run-check-here' }, t('install.check')));
}
