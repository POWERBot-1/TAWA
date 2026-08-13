/** Deliveries — dispatch lifecycle with OTP proof of delivery. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, timeAgo, toast, presentError, drawer, modal, field, input, select, kv, iconEl, timeline, segmented } from '../ui.js';

const FLOW = { PENDING: ['ASSIGNED'], ASSIGNED: ['DISPATCHED'], DISPATCHED: ['IN_TRANSIT'], IN_TRANSIT: [], DELIVERED: [], RETURNED: [] };

export async function render(el) {
  let rows = [], workers = [];
  let status = '';
  const seg = segmented([{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'DELIVERED', label: 'Delivered' }], status, (v) => { status = v; load(); });
  const bodyEl = h('div', {});

  async function load() {
    try {
      rows = await api.get('/api/v1/deliveries', { limit: 100 });
      paint();
    } catch (e) { presentError(e); }
    try { workers = await api.get('/api/v1/workers'); } catch { workers = []; }
  }

  function filtered() {
    if (status === 'active') return rows.filter(r => !['DELIVERED', 'RETURNED', 'CANCELLED'].includes(r.status));
    if (status) return rows.filter(r => r.status === status);
    return rows;
  }

  function paint() {
    bodyEl.replaceChildren(h('div', { class: 'card' }, table([
      { label: 'Delivery', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.order_number || r.id.slice(0, 10)), h('div', { class: 't-sub' }, r.address || '—')) },
      { label: 'Driver', render: r => h('span', { class: 'tiny' }, r.driver_name || '—') },
      { label: 'Vehicle', render: r => h('span', { class: 'tiny mono muted' }, r.vehicle || '—') },
      { label: 'Fee', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.fee)) },
      { label: 'Status', render: r => pill(r.status) },
      { label: 'Updated', render: r => h('span', { class: 'tiny muted' }, timeAgo(r.updated_at)) },
    ], filtered(), { onRow: openDelivery, emptyTitle: 'No deliveries', emptyMsg: 'Create a delivery from a fulfilled order.', ico: 'truck' })));
  }

  function openDelivery(d) {
    const bodyEl = h('div', { class: 'stack' });
    const paintDetail = () => {
      const actions = h('div', { class: 'row wrap' });
      if (d.status === 'PENDING') {
        actions.appendChild(btn('Assign driver', { cls: 'primary sm', ico: 'user', onClick: assignModal }));
      }
      for (const to of (FLOW[d.status] || []).filter(x => x !== 'ASSIGNED')) {
        actions.appendChild(btn(`Mark ${to.toLowerCase().replace('_', ' ')}`, { cls: 'sm', ico: 'truck', onClick: () => advance(to) }));
      }
      if (d.status === 'IN_TRANSIT' || d.status === 'DISPATCHED') {
        actions.appendChild(btn('Complete with OTP', { cls: 'primary sm', ico: 'key', onClick: otpModal }));
        actions.appendChild(btn('Resend OTP', { cls: 'ghost sm', ico: 'sms', onClick: async () => {
          try { await api.post(`/api/v1/deliveries/${d.id}/send-otp`, {}); toast.ok('OTP re-issued', 'Sent to customer phone (sandbox SMS).'); } catch (e) { presentError(e); }
        } }));
      }
      actions.appendChild(btn('Delivery note', { cls: 'ghost sm', ico: 'printer', onClick: openNote }));
      bodyEl.replaceChildren(
        h('div', { class: 'row between wrap' },
          h('div', {}, h('div', { class: 'mono strong', style: { fontSize: 'var(--fs-18)' } }, d.order_number || '—'), h('div', { class: 'tiny muted' }, d.address || '—')),
          pill(d.status)),
        kv([
          ['Driver', d.driver_name || 'Unassigned'],
          ['Vehicle', d.vehicle || '—'],
          ['Fee', fmtMoney(d.fee)],
          ['Proof', d.proof_type ? `${d.proof_type} ${d.proof_ref ? '· ' + d.proof_ref : ''}` : 'Not yet'],
          ['Delivered', d.delivered_at ? fmtDT(d.delivered_at) : '—'],
        ]),
        actions,
        timelineOf(d));
    };
    function timelineOf(d2) {
      const items = [
        { title: 'Created', meta: fmtDT(d2.created_at), tone: 'brand' },
        d2.assigned_at ? { title: `Assigned to ${d2.driver_name || 'driver'}`, meta: fmtDT(d2.assigned_at) } : null,
        d2.dispatched_at ? { title: 'Dispatched', meta: fmtDT(d2.dispatched_at) } : null,
        d2.status === 'IN_TRANSIT' ? { title: 'In transit', meta: 'now' } : null,
        d2.delivered_at ? { title: `Delivered — ${d2.proof_type} verified`, meta: fmtDT(d2.delivered_at), tone: 'ok' } : null,
      ].filter(Boolean);
      return h('div', {}, h('div', { class: 'tiny faint', style: { textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' } }, 'Timeline'), timeline(items));
    }
    async function advance(to) {
      try {
        d = await api.post(`/api/v1/deliveries/${d.id}/advance`, { to });
        toast.ok(`Delivery ${String(to).toLowerCase().replace('_', ' ')}`);
        paintDetail(); load();
      } catch (e) { presentError(e); }
    }
    function assignModal() {
      const drivers = workers.filter(w => ['DRIVER', 'DELIVERY_WORKER'].includes(w.role_title) && w.status === 'ACTIVE');
      const sel = select([{ value: '', label: 'Choose driver…' }, ...drivers.map(w => ({ value: w.id, label: `${w.name} (${w.code})` }))]);
      const submit = btn('Assign', { cls: 'primary', ico: 'user' });
      submit.addEventListener('click', async () => {
        if (!sel.value) return toast.warn('Choose a driver');
        try {
          d = await api.post(`/api/v1/deliveries/${d.id}/assign`, { driver_id: sel.value });
          toast.ok('Driver assigned', 'OTP issued to customer.');
          document.getElementById('overlays').replaceChildren();
          paintDetail(); load();
        } catch (e) { presentError(e); }
      });
      modal({ title: 'Assign driver', ico: 'user', width: 'narrow', body: field('DRIVER', sel, { hint: 'Driver receives the task; customer receives a delivery OTP.' }), foot: h('div', { class: 'right' }, submit) });
    }
    function otpModal() {
      const otp = input({ placeholder: '4-digit code from customer', class: 'input mono', maxLength: 6, inputmode: 'numeric' });
      const submit = btn('Verify & complete', { cls: 'primary', ico: 'approve' });
      submit.addEventListener('click', async () => {
        try {
          d = await api.post(`/api/v1/deliveries/${d.id}/complete`, { otp: otp.value.trim() });
          toast.ok('Delivered', `Proof: ${d.proof_ref || 'OTP verified'}`);
          document.getElementById('overlays').replaceChildren();
          paintDetail(); load();
        } catch (e) { presentError(e, 'OTP rejected'); }
      });
      modal({
        title: 'Proof of delivery', sub: `Order ${d.order_number}`, ico: 'key', width: 'narrow',
        body: h('div', {}, field('CUSTOMER OTP', otp, { hint: 'Ask the customer to read the code they received. Wrong codes are rejected (409).' })),
        foot: h('div', { class: 'right' }, submit),
      });
    }
    async function openNote() {
      const res = await fetch(`/api/v1/deliveries/${d.id}/note`, { headers: { Authorization: `Bearer ${store.session.token}` } });
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    }
    paintDetail();
    drawer({ title: 'Delivery', ico: 'truck', body: bodyEl });
  }

  el.replaceChildren(pageHead('Deliveries', 'Dispatch to doorstep with OTP proof'), seg, bodyEl);
  await load();
}
