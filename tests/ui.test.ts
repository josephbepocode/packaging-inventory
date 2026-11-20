// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORAGE_KEY } from '../src/storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const go = (hash: string) => { location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); };
const submit = (sel: string, values: Record<string, string>) => {
  const f = document.querySelector<HTMLFormElement>(sel)!;
  for (const [k, v] of Object.entries(values)) (f.elements.namedItem(k) as HTMLInputElement).value = v;
  f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

beforeAll(async () => {
  localStorage.clear();
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '');
  await import('../src/main');
});

describe('packaging inventory page', () => {
  it('renders the dashboard from seeded data and saves it', () => {
    expect(document.querySelectorAll('#view-dashboard .stat')).toHaveLength(8);
    expect($('view-dashboard').textContent).toContain('Items on count hold');
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();
  });

  it('refuses changes until the user signs their name', () => {
    go('#settings');
    submit('[data-form="tolerance"]', { qty: '3', price: '1' });
    expect($('msg').textContent).toMatch(/User name/);
    $<HTMLInputElement>('user').value = 'Deji';
    submit('[data-form="tolerance"]', { qty: '3', price: '1' });
    expect($('msg').textContent).toBe('Tolerance saved.');
  });

  it('blocks a shipment of held stock through the UI with a clear message', () => {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const hold = state.holds.find((h: { resolved: boolean }) => !h.resolved);
    go('#stock');
    const f = document.querySelector<HTMLFormElement>('[data-form="ship"]')!;
    (f.elements.namedItem('bin') as HTMLSelectElement).value = hold.binId;
    (f.elements.namedItem('sku') as HTMLSelectElement).value = hold.skuId;
    submit('[data-form="ship"]', { q_pc: '1', ref: 'Run 99' });
    expect($('msg').textContent).toMatch(/count hold/);
    expect($('msg').className).toContain('bad');
  });

  it('runs a blind count with typed scans and shows no system quantity', () => {
    go('#counts');
    const btn = document.querySelector<HTMLButtonElement>('[data-form="count-adhoc"] button')!;
    const sel = document.querySelector<HTMLSelectElement>('[data-form="count-adhoc"] select')!;
    sel.value = 'TOR-B-06';
    btn.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect($('view-counts').textContent).toContain('Counting TOR-B-06');
    expect($('view-counts').textContent).not.toContain('Count holds'); // blind: no system figures while counting
    submit('[data-form="scan"]', { code: 'NOPE-123' });
    expect($('scan-msg').textContent).toMatch(/not a known bin or pallet/);
    submit('[data-form="scan"]', { code: 'tor-b-06\r\n' });
    expect($('view-counts').textContent).toContain('bin confirmed');
    const submitBtn = document.querySelector<HTMLButtonElement>('[data-action="submit-count"]')!;
    expect(submitBtn.disabled).toBe(false);
    submitBtn.click();
    expect($('msg').textContent).toMatch(/Count submitted/);
  });

  it('shows the audit log with a passing integrity check and CSV buttons', () => {
    go('#audit');
    expect($('view-audit').textContent).toContain('Integrity check passed');
    expect(document.querySelectorAll('[data-export]')).toHaveLength(4);
    expect($('view-audit').textContent).toContain('settings.tolerance');
  });
});
