import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import './miniboard.css';

export interface MiniBoardProps {
  fen: string;
  selected: string | null;
  legalSquares: string[];
  onSquareClick: (square: string) => void;
  flipped: boolean;
  interactive: boolean;
  lastMove?: { from: string; to: string };
  isOpen: boolean;
  onToggle: () => void;
}

const pieceNames: Record<PieceSymbol, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** Small, authored SVG silhouettes stay sharp without relying on emoji fonts. */
function Piece({ type, color }: { type: PieceSymbol; color: Color }) {
  const fill = color === 'w' ? '#ffffff' : '#353535';
  const detail = color === 'w' ? '#303030' : '#f2f2ed';
  return <svg className="mini-piece" viewBox="0 0 24 24" fill={fill} stroke="#292929" strokeWidth="1.15" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">
    {type === 'p' && <><path d="M10 8.5c.6 2.6-.1 4.3-1.7 7.7h7.4C14.1 12.8 13.4 11.1 14 8.5Z"/><circle cx="12" cy="6.2" r="2.9"/></>}
    {type === 'r' && <><path d="M6 3.3h3v2.2h2V3.3h2v2.2h2V3.3h3v5h-2l-.8 8H8.8l-.8-8H6Z"/><path d="M8 8.3h8M9.5 14.8h5" fill="none" stroke={detail} strokeWidth=".8"/></>}
    {type === 'n' && <><path d="M6.7 17c-1-2.1.1-6.5 1.9-8.7L8 3.4 10.5 5l1.7-2.2L14 5.1l3.9 2.5.5 2.4-2.2 1.5-2.3-.9c-1.3 2.6 1.6 3.6 2.5 6.4Z"/><path d="M9.3 8.4c-1.8 2.4-2 5-1.4 6.3" fill="none" stroke={detail} strokeWidth=".8"/><circle cx="13.6" cy="7.1" r=".8" fill={detail} stroke="none"/></>}
    {type === 'b' && <><path d="m10 10.2-.8 3.4-1.4 3.1h8.4l-1.4-3.1-.8-3.4Z"/><path d="M12 2.3C10 5 8.2 6.3 8.2 8.4c0 1.9 1.6 3 3.8 3s3.8-1.1 3.8-3C15.8 6.3 14 5 12 2.3Z"/><path d="m12.7 5.2-2.8 3.6" fill="none" stroke={detail} strokeWidth="1.15"/><path d="M9.3 13.7h5.4" stroke={detail} strokeWidth=".8"/></>}
    {type === 'q' && <><path d="m8.7 12.3-.9 4.4h8.4l-.9-4.4Z"/><path d="m5.3 5 3.4 2.8L12 3.5l3.3 4.3L18.7 5l-2.3 7.8H7.6Z"/><circle cx="5.2" cy="4.3" r="1.1"/><circle cx="12" cy="2.8" r="1.1"/><circle cx="18.8" cy="4.3" r="1.1"/><path d="M8.1 11.3h7.8" stroke={detail} strokeWidth=".8"/></>}
    {type === 'k' && <><path d="m9.3 11.6-1.4 5.1h8.2l-1.4-5.1Z"/><path d="M7.7 8.6c-.9-2 1.5-2.9 4.3-.7 2.8-2.2 5.2-1.3 4.3.7l-1.3 3.3H9Z"/><path d="M10.8 2h2.4v2h2v2.1h-2v2h-2.4v-2h-2V4h2Z"/><path d="M9.2 11h5.6" stroke={detail} strokeWidth=".8"/></>}
    <path d="M7.5 16.7h9l1.2 2.3H6.3Z"/>
    <rect x="5.8" y="18.7" width="12.4" height="2.4" rx=".65"/>
    <path d="M7.2 19.6h9.6" stroke={detail} strokeWidth=".6" opacity=".7"/>
  </svg>;
}

export default function MiniBoard({ fen, selected, legalSquares, onSquareClick, flipped, interactive, lastMove, isOpen, onToggle }: MiniBoardProps) {
  const id = useId();
  const board = useMemo(() => { try { return new Chess(fen); } catch { return null; } }, [fen]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focusSquare, setFocusSquare] = useState('e2');
  const files = flipped ? 'hgfedcba' : 'abcdefgh';
  const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const squares = ranks.flatMap(rank => [...files].map(file => `${file}${rank}`));
  const legal = new Set(legalSquares);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!interactive) return;
    let next = index;
    if (event.key === 'ArrowLeft') next = index % 8 ? index - 1 : index;
    else if (event.key === 'ArrowRight') next = index % 8 < 7 ? index + 1 : index;
    else if (event.key === 'ArrowUp') next = index >= 8 ? index - 8 : index;
    else if (event.key === 'ArrowDown') next = index < 56 ? index + 8 : index;
    else if (event.key === 'Home') next = index - index % 8;
    else if (event.key === 'End') next = index - index % 8 + 7;
    else return;
    event.preventDefault();
    setFocusSquare(squares[next]);
    buttons.current.get(squares[next])?.focus();
  }
  const turn = board?.turn() === 'b' ? 'Black' : 'White';
  return <section className={`mini-board ${isOpen ? 'mini-board-open' : 'mini-board-closed'}`} aria-label="Compact chessboard">
    <button type="button" className="mini-board-toggle" onClick={onToggle} aria-expanded={isOpen} aria-controls={id} aria-label={isOpen ? 'Minimize 2D board' : 'Open 2D board'} title={isOpen ? 'Minimize 2D board' : 'Open 2D board'}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="1.2" stroke="currentColor"/><path d="M6 1.5v13M10 1.5v13M1.5 6h13M1.5 10h13" stroke="currentColor" strokeWidth=".8"/></svg>
      <span>2D board</span>
      <svg className="mini-board-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true"><path d={isOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
    {isOpen && <div id={id} className="mini-board-content">
      {board ? <><div className="mini-board-grid" role="group" aria-label={`${turn} to move. ${flipped ? 'Black' : 'White'} at the bottom.`} data-interactive={interactive}>
        {squares.map((square, index) => {
          const piece = board.get(square as Square);
          const dark = (square.charCodeAt(0) - 97 + Number(square[1])) % 2 === 1;
          const isSelected = selected === square;
          const isLast = lastMove?.from === square || lastMove?.to === square;
          const isLegal = legal.has(square);
          const label = `${square}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${pieceNames[piece.type]}` : ' empty'}${isSelected ? ', selected' : ''}${isLegal ? ', legal destination' : ''}`;
          return <button key={square} type="button" className={`mini-square ${dark ? 'mini-square-dark' : 'mini-square-light'}${isSelected ? ' mini-square-selected' : ''}${isLast ? ' mini-square-last' : ''}`} ref={element => { if (element) buttons.current.set(square, element); else buttons.current.delete(square); }} data-square={square} aria-label={label} aria-disabled={!interactive} aria-pressed={isSelected} tabIndex={interactive && square === focusSquare ? 0 : -1} onFocus={() => setFocusSquare(square)} onKeyDown={event => navigate(event, index)} onClick={() => { if (interactive) onSquareClick(square); }}>
            {index % 8 === 0 && <span className="mini-rank" aria-hidden="true">{square[1]}</span>}
            {index >= 56 && <span className="mini-file" aria-hidden="true">{square[0]}</span>}
            {piece && <Piece type={piece.type} color={piece.color}/>}
            {isLegal && <span className={piece ? 'mini-legal-ring' : 'mini-legal-dot'} aria-hidden="true"/>}
          </button>;
        })}
      </div><div className="mini-board-caption"><span><i className={board.turn() === 'w' ? 'mini-turn-white' : 'mini-turn-black'}/>{turn} to move</span><span>{interactive ? selected ? 'Choose a square' : 'Click to play' : 'View only'}</span></div></> : <p className="mini-board-invalid">Position unavailable.</p>}
    </div>}
  </section>;
}
