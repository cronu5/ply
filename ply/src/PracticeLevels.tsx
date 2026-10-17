import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Loader2, Plus } from 'lucide-react';
import { STOCKFISH_STRENGTH_DOCS } from './engine-strength';
import type { Player } from './types';

const levels = [1320, 1500, 1800, 2000, 2200, 2400, 2600];

async function readPracticeLevels(): Promise<Set<number>> {
  const response = await fetch('/api/state');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not check your existing players.');
  const players: Player[] = Array.isArray(result.players) ? result.players : [];
  return new Set(players.filter(player => player.kind === 'stockfish' && player.targetElo !== undefined && (player.moveTimeMs ?? 1000) === 1000).map(player => player.targetElo!));
}

export default function PracticeLevels({ onAdded }: { onAdded: () => void }) {
  const [targetElo, setTargetElo] = useState(1800);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<number | null>(null);
  const [existing, setExisting] = useState(new Set<number>());
  const [checking, setChecking] = useState(true);
  const alreadyAdded = existing.has(targetElo);
  useEffect(() => {
    let active = true;
    readPracticeLevels().then(value => { if (active) setExisting(value); }).catch(error => { if (active) setError((error as Error).message); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  async function addLevel() {
    setBusy(true); setError(''); setAdded(null);
    try {
      const current = await readPracticeLevels();
      setExisting(current);
      if (current.has(targetElo)) { setAdded(targetElo); return; }
      const response = await fetch('/api/players', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'stockfish', name: `Stockfish · ${targetElo} target`, targetElo, moveTimeMs: 1000 }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not add this practice level.');
      setAdded(targetElo);
      setExisting(previous => new Set([...previous, targetElo]));
      onAdded();
      await readPracticeLevels().then(setExisting).catch(() => {});
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="practice-levels" aria-label="Practice levels">
    <div className="practice-levels-heading"><div><h3>Practice levels</h3><p>Choose a target strength for a new opponent.</p></div><span>INCLUDED STOCKFISH</span></div>
    <div className="practice-level-choices" role="group" aria-label="Practice target strength">{levels.map(level => <button type="button" key={level} aria-pressed={targetElo === level} title={existing.has(level) ? `${level} target is already in your players` : `${level} target`} className={targetElo === level ? 'active' : ''} disabled={busy} onClick={() => { setTargetElo(level); setAdded(null); }}>{level}{existing.has(level) && <Check size={10} aria-hidden="true"/>}</button>)}</div>
    <div className="practice-level-action"><span><strong>≈ {targetElo}</strong><span>target strength · 1 s per move</span></span><button type="button" className="primary-button" onClick={addLevel} disabled={busy || checking || alreadyAdded} title={alreadyAdded ? 'Already in your player list' : undefined}>{busy || checking ? <Loader2 size={15} className="spin"/> : alreadyAdded ? <Check size={15}/> : <Plus size={15}/>} {checking ? 'Checking…' : alreadyAdded ? 'Added' : 'Add level'}</button></div>
    <p className="practice-level-note">Approximate targets, not published benchmarks or FIDE ratings. The per-move budget differs from Stockfish’s calibration.<a href={STOCKFISH_STRENGTH_DOCS} target="_blank" rel="noreferrer">Strength documentation <ArrowUpRight size={11}/></a></p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {added !== null && <p className="practice-level-added" role="status">Stockfish · {added} target is ready in your player list.</p>}
  </section>;
}
