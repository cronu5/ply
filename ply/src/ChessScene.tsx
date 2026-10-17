import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import * as THREE from 'three';

type PieceKind = 'p' | 'r' | 'n' | 'b' | 'q' | 'k';
type PieceColor = 'w' | 'b';

export interface ChessSceneProps {
  fen: string;
  lastMove?: { from: string; to: string };
  selected: string | null;
  legalSquares: string[];
  onSquareClick: (square: string) => void;
  flipped: boolean;
  view: 'perspective' | 'top';
  interactive: boolean;
  reducedMotion?: boolean;
}

interface PieceVisual {
  group: THREE.Group;
  type: PieceKind;
  color: PieceColor;
  square: string;
  materials: THREE.Material[];
  from: THREE.Vector3;
  to: THREE.Vector3;
  began: number;
  duration: number;
  retiring?: number;
}

const BOARD_Y = 0.035;
const squarePosition = (square: string) => new THREE.Vector3(square.charCodeAt(0) - 100.5, BOARD_Y, 4.5 - Number(square[1]));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** The presentation is intentionally independent of game rules and providers. */
export default function ChessScene(props: ChessSceneProps) {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const syncPosition = useRef<(() => void) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.style.cssText = 'width:100%;height:100%;display:block;outline:none;touch-action:manipulation;';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Interactive chessboard. Use arrow keys to choose a square and Enter to select it.');
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f8f8f5');
    const camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.1, 100);
    const targetCamera = new THREE.PerspectiveCamera();
    const focus = new THREE.Vector3(0, 0.4, 0);
    const geometries = new Set<THREE.BufferGeometry>();
    const textures = new Set<THREE.Texture>();
    const allMaterials = new Set<THREE.Material>();
    const geometry = <T extends THREE.BufferGeometry>(value: T): T => { geometries.add(value); return value; };
    const material = <T extends THREE.Material>(value: T): T => { allMaterials.add(value); return value; };
    const texture = <T extends THREE.Texture>(value: T): T => { textures.add(value); return value; };
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const result = new THREE.Mesh(geometry(geo), mat);
      result.castShadow = true;
      result.receiveShadow = true;
      return result;
    };

    scene.add(new THREE.AmbientLight('#ffffff', 1.15));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(-3.5, 14, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -6.5, right: 6.5, top: 6.5, bottom: -6.5, near: 1, far: 28 });
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 5;
    scene.add(key);
    const fill = new THREE.DirectionalLight('#ffffff', 0.35);
    fill.position.set(6, 5, -6);
    scene.add(fill);

    const floor = mesh(new THREE.PlaneGeometry(200, 200), material(new THREE.ShadowMaterial({ color: '#111111', opacity: 0.12 })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.15;
    floor.castShadow = false;
    scene.add(floor);

    // Pencil hatching is drawn into the gray squares, not laid over the interface.
    const hatchCanvas = document.createElement('canvas');
    hatchCanvas.width = hatchCanvas.height = 128;
    const hatchContext = hatchCanvas.getContext('2d')!;
    hatchContext.fillStyle = '#dededa';
    hatchContext.fillRect(0, 0, 128, 128);
    hatchContext.strokeStyle = '#c0c0bb';
    hatchContext.lineWidth = 0.75;
    for (let i = -128; i <= 256; i += 12) {
      hatchContext.beginPath();
      hatchContext.moveTo(i, 0);
      hatchContext.lineTo(i - 128, 128);
      hatchContext.stroke();
    }
    const hatchMap = texture(new THREE.CanvasTexture(hatchCanvas));
    hatchMap.colorSpace = THREE.SRGBColorSpace;
    hatchMap.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    const paper = material(new THREE.MeshBasicMaterial({ color: '#f8f8f5' }));
    const edge = material(new THREE.MeshBasicMaterial({ color: '#252525' }));
    const ink = material(new THREE.MeshBasicMaterial({ color: '#343434' }));

    function roundedSlab(size: number, depth: number, y: number, mat: THREE.Material) {
      const s = size / 2, r = 0.08;
      const shape = new THREE.Shape();
      shape.moveTo(-s + r, -s);
      shape.lineTo(s - r, -s); shape.quadraticCurveTo(s, -s, s, -s + r);
      shape.lineTo(s, s - r); shape.quadraticCurveTo(s, s, s - r, s);
      shape.lineTo(-s + r, s); shape.quadraticCurveTo(-s, s, -s, s - r);
      shape.lineTo(-s, -s + r); shape.quadraticCurveTo(-s, -s, -s + r, -s);
      const slab = mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.015, bevelThickness: 0.012, curveSegments: 8 }), mat);
      slab.rotation.x = -Math.PI / 2;
      slab.position.y = y;
      scene.add(slab);
    }
    roundedSlab(9.10, 0.026, -0.104, edge);
    roundedSlab(9.06, 0.07, -0.077, paper);
    const tileLight = material(new THREE.MeshBasicMaterial({ color: '#fafaf7' }));
    const tileDark = material(new THREE.MeshBasicMaterial({ map: hatchMap }));
    const tileGeometry = geometry(new THREE.BoxGeometry(1, 0.028, 1));
    for (let row = 0; row < 8; row++) {
      for (let file = 0; file < 8; file++) {
        const tile = new THREE.Mesh(tileGeometry, (row + file) % 2 ? tileDark : tileLight);
        tile.position.set(file - 3.5, 0.014, row - 3.5);
        tile.receiveShadow = true;
        scene.add(tile);
      }
    }
    function inkStroke(points: THREE.Vector3[], radius = 0.007) {
      const curve = new THREE.CatmullRomCurve3(points);
      const stroke = mesh(new THREE.TubeGeometry(curve, Math.max(points.length * 5, 12), radius, 5, false), ink);
      stroke.castShadow = false;
      stroke.receiveShadow = false;
      scene.add(stroke);
    }
    // Tiny, deterministic variations give the grid an inked edge without shaking.
    for (let line = 0; line <= 8; line++) {
      const v = line - 4;
      inkStroke(Array.from({ length: 9 }, (_, n) => new THREE.Vector3(n - 4, 0.032, v + Math.sin(n * 2.1 + line) * 0.003)));
      inkStroke(Array.from({ length: 9 }, (_, n) => new THREE.Vector3(v + Math.cos(n * 1.9 + line) * 0.003, 0.032, n - 4)));
    }
    for (const side of [-1, 1]) {
      inkStroke([new THREE.Vector3(-4.49, 0.018, side * 4.49), new THREE.Vector3(0, 0.018, side * 4.496), new THREE.Vector3(4.49, 0.018, side * 4.49)], 0.012);
      inkStroke([new THREE.Vector3(side * 4.49, 0.018, -4.49), new THREE.Vector3(side * 4.496, 0.018, 0), new THREE.Vector3(side * 4.49, 0.018, 4.49)], 0.012);
    }

    const labelGeometry = geometry(new THREE.PlaneGeometry(0.30, 0.30));
    const labelMaps = new Map<string, THREE.MeshBasicMaterial>();
    function coordinate(text: string, x: number, z: number, inverted = false) {
      let mat = labelMaps.get(text);
      if (!mat) {
        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = labelCanvas.height = 128;
        const context = labelCanvas.getContext('2d')!;
        context.fillStyle = '#555555';
        context.font = '500 71px "Trebuchet MS", sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 64, 66);
        const map = texture(new THREE.CanvasTexture(labelCanvas));
        map.colorSpace = THREE.SRGBColorSpace;
        mat = material(new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, opacity: 0.95 }));
        labelMaps.set(text, mat);
      }
      const label = new THREE.Mesh(labelGeometry, mat);
      label.rotation.set(-Math.PI / 2, 0, 0);
      if (inverted) label.rotateZ(Math.PI);
      label.position.set(x, 0.018, z);
      scene.add(label);
    }
    for (let i = 0; i < 8; i++) {
      coordinate('abcdefgh'[i], i - 3.5, 4.30);
      coordinate('abcdefgh'[i], i - 3.5, -4.30, true);
      coordinate(String(8 - i), -4.30, i - 3.5);
      coordinate(String(8 - i), 4.30, i - 3.5, true);
    }

    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const shadowContext = shadowCanvas.getContext('2d')!;
    const shadowGradient = shadowContext.createRadialGradient(64, 64, 8, 64, 64, 64);
    shadowGradient.addColorStop(0, 'rgba(20,20,20,.34)');
    shadowGradient.addColorStop(0.45, 'rgba(20,20,20,.17)');
    shadowGradient.addColorStop(1, 'rgba(20,20,20,0)');
    shadowContext.fillStyle = shadowGradient;
    shadowContext.fillRect(0, 0, 128, 128);
    const shadowMap = texture(new THREE.CanvasTexture(shadowCanvas));
    const shadowGeometry = geometry(new THREE.PlaneGeometry(0.98, 0.98));

    const toonRamp = texture(new THREE.DataTexture(new Uint8Array([90, 170, 235, 255]), 4, 1, THREE.RedFormat));
    toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.generateMipmaps = false;
    toonRamp.needsUpdate = true;
    const primaryTemplate = material(new THREE.MeshToonMaterial({ color: '#f8f8f3', gradientMap: toonRamp }));
    const trimTemplate = material(new THREE.MeshToonMaterial({ color: '#aaaaa4', gradientMap: toonRamp }));
    const detailTemplate = material(new THREE.MeshBasicMaterial({ color: '#202020' }));
    const outlineTemplate = material(new THREE.MeshBasicMaterial({ color: '#202020', side: THREE.BackSide }));
    const prototypes = new Map<PieceKind, THREE.Group>();
    const base: [number, number][] = [[0, 0.006], [0.27, 0.006], [0.305, 0.046], [0.305, 0.105], [0.265, 0.15], [0.271, 0.19], [0.25, 0.223], [0.23, 0.235]];
    function lathe(points: [number, number][], mat: THREE.Material = primaryTemplate) {
      return mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), 64), mat);
    }
    function sphere(radius: number, x: number, y: number, z: number, mat: THREE.Material = primaryTemplate) {
      const result = mesh(new THREE.SphereGeometry(radius, 28, 20), mat);
      result.position.set(x, y, z);
      return result;
    }
    function ring(radius: number, tube: number, y: number, mat: THREE.Material = primaryTemplate) {
      const result = mesh(new THREE.TorusGeometry(radius, tube, 10, 64), mat);
      result.rotation.x = Math.PI / 2;
      result.position.y = y;
      return result;
    }

    // Cut a real, narrow diagonal slit into the bishop's mitre.
    function bishopMitre() {
      const lathed = new THREE.LatheGeometry([[0, 1.025], [0.10, 1.055], [0.173, 1.125], [0.188, 1.205], [0.17, 1.285], [0.12, 1.365], [0.065, 1.435], [0, 1.49]].map(([x, y]) => new THREE.Vector2(x, y)), 64);
      const source = lathed.toNonIndexed();
      lathed.dispose();
      const input = source.getAttribute('position');
      const out: number[] = [];
      const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.055), new THREE.Plane(new THREE.Vector3(-1, 1, 0).normalize(), -1.237 / Math.sqrt(2)), new THREE.Plane(new THREE.Vector3(1, -1, 0).normalize(), 1.279 / Math.sqrt(2))];
      function clip(poly: THREE.Vector3[], plane: THREE.Plane, inside: boolean) {
        const result: THREE.Vector3[] = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
          const aIn = inside ? da >= 0 : da <= 0;
          const bIn = inside ? db >= 0 : db <= 0;
          if (aIn) result.push(a);
          if (aIn !== bIn) result.push(a.clone().lerp(b, da / (da - db)));
        }
        return result;
      }
      const emit = (poly: THREE.Vector3[]) => {
        for (let n = 1; n < poly.length - 1; n++) for (const p of [poly[0], poly[n], poly[n + 1]]) out.push(p.x, p.y, p.z);
      };
      for (let i = 0; i < input.count; i += 3) {
        let remaining = [0, 1, 2].map((n) => new THREE.Vector3().fromBufferAttribute(input, i + n));
        for (const plane of planes) {
          if (remaining.length < 3) break;
          emit(clip(remaining, plane, false));
          remaining = clip(remaining, plane, true);
        }
      }
      source.dispose();
      const result = new THREE.BufferGeometry();
      result.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
      result.computeVertexNormals();
      return mesh(result, primaryTemplate);
    }

    for (const type of ['p', 'r', 'n', 'b', 'q', 'k'] as PieceKind[]) {
      const group = new THREE.Group();
      group.add(ring(0.285, 0.007, 0.044, trimTemplate));
      if (type === 'p') {
        group.add(lathe([...base, [0.196, 0.28], [0.139, 0.34], [0.108, 0.44], [0.114, 0.545], [0.15, 0.58], [0.181, 0.603], [0.181, 0.64], [0.143, 0.666], [0, 0.676]]));
        group.add(sphere(0.22, 0, 0.793, 0));
      } else if (type === 'r') {
        group.add(lathe([...base, [0.203, 0.286], [0.179, 0.35], [0.165, 0.47], [0.18, 0.72], [0.202, 0.82], [0.249, 0.844], [0.252, 0.888], [0.281, 0.918], [0.281, 0.998], [0.195, 0.998], [0.195, 0.95], [0, 0.95]]));
        for (let tooth = 0; tooth < 6; tooth++) {
          const angle = tooth * Math.PI / 3;
          const crenel = mesh(new THREE.BoxGeometry(0.144, 0.17, 0.116), primaryTemplate);
          crenel.position.set(Math.sin(angle) * 0.218, 1.055, Math.cos(angle) * 0.218);
          crenel.rotation.y = angle;
          group.add(crenel);
        }
      } else if (type === 'n') {
        group.add(lathe([...base, [0.20, 0.285], [0.19, 0.345], [0.225, 0.368], [0.226, 0.4], [0, 0.41]]));
        const horse = new THREE.Shape();
        horse.moveTo(-0.20, 0.39);
        horse.bezierCurveTo(-0.11, 0.60, -0.30, 0.68, -0.254, 0.94);
        horse.bezierCurveTo(-0.245, 1.10, -0.15, 1.22, -0.12, 1.27);
        horse.lineTo(-0.13, 1.455); horse.lineTo(-0.037, 1.385);
        horse.lineTo(0.032, 1.48); horse.lineTo(0.075, 1.33);
        horse.bezierCurveTo(0.16, 1.30, 0.21, 1.18, 0.34, 1.13);
        horse.quadraticCurveTo(0.405, 1.108, 0.391, 1.048);
        horse.lineTo(0.335, 0.946); horse.quadraticCurveTo(0.313, 0.907, 0.25, 0.94);
        horse.lineTo(0.13, 0.978); horse.quadraticCurveTo(0.175, 0.84, 0.097, 0.759);
        horse.bezierCurveTo(0.04, 0.67, 0.19, 0.57, 0.21, 0.4);
        horse.closePath();
        const horseGeometry = new THREE.ExtrudeGeometry(horse, { depth: 0.22, bevelEnabled: true, bevelSegments: 3, bevelThickness: 0.027, bevelSize: 0.025, curveSegments: 14, steps: 1 });
        horseGeometry.translate(0, 0, -0.11);
        group.add(mesh(horseGeometry, primaryTemplate));
        for (const side of [-1, 1]) group.add(sphere(0.028, 0.105, 1.238, side * 0.139, detailTemplate));
        // The recessed mane follows the back of the sculpted neck.
        const mane = new THREE.Shape();
        mane.moveTo(-0.15, 1.275); mane.bezierCurveTo(-0.27, 1.14, -0.33, 0.96, -0.28, 0.73);
        mane.lineTo(-0.22, 0.75); mane.bezierCurveTo(-0.25, 0.98, -0.20, 1.13, -0.115, 1.22); mane.closePath();
        const maneGeometry = new THREE.ExtrudeGeometry(mane, { depth: 0.11, bevelEnabled: true, bevelSize: 0.009, bevelThickness: 0.01, bevelSegments: 2, curveSegments: 12 });
        maneGeometry.translate(0, 0, -0.055);
        group.add(mesh(maneGeometry, trimTemplate));
      } else if (type === 'b') {
        group.add(lathe([...base, [0.19, 0.29], [0.146, 0.4], [0.106, 0.69], [0.123, 0.87], [0.196, 0.91], [0.211, 0.944], [0.207, 0.985], [0.137, 1.016], [0.098, 1.06], [0, 1.074]]));
        group.add(bishopMitre());
        group.add(sphere(0.045, 0, 1.487, 0));
      } else if (type === 'q') {
        group.add(lathe([...base, [0.201, 0.292], [0.164, 0.40], [0.114, 0.75], [0.128, 1.025], [0.185, 1.105], [0.217, 1.122], [0.218, 1.159], [0.18, 1.186], [0.151, 1.215], [0.176, 1.268], [0.212, 1.32], [0.252, 1.411], [0.244, 1.451], [0.195, 1.413], [0.14, 1.35], [0, 1.35]]));
        for (let point = 0; point < 8; point++) {
          const angle = point * Math.PI / 4;
          group.add(sphere(0.047, Math.sin(angle) * 0.228, 1.472, Math.cos(angle) * 0.228));
        }
        group.add(sphere(0.087, 0, 1.449, 0));
        group.add(sphere(0.048, 0, 1.565, 0));
      } else {
        group.add(lathe([...base, [0.212, 0.29], [0.165, 0.405], [0.119, 0.80], [0.139, 1.082], [0.209, 1.135], [0.23, 1.166], [0.23, 1.203], [0.20, 1.227], [0.159, 1.257], [0.174, 1.31], [0.188, 1.366], [0.174, 1.409], [0.104, 1.43], [0, 1.431]]));
        group.add(sphere(0.115, 0, 1.432, 0));
        const upright = mesh(new THREE.BoxGeometry(0.10, 0.33, 0.10), primaryTemplate);
        upright.position.y = 1.665;
        group.add(upright);
        const arms = mesh(new THREE.BoxGeometry(0.29, 0.10, 0.10), primaryTemplate);
        arms.position.y = 1.703;
        group.add(arms);
      }
      const outlines: THREE.Mesh[] = [];
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object.material === detailTemplate) return;
        const hull = object.geometry.clone();
        const vertices = hull.getAttribute('position'), normals = hull.getAttribute('normal');
        for (let i = 0; i < vertices.count; i++) {
          vertices.setXYZ(i, vertices.getX(i) + normals.getX(i) * 0.020, vertices.getY(i) + normals.getY(i) * 0.020, vertices.getZ(i) + normals.getZ(i) * 0.020);
        }
        hull.computeBoundingSphere();
        const outline = new THREE.Mesh(geometry(hull), outlineTemplate);
        outline.position.copy(object.position);
        outline.rotation.copy(object.rotation);
        outline.scale.copy(object.scale);
        outline.castShadow = false;
        outline.receiveShadow = false;
        outline.userData.outline = true;
        outlines.push(outline);
      });
      group.add(...outlines);
      prototypes.set(type, group);
    }

    function createPiece(type: PieceKind, color: PieceColor, square: string): PieceVisual {
      const group = prototypes.get(type)!.clone(true);
      const remap = new Map<THREE.Material, THREE.Material>();
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const source = object.material as THREE.Material;
        let own = remap.get(source);
        if (!own) {
          own = source.clone();
          const colored = own as THREE.MeshToonMaterial;
          if (color === 'b' && source !== outlineTemplate) colored.color.set(source === primaryTemplate ? '#484848' : source === trimTemplate ? '#858585' : '#fafaf6');
          material(own);
          remap.set(source, own);
        }
        object.material = own;
      });
      if (type === 'n') group.rotation.y = color === 'w' ? Math.PI / 2 - 0.6 : -Math.PI / 2 - 0.6;
      // Point the bishop's cut towards a player rather than away from the camera.
      if (type === 'b') group.rotation.y = color === 'w' ? 0.45 : Math.PI + 0.45;
      const contactMaterial = material(new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false, opacity: 0.68 }));
      const contact = new THREE.Mesh(shadowGeometry, contactMaterial);
      contact.rotation.x = -Math.PI / 2;
      contact.position.y = 0.001;
      contact.castShadow = false;
      contact.receiveShadow = false;
      group.add(contact);
      group.position.copy(squarePosition(square));
      group.userData.square = square;
      scene.add(group);
      return { group, type, color, square, materials: [...remap.values(), contactMaterial], from: group.position.clone(), to: group.position.clone(), began: 0, duration: 0 };
    }

    let pieces = new Map<string, PieceVisual>();
    const retired = new Set<PieceVisual>();
    let currentPlacement = '';
    function retire(piece: PieceVisual, now: number) {
      piece.retiring = now;
      piece.materials.forEach((mat) => { mat.transparent = true; mat.depthWrite = false; });
      retired.add(piece);
    }
    function updatePosition() {
      const config = live.current;
      const placement = config.fen.split(' ')[0];
      if (placement === currentPlacement) return;
      let game: Chess;
      try { game = new Chess(config.fen); } catch { return; }
      const wanted = new Map<string, { type: PieceKind; color: PieceColor }>();
      for (const row of game.board()) for (const entry of row) if (entry) wanted.set(entry.square, { type: entry.type, color: entry.color });
      const available = new Map(pieces);
      const next = new Map<string, PieceVisual>();
      const now = performance.now();
      const unchanged = [...wanted].filter(([square, entry]) => { const old = available.get(square); return old && old.color === entry.color && old.type === entry.type; }).length;
      const animate = currentPlacement !== '' && !config.reducedMotion && wanted.size - unchanged <= 4;
      const move = (piece: PieceVisual, square: string) => {
        piece.from.copy(piece.group.position);
        piece.to.copy(squarePosition(square));
        piece.began = now;
        piece.duration = animate ? 450 : 0;
        piece.square = square;
        piece.group.userData.square = square;
        if (!animate) piece.group.position.copy(piece.to);
        next.set(square, piece);
      };
      // Preserve every unmoved piece, including identity throughout long games.
      for (const [square, entry] of wanted) {
        const old = available.get(square);
        if (old && old.type === entry.type && old.color === entry.color) {
          next.set(square, old);
          available.delete(square);
        }
      }
      const explicit = config.lastMove;
      if (explicit && !next.has(explicit.to)) {
        const old = available.get(explicit.from), entry = wanted.get(explicit.to);
        if (old && entry && old.color === entry.color) {
          available.delete(explicit.from);
          if (old.type === entry.type) move(old, explicit.to);
          else {
            const promoted = createPiece(entry.type, entry.color, explicit.from);
            move(promoted, explicit.to);
            retire(old, now);
          }
        }
      }
      // Also matches the rook in castling, and supports stepping through history.
      for (const [square, entry] of wanted) {
        if (next.has(square)) continue;
        const candidates = [...available].filter(([, old]) => old.type === entry.type && old.color === entry.color);
        candidates.sort((a, b) => a[1].group.position.distanceToSquared(squarePosition(square)) - b[1].group.position.distanceToSquared(squarePosition(square)));
        if (candidates.length) {
          const [previous, piece] = candidates[0];
          available.delete(previous);
          move(piece, square);
        } else next.set(square, createPiece(entry.type, entry.color, square));
      }
      for (const old of available.values()) retire(old, now);
      pieces = next;
      currentPlacement = placement;
    }
    syncPosition.current = updatePosition;
    updatePosition();

    const highlightGeometry = geometry(new THREE.PlaneGeometry(0.996, 0.996));
    const dotGeometry = geometry(new THREE.CircleGeometry(0.092, 32));
    const captureGeometry = geometry(new THREE.RingGeometry(0.39, 0.444, 48));
    const legalMaterial = material(new THREE.MeshBasicMaterial({ color: '#272727', transparent: true, opacity: 0.66, depthWrite: false }));
    const highlights = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>>();
    const indicators = new Map<string, THREE.Mesh>();
    for (let rank = 1; rank <= 8; rank++) for (const file of 'abcdefgh') {
      const square = `${file}${rank}`;
      const highlight = new THREE.Mesh(highlightGeometry, material(new THREE.MeshBasicMaterial({ color: '#656565', transparent: true, opacity: 0.25, depthWrite: false })));
      highlight.rotation.x = -Math.PI / 2;
      highlight.position.copy(squarePosition(square));
      highlight.position.y = 0.031;
      highlight.visible = false;
      scene.add(highlight);
      highlights.set(square, highlight);
      const indicator = new THREE.Mesh(dotGeometry, legalMaterial);
      indicator.rotation.x = -Math.PI / 2;
      indicator.position.copy(squarePosition(square));
      indicator.position.y = 0.034;
      indicator.visible = false;
      scene.add(indicator);
      indicators.set(square, indicator);
    }
    const pickBoard = new THREE.Mesh(geometry(new THREE.PlaneGeometry(8, 8)), material(new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })));
    pickBoard.rotation.x = -Math.PI / 2;
    pickBoard.position.y = 0.028;
    scene.add(pickBoard);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hover: string | null = null;
    let keyboardSquare = 'e2';
    let keyboardActive = false;
    function picked(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const intersection = raycaster.intersectObjects([pickBoard, ...[...pieces.values()].map((p) => p.group)], true)[0];
      if (!intersection) return null;
      let node: THREE.Object3D | null = intersection.object;
      while (node) {
        if (node.userData.square) return node.userData.square as string;
        node = node.parent;
      }
      const file = Math.floor(intersection.point.x + 4), rank = 8 - Math.floor(intersection.point.z + 4);
      return file >= 0 && file < 8 && rank >= 1 && rank <= 8 ? `${'abcdefgh'[file]}${rank}` : null;
    }
    const onMove = (event: PointerEvent) => {
      keyboardActive = false;
      hover = live.current.interactive ? picked(event) : null;
      canvas.style.cursor = hover ? 'pointer' : 'default';
    };
    const onLeave = () => { if (!keyboardActive) hover = null; };
    const onClick = (event: PointerEvent) => {
      if (!live.current.interactive || event.button !== 0) return;
      const square = picked(event);
      if (square) { keyboardSquare = square; live.current.onSquareClick(square); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (!live.current.interactive) return;
      let file = keyboardSquare.charCodeAt(0) - 97, rank = Number(keyboardSquare[1]);
      const sign = live.current.flipped ? -1 : 1;
      if (event.key === 'ArrowLeft') file -= sign;
      else if (event.key === 'ArrowRight') file += sign;
      else if (event.key === 'ArrowUp') rank += sign;
      else if (event.key === 'ArrowDown') rank -= sign;
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); live.current.onSquareClick(keyboardSquare); return; }
      else return;
      event.preventDefault();
      keyboardSquare = `${'abcdefgh'[Math.max(0, Math.min(7, file))]}${Math.max(1, Math.min(8, rank))}`;
      keyboardActive = true;
      hover = keyboardSquare;
      canvas.setAttribute('aria-label', `Chessboard, square ${keyboardSquare}. Press Enter to select.`);
    };
    const onBlur = () => { keyboardActive = false; hover = null; };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onClick);
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('blur', onBlur);

    let width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    let destroyed = false;
    const resize = new ResizeObserver(() => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
    });
    resize.observe(host);
    renderer.setSize(width, height, false);
    const bounds: THREE.Vector3[] = [];
    for (const x of [-4.66, 4.66]) for (const z of [-4.66, 4.66]) bounds.push(new THREE.Vector3(x, -0.14, z));
    for (const x of [-3.86, 3.86]) for (const z of [-3.86, 3.86]) bounds.push(new THREE.Vector3(x, 1.90, z));
    const projected = new THREE.Vector3();
    let cameraSignature = '';
    let cameraInitialized = false;
    let highlightSignature = '';
    let lastFrame = performance.now();
    let frameId = 0;
    function disposePiece(piece: PieceVisual) {
      scene.remove(piece.group);
      for (const mat of piece.materials) { mat.dispose(); allMaterials.delete(mat); }
    }
    function frame(now: number) {
      if (destroyed) return;
      const config = live.current;
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      const orientation = `${config.view}-${config.flipped}`;
      if (orientation !== cameraSignature) {
        const sign = config.flipped ? -1 : 1;
        if (config.view === 'top') {
          targetCamera.position.set(0, 20, 0.001 * sign);
          targetCamera.up.set(0, 0, -sign);
        } else {
          targetCamera.position.set(5.8 * sign, 12.7, 13.7 * sign);
          targetCamera.up.set(0, 1, 0);
        }
        targetCamera.lookAt(focus);
        cameraSignature = orientation;
      }
      const transition = !cameraInitialized || config.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
      camera.position.lerp(targetCamera.position, transition);
      camera.quaternion.slerp(targetCamera.quaternion, transition);
      cameraInitialized = true;
      camera.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const point of bounds) {
        projected.copy(point).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
        minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
      }
      const aspect = width / height;
      const halfHeight = Math.max(maxY - minY, (maxX - minX) / aspect) * 0.52;
      const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
      camera.left = centerX - halfHeight * aspect; camera.right = centerX + halfHeight * aspect;
      camera.top = centerY + halfHeight; camera.bottom = centerY - halfHeight;
      camera.updateProjectionMatrix();
      for (const piece of pieces.values()) {
        if (!piece.duration) continue;
        const t = Math.min(1, (now - piece.began) / piece.duration);
        piece.group.position.lerpVectors(piece.from, piece.to, smooth(t));
        piece.group.position.y += Math.sin(t * Math.PI) * (piece.type === 'n' ? 0.36 : 0.105);
        if (t === 1) piece.duration = 0;
      }
      for (const piece of retired) {
        const t = config.reducedMotion ? 1 : Math.min(1, (now - piece.retiring!) / 260);
        piece.materials.forEach((mat) => { mat.opacity = (1 - smooth(t)) * (mat instanceof THREE.MeshBasicMaterial ? 0.68 : 1); });
        piece.group.scale.setScalar(1 - t * 0.13);
        piece.group.position.y = BOARD_Y - t * 0.045;
        if (t === 1) { disposePiece(piece); retired.delete(piece); }
      }
      const effectiveHover = config.interactive ? hover : null;
      const state = `${config.selected}|${config.legalSquares.join(',')}|${config.lastMove?.from}|${config.lastMove?.to}|${effectiveHover}|${currentPlacement}`;
      if (state !== highlightSignature) {
        const legal = new Set(config.legalSquares);
        for (const [square, highlight] of highlights) {
          const selected = square === config.selected;
          const last = square === config.lastMove?.from || square === config.lastMove?.to;
          const hovered = square === effectiveHover;
          highlight.visible = selected || last || hovered;
          highlight.material.color.set(selected ? '#575757' : hovered ? '#ffffff' : '#7b7b7b');
          highlight.material.opacity = selected ? 0.30 : hovered ? 0.38 : 0.19;
          const indicator = indicators.get(square)!;
          indicator.visible = legal.has(square);
          indicator.geometry = pieces.has(square) ? captureGeometry : dotGeometry;
        }
        highlightSignature = state;
      }
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(frame);
    }
    frameId = requestAnimationFrame(frame);
    const contextLost = (event: Event) => { event.preventDefault(); setUnavailable(true); };
    canvas.addEventListener('webglcontextlost', contextLost);
    return () => {
      destroyed = true;
      syncPosition.current = null;
      cancelAnimationFrame(frameId);
      resize.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerup', onClick);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('webglcontextlost', contextLost);
      for (const geo of geometries) geo.dispose();
      for (const mat of allMaterials) mat.dispose();
      for (const map of textures) map.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  useEffect(() => { syncPosition.current?.(); }, [props.fen, props.lastMove?.from, props.lastMove?.to]);

  return (
    <div ref={container} className="chess-scene" style={{ width: '100%', height: '100%', minHeight: 360, position: 'relative' }}>
      {unavailable && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', gap: 10, padding: 32, textAlign: 'center', background: '#f8f8f5', color: '#292929' }} role="status"><strong>The board needs WebGL</strong><span>Enable hardware acceleration and reopen PLY to see the 3D board.</span></div>}
    </div>
  );
}
