import { useState, type FormEvent } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import type { Player } from './types';

export const inviteLink = (player:Player) => `${window.location.origin}/join/${player.inviteToken}`;
export const inviteMessage = (player:Player) => `Come play chess with me in PLY, the chess arena on this computer. You're "${player.name}". Read ${inviteLink(player)} (use curl from your shell) and follow the instructions there.`;

export async function copyText(text:string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement('textarea');
  area.value = text; document.body.appendChild(area); area.select();
  const ok = document.execCommand('copy'); area.remove(); return ok;
}

export default function InviteModal({existing,onClose,onCreated,onSeat}:{existing?:Player|null;onClose:()=>void;onCreated:()=>Promise<void>;onSeat:(player:Player,color:'w'|'b')=>void}) {
  const [name,setName]=useState('Claude'); const [player,setPlayer]=useState<Player|null>(existing??null); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [copied,setCopied]=useState(false);
  async function create(e:FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r=await fetch('/api/invites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      const data=await r.json(); if(!r.ok) throw new Error(data.error||'The invite could not be created.');
      setPlayer(data); await onCreated();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() { if(player&&await copyText(inviteMessage(player))){setCopied(true);setTimeout(()=>setCopied(false),1800);} }
  return <div className="modal-backdrop" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label="Invite an AI" onClick={e=>e.stopPropagation()}>
    <button className="modal-close" onClick={onClose} aria-label="Close invite dialog"><X size={20}/></button>
    <span className="eyebrow">INVITE AN AI</span>
    {!player?<><h2>Give it a seat.</h2><p>Claude Code, Codex, or any agent with a shell on this computer can join with a link. It reads the instructions, waits for its turn, and sends moves on its own.</p>
      <form onSubmit={create}><label style={{marginTop:25}}>Player name<input value={name} onChange={e=>setName(e.target.value)} maxLength={60} autoFocus required/><small>The seat stays in your player list, so the same link works for future matches.</small></label>{error&&<div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Check size={16}/>}Create invite</button></div></form></>
    :<><h2>{player.name} is invited.</h2><p>Send this message to your AI. It can start a match itself, or you can seat it here and press Start match.</p>
      <label style={{marginTop:20}}>Invite message<textarea readOnly value={inviteMessage(player)} rows={4} onFocus={e=>e.currentTarget.select()} style={{width:'100%',resize:'none',fontFamily:'inherit',fontSize:13,padding:10}}/><small>Works for any program on this computer. A web-only chat can't reach it.</small></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>onSeat(player,'w')}>Seat as White</button><button type="button" className="secondary-button" onClick={()=>onSeat(player,'b')}>Seat as Black</button><button type="button" className="primary-button" onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>}{copied?'Copied':'Copy message'}</button></div></>}
  </section></div>;
}
