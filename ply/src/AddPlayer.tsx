import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, Cpu, Download, Loader2, Plus, Radio, Search, Sparkles, UserRound, X } from 'lucide-react';
import type { PlayerKind } from './types';
import { moveBudgetLabel, STOCKFISH_STRENGTH_DOCS, STOCKFISH_TARGET_MAX, STOCKFISH_TARGET_MIN } from './engine-strength';

type Provider = 'deepinfra' | 'openai' | 'anthropic' | 'compatible' | 'ollama';
type ModelOption = { id: string; name: string };
const presets: Record<Provider, { label: string; url: string; kind: PlayerKind }> = {
  deepinfra: { label: 'DeepInfra', url: 'https://api.deepinfra.com/v1/openai', kind: 'openai' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', kind: 'openai' },
  anthropic: { label: 'Anthropic / Claude', url: 'https://api.anthropic.com/v1', kind: 'anthropic' },
  compatible: { label: 'Other compatible API', url: 'http://127.0.0.1:1234/v1', kind: 'openai' },
  ollama: { label: 'Ollama', url: 'http://127.0.0.1:11434', kind: 'ollama' },
};
async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch('/api' + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not connect.');
  return value;
}

export default function AddPlayer({ onClose, onAdded, onEngines }: { onClose: () => void; onAdded: () => void; onEngines: () => void }) {
  const [kind, setKind] = useState<PlayerKind>('ollama');
  const [provider, setProvider] = useState<Provider>('ollama');
  const [baseUrl, setBaseUrl] = useState(presets.ollama.url);
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState(10);
  const [strengthMode, setStrengthMode] = useState<'target' | 'depth'>('target');
  const [targetElo, setTargetElo] = useState(1800);
  const [moveTimeMs, setMoveTimeMs] = useState(1000);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const isModel = ['ollama', 'openai', 'anthropic'].includes(kind);
  const isApi = kind === 'openai' || kind === 'anthropic';

  function chooseProvider(next: Provider) {
    setProvider(next); setKind(presets[next].kind); setBaseUrl(presets[next].url);
    setModel(''); setModels([]); setSelected([]); setQuery(''); setError(''); setMessage(''); setApiKey('');
  }
  function chooseKind(next: PlayerKind) {
    if (next === 'ollama') chooseProvider('ollama');
    else if (next === 'openai') chooseProvider('deepinfra');
    else { setKind(next); if (next === 'stockfish') setStrengthMode('target'); setError(''); setMessage(''); }
  }
  async function discover() {
    setDiscovering(true); setError(''); setMessage('');
    try {
      const result = await post<{ models: ModelOption[]; baseUrl: string }>('/models/discover', { provider, baseUrl, apiKey });
      setModels(result.models); setSelected([]); setModel('');
      if (!result.models.length) setMessage('Connected, but no models were listed. You can enter a model ID manually.');
    } catch (e) { setError((e as Error).message); }
    finally { setDiscovering(false); }
  }
  function toggle(id: string) { setSelected(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]); }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    const choices = isModel ? selected.length ? selected : [model.trim()] : [''];
    if (isModel && !choices[0]) { setError('Choose a model or enter its exact model ID.'); setBusy(false); return; }
    const added: string[] = [];
    try {
      for (const id of choices) {
        const display = models.find(m => m.id === id)?.name || id;
        const strengthTarget = kind === 'stockfish' && strengthMode === 'target';
        const playerName = choices.length === 1 && name.trim() ? name.trim() : isModel ? display.split('/').pop() || display : kind === 'stockfish' ? strengthTarget ? `Stockfish · ${targetElo} target` : `Stockfish 18 · depth ${depth}` : kind === 'human' ? name.trim() || 'Human' : name.trim() || 'UCI engine';
        await post('/players', { name: playerName.slice(0, 60), kind, model: id, baseUrl, apiKey, command, ...(strengthTarget ? { targetElo, moveTimeMs } : { depth, skill: 20 }) });
        added.push(id);
      }
      onAdded();
    } catch (e) {
      if (added.length) { setSelected(list => list.filter(id => !added.includes(id))); setMessage(`${added.length} player${added.length === 1 ? '' : 's'} added. Remaining selections are ready to retry.`); }
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  useEffect(() => { const listener = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose, busy]);
  const filtered = models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <section className="modal player-modal" role="dialog" aria-modal="true" aria-label="Add a player" onClick={e => e.stopPropagation()}>
      <button className="modal-close" onClick={onClose} disabled={busy} aria-label="Close add player"><X size={20}/></button>
      <span className="eyebrow">NEW PLAYER</span><h2>Add a player.</h2><p>Choose a model, an engine, or a human.</p>
      <div className="provider-tabs">
        {([{ id: 'ollama', label: 'Ollama', icon: Bot }, { id: 'openai', label: 'API model', icon: Sparkles }, { id: 'stockfish', label: 'Engine', icon: Cpu }, { id: 'human', label: 'Human', icon: UserRound }] as const).map(item => <button key={item.id} className={(kind === item.id || item.id === 'openai' && kind === 'anthropic' || item.id === 'stockfish' && kind === 'uci') ? 'active' : ''} onClick={() => chooseKind(item.id)} disabled={busy}><item.icon size={18}/>{item.label}</button>)}
      </div>
      <form onSubmit={submit}>
        {isApi && <label>Provider<select value={provider} onChange={e => chooseProvider(e.target.value as Provider)}><option value="deepinfra">DeepInfra</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic / Claude</option><option value="compatible">Other compatible API · LM Studio, other providers</option></select></label>}
        {(kind === 'ollama' || isApi && provider === 'compatible') && <label>Server address<input required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} spellCheck={false}/></label>}
        {isApi && <label>API key <span className="optional">session only</span><input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste your provider API key" autoComplete="off"/><small>Used by the local server. Reconnect after closing the app.</small></label>}
        {isModel && <>
          <button type="button" className="secondary-button discover-button" onClick={discover} disabled={discovering || busy}>{discovering ? <Loader2 size={16} className="spin"/> : <Radio size={16}/>} {kind === 'ollama' ? 'Discover installed models' : 'Load available models'}</button>
          {!!models.length && <div className="model-picker"><div className="model-search"><Search size={15}/><input aria-label="Search models" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${models.length} models…`}/><span>{selected.length} selected</span></div><div className="model-options">{filtered.length ? filtered.map(item => <label className={`model-option ${selected.includes(item.id) ? 'checked' : ''}`} key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)}/><span><strong>{item.name}</strong>{item.id !== item.name && <small>{item.id}</small>}</span></label>) : <p>No matching models.</p>}</div></div>}
          {!selected.length && <label>{models.length ? 'Or enter a model ID' : 'Model ID'} <span className="optional">{selected.length ? 'optional' : 'exact identifier'}</span><input value={model} onChange={e => { setModel(e.target.value); if (e.target.value) setSelected([]); }} placeholder={kind === 'ollama' ? 'e.g. qwen3.5:4b' : 'e.g. provider/model-name'} spellCheck={false}/></label>}
        </>}
        {(kind === 'stockfish' || kind === 'uci') && <><button type="button" className="engine-library-link" onClick={onEngines}><Download size={18}/><span><strong>Free engine library</strong><small>Practice levels and free chess engines</small></span><ChevronDown size={16}/></button><label>Engine<select value={kind} onChange={e => setKind(e.target.value as PlayerKind)}><option value="stockfish">Included Stockfish 18</option><option value="uci">Custom UCI executable</option></select></label></>}
        {kind === 'stockfish' && <div className="strength-mode" role="group" aria-label="Stockfish strength mode"><button type="button" aria-pressed={strengthMode === 'target'} className={strengthMode === 'target' ? 'active' : ''} onClick={() => setStrengthMode('target')}>Target strength</button><button type="button" aria-pressed={strengthMode === 'depth'} className={strengthMode === 'depth' ? 'active' : ''} onClick={() => setStrengthMode('depth')}>Full / depth</button></div>}
        {kind === 'stockfish' && strengthMode === 'target' && <div className="strength-target-settings"><label>Target strength <strong className="range-value">≈ {targetElo}</strong><input type="range" aria-label="Target strength" min={STOCKFISH_TARGET_MIN} max={STOCKFISH_TARGET_MAX} step="10" value={targetElo} onChange={e => setTargetElo(Number(e.target.value))}/><span className="strength-range-endpoints"><span>{STOCKFISH_TARGET_MIN}</span><span>{STOCKFISH_TARGET_MAX}</span></span></label><label>Time per move <strong className="range-value">{moveBudgetLabel(moveTimeMs)}</strong><input type="range" aria-label="Time per move" min="100" max="5000" step="100" value={moveTimeMs} onChange={e => setMoveTimeMs(Number(e.target.value))}/><small>Each move gets up to this much thinking time.</small></label><p className="strength-target-caveat">An approximate Stockfish setting, not a published benchmark or FIDE rating. PLY’s per-move budget differs from the calibration time control. Arena Elo starts at your target.<a href={STOCKFISH_STRENGTH_DOCS} target="_blank" rel="noreferrer">Stockfish strength documentation ↗</a></p></div>}
        {kind === 'uci' && <label>Engine executable<input required value={command} onChange={e => setCommand(e.target.value)} placeholder="C:\Engines\engine.exe"/><small>A local chess engine that supports UCI.</small></label>}
        {(kind === 'uci' || kind === 'stockfish' && strengthMode === 'depth') && <label>Search depth <strong className="range-value">{depth}</strong><input type="range" aria-label="Search depth" min="1" max="18" value={depth} onChange={e => setDepth(Number(e.target.value))}/><small>{kind === 'stockfish' ? 'No strength cap. Search stops at the chosen depth.' : 'Higher depth gives stronger play and takes longer.'}</small></label>}
        {selected.length <= 1 && <label>Player name <span className="optional">optional</span><input value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'human' ? 'Your name' : 'Give this player a name'} maxLength={60}/></label>}
        {selected.length > 1 && <p className="batch-note">Each selected model will become its own player, using this connection.</p>}
        {message && <div className="form-message">{message}</div>}{error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy || discovering}>{busy ? <Loader2 size={17} className="spin"/> : <Plus size={17}/>} {selected.length > 1 ? `Add ${selected.length} players` : 'Add to arena'}</button></div>
      </form>
    </section>
  </div>;
}
