import type { ModelDiagnostics } from './types';
export default function TurnDiagnostics({detail}:{detail:ModelDiagnostics}) {
  return <details className="turn-diagnostics"><summary>Why this turn paused</summary><div><span className="diagnostic-model">{detail.model}</span>{detail.attempts.length ? detail.attempts.map((attempt,index)=><section key={index}><span>Attempt {index+1}</span><code>{attempt.response||'(no move returned)'}</code><p>{attempt.issue}</p>{attempt.doneReason==='length'&&<small>The response reached its output limit.</small>}</section>):<p>The provider could not complete this request.</p>}</div></details>;
}
