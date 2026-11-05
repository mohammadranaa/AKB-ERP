// Small forms for adding customers and stock locations, used from the OG screen and the masters screens.
import { useState } from 'react';
import { api } from '../lib/api';
import { uuid } from '../lib/uuid';
import { Dialog, Field, FormError, useApi } from './ui';

export type SourceKind = 'store' | 'company_site' | 'amanat' | 'dealer';

/** Where goods are collected from. "store" covers AKB's own godowns. */
export const SOURCES: [SourceKind, string][] = [
  ['store', 'AKB store'],
  ['company_site', 'Company warehouse / plant'],
  ['amanat', 'Customer warehouse (amanat)'],
  ['dealer', 'Trading (from a dealer)']
];

export const KIND_LABEL: Record<string, string> = {
  godown: 'AKB store',
  office: 'AKB office',
  sale_point: 'AKB sale point',
  company_site: 'Company warehouse / plant',
  amanat: 'Customer warehouse (amanat)',
  dealer: 'Trading dealer'
};

export const sourceOf = (kind: string): SourceKind =>
  kind === 'company_site' || kind === 'amanat' || kind === 'dealer' ? kind : 'store';

export function NewCustomerDialog({ onClose, onCreated, initialName }: { onClose: () => void; onCreated: (c: { id: number; code: string }) => void; initialName?: string }) {
  const [f, setF] = useState({ nameEn: initialName ?? '', nameUr: '', city: '', phone: '', taxNo: '', creditLimit: '0', creditDays: '30' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(uuid);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title="New customer" onClose={onClose}>
      <div className="small muted">The customer code is given automatically. Customers you add are assigned to you.</div>
      <div className="form-grid">
        <Field label="Name (English)"><input className="input" value={f.nameEn} onChange={set('nameEn')} autoFocus /></Field>
        <Field label="Name (Urdu, optional)"><input className="input urdu" dir="rtl" value={f.nameUr} onChange={set('nameUr')} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="Phone"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="NTN / CNIC (optional)"><input className="input" value={f.taxNo} onChange={set('taxNo')} /></Field>
        <Field label="Credit limit (Rs)" hint="0 means cash only"><input className="input num" inputMode="decimal" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Credit days"><input className="input num" inputMode="numeric" value={f.creditDays} onChange={(e) => setF({ ...f, creditDays: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || f.nameEn.trim().length < 2 || !f.city.trim()} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await api.post<{ id: number; code: string }>('/api/parties', {
              kind: 'customer', nameEn: f.nameEn.trim(), nameUr: f.nameUr || null, city: f.city.trim(), phone: f.phone || null,
              taxNo: f.taxNo || null, creditLimit: f.creditLimit || '0', creditDays: Number(f.creditDays) || 0
            }, key);
            onCreated(r);
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Add customer</button>
      </div>
    </Dialog>
  );
}

/** Add a company warehouse/plant, a customer warehouse (amanat) or a trading dealer. */
export function NewLocationDialog({ kind, defaultPartyId, onClose, onCreated }: {
  kind: Exclude<SourceKind, 'store'> | 'godown'; defaultPartyId?: number; onClose: () => void; onCreated: (l: { id: number; code: string; name: string }) => void;
}) {
  const parties = useApi(async () => kind === 'godown' ? [] : api.get(kind === 'amanat' ? '/api/parties?kind=customer&active=true' : kind === 'company_site' ? '/api/parties?kind=supplier&active=true' : '/api/parties?active=true'), [kind]);
  const [partyId, setPartyId] = useState<number | ''>(defaultPartyId ?? '');
  const [nameEn, setName] = useState('');
  const [city, setCity] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(uuid);
  const title = kind === 'godown' ? 'New AKB store' : kind === 'company_site' ? 'New company warehouse / plant' : kind === 'amanat' ? 'New customer warehouse (amanat)' : 'New trading dealer';
  const needsParty = kind === 'amanat' || kind === 'dealer';
  const needsName = kind === 'company_site' || kind === 'godown';
  const choices = (parties.data ?? []).filter((p: any) => kind !== 'dealer' || ['customer', 'supplier', 'other'].includes(p.kind));
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="small muted">
        {kind === 'godown' && 'A godown or store run by AKB.'}
        {kind === 'company_site' && 'Stock AKB has bought that is still at the company warehouse or plant.'}
        {kind === 'amanat' && 'AKB stock kept at a customer\'s warehouse. Distribution keeps the count.'}
        {kind === 'dealer' && 'Goods bought from another dealer and sold on. AKB keeps no stock count for these.'}
      </div>
      <div className="form-grid">
        {kind !== 'godown' && <Field label={kind === 'amanat' ? 'Customer' : kind === 'dealer' ? 'Dealer' : 'Company (optional)'}>
          <select className="input" value={partyId} onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{needsParty ? 'Choose…' : '—'}</option>
            {choices.map((p: any) => <option key={p.id} value={p.id}>{p.name_en}{p.city ? `, ${p.city}` : ''}</option>)}
          </select>
        </Field>}
        <Field label={needsName ? 'Name' : 'Name (optional)'} hint={kind === 'company_site' ? 'e.g. Engro Daharki Plant' : kind === 'godown' ? 'e.g. Sahiwal godown' : 'Leave blank to use the party\'s name'}>
          <input className="input" value={nameEn} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="City (optional)"><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || (needsParty && !partyId) || (needsName && nameEn.trim().length < 2)} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await api.post<{ id: number; code: string; name: string }>('/api/locations', {
              kind, partyId: partyId || null, nameEn: nameEn.trim() || undefined, city: city.trim() || null
            }, key);
            onCreated(r);
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Add</button>
      </div>
    </Dialog>
  );
}
