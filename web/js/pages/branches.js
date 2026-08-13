/** Branches — multi-branch organisation (entitlement gated). */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, toast, presentError, modal, field, input, iconEl, fmtNum } from '../ui.js';

export async function render(el) {
  let rows = [];
  const bodyEl = h('div', {});

  async function load() {
    try { rows = await api.get('/api/v1/branches'); paint(); } catch (e) { presentError(e); }
  }
  function paint() {
    bodyEl.replaceChildren(
      h('div', { class: 'card' }, table([
        { label: 'Code', render: r => h('span', { class: 'mono badge-soft' }, r.code) },
        { label: 'Branch', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub' }, r.address || '—')) },
        { label: 'Phone', render: r => h('span', { class: 'tiny mono' }, r.phone || '—') },
        { label: 'Warehouses', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.warehouses ?? 0)) },
        { label: 'Status', render: r => pill(r.is_active ? 'ACTIVE' : 'DISABLED') },
      ], rows, { emptyTitle: 'No branches', ico: 'branches' })));
  }

  function newBranch() {
    const code = input({ placeholder: 'THK' });
    const name = input({ placeholder: 'Thika Branch' });
    const addr = input({ placeholder: 'Address' });
    const submit = btn('Create branch', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!code.value.trim() || !name.value.trim()) return toast.warn('Code and name required');
      try {
        await api.post('/api/v1/branches', { code: code.value.trim(), name: name.value.trim(), address: addr.value || undefined });
        toast.ok('Branch created', name.value.trim());
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e); }
    });
    modal({ title: 'New branch', ico: 'branches', width: 'narrow', body: h('div', {}, h('div', { class: 'form-row' }, field('CODE', code), field('NAME', name)), field('ADDRESS', addr)), foot: h('div', { class: 'right' }, submit) });
  }

  el.replaceChildren(
    pageHead('Branches', 'Locations roll up to one tenant truth',
      store.can('branches.manage') ? btn('New branch', { cls: 'primary', ico: 'plus', onClick: newBranch }) : null),
    bodyEl);
  await load();
}
