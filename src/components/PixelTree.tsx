import React, { useRef, useEffect, useCallback } from 'react';

interface Vec2 { x: number; y: number; }

interface MemoryNode {
  id: string;
  type: 'preference' | 'fact' | 'habit' | 'knowledge';
  content: string;
  tier: 'episodic' | 'internalized' | 'growth' | 'core_identity';
  nodeType: 'branch' | 'leaf';
  confidence: number;
  importance: number;
  parentId: string | null;
}

interface FileEntry {
  id: string;
  name: string;
  size: string;
  status: 'ready' | 'indexing' | 'indexed';
  source: 'upload' | 'generated' | 'ingested';
}

interface TreeNode {
  id: string;
  type: 'trunk' | 'branch' | 'leaf' | 'file';
  title: string;
  hue: number;
  tier?: string;
  depth: number;
  pos: Vec2;
  z: number;     // 3D depth: negative=behind, positive=front
  children: TreeNode[];
  memoryData?: MemoryNode;
  fileData?: FileEntry;
}

// Color mapping by tier
const TIER_HUES: Record<string, number> = {
  core_identity: 42,
  growth: 150,
  internalized: 195,
  episodic: 260,
};
const TRUNK_HUE = 45;
const FILE_HUE = 210;

interface PixelTreeProps {
  treeNodes: TreeNode[];
  searchQuery?: string;
  onNodeClick?: (id: string, screenX: number, screenY: number) => void;
  onNodeDoubleClick?: (id: string) => void;
  highlightedNodeId?: string | null;
}

// ── Tree layout ──────────────────────────────────────────

function layoutTree(memories: MemoryNode[], files: FileEntry[]): TreeNode[] {
  // Build branch/leaf nodes from memories
  const memNodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const childrenMap = new Map<string, string[]>(); // parentId → childIds

  for (const m of memories) {
    const hue = TIER_HUES[m.tier] || 260;
    const node: TreeNode = {
      id: m.id,
      type: m.nodeType === 'branch' ? 'branch' : 'leaf',
      title: m.content.length > 40 ? m.content.slice(0, 38) + '…' : m.content,
      hue,
      tier: m.tier,
      depth: 0,
      pos: { x: 0, y: 0 },
      z: 0,
      children: [],
      memoryData: m,
    };
    memNodes.set(m.id, node);

    if (!m.parentId) {
      roots.push(node);
    } else {
      if (!childrenMap.has(m.parentId)) childrenMap.set(m.parentId, []);
      childrenMap.get(m.parentId)!.push(m.id);
    }
  }

  // Link children
  for (const [parentId, childIds] of childrenMap) {
    const parent = memNodes.get(parentId);
    if (parent) {
      for (const cid of childIds) {
        const child = memNodes.get(cid);
        if (child) parent.children.push(child);
      }
    }
  }

  // File nodes — attach to root or as standalone
  const fileNodes: TreeNode[] = files.map(f => ({
    id: f.id,
    type: 'file' as const,
    title: f.name,
    hue: FILE_HUE,
    depth: 0,
    pos: { x: 0, y: 0 },
    z: 0,
    children: [],
    fileData: f,
  }));

  // Calculate depths
  function setDepth(node: TreeNode, d: number) {
    node.depth = d;
    for (const c of node.children) setDepth(c, d + 1);
  }
  for (const r of roots) setDepth(r, 0);

  // Splay tree layout: root at bottom center, children spread upward in arcs
  function layout(node: TreeNode, cx: number, cy: number, spreadAngle: number, startAngle: number, levelHeight: number) {
    node.pos = { x: cx, y: cy };
    const kids = node.children;
    if (kids.length === 0) return;

    const count = kids.length;
    const angleStep = count > 1 ? spreadAngle / (count - 1) : 0;
    const start = count > 1 ? -spreadAngle / 2 : 0;

    for (let i = 0; i < count; i++) {
      const angle = start + i * angleStep + startAngle;
      const rad = (Math.PI / 180) * (angle - 90);
      const dist = levelHeight * (0.8 + Math.random() * 0.4);
      const nx = cx + Math.cos(rad) * dist;
      const ny = cy + Math.sin(rad) * dist;
      const nextSpread = spreadAngle * (0.55 + Math.random() * 0.3);
      const nextHeight = levelHeight * (0.7 + Math.random() * 0.3);
      layout(kids[i], nx, Math.min(0.55, ny), nextSpread, angle * 0.5, nextHeight);
    }
  }

  // Layout root nodes
  if (roots.length === 1) {
    layout(roots[0], 0.5, 0.82, 90, 0, 0.16);
  } else if (roots.length > 1) {
    const spacing = 0.7 / (roots.length + 1);
    for (let i = 0; i < roots.length; i++) {
      layout(roots[i], 0.15 + spacing * (i + 1), 0.78, 60, 0, 0.14);
    }
  }

  // Layout file nodes around the periphery if no memories
  if (roots.length === 0 && fileNodes.length > 0) {
    const total = fileNodes.length;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
      const r = 0.3;
      fileNodes[i].pos = { x: 0.5 + Math.cos(angle) * r, y: 0.5 + Math.sin(angle) * r };
    }
  } else if (roots.length > 0 && fileNodes.length > 0) {
    // Scatter files near the tree
    for (let i = 0; i < fileNodes.length; i++) {
      const angle = (i / fileNodes.length) * Math.PI - Math.PI * 0.5;
      const r = 0.35 + Math.random() * 0.1;
      fileNodes[i].pos = { x: 0.5 + Math.cos(angle) * r, y: 0.45 + Math.sin(angle) * r * 0.5 };
      fileNodes[i].depth = 1;
    }
  }

  // Flatten all nodes
  const allNodes: TreeNode[] = [];
  function flatten(n: TreeNode) {
    allNodes.push(n);
    for (const c of n.children) flatten(c);
  }
  for (const r of roots) flatten(r);
  allNodes.push(...fileNodes);

  return allNodes;
}

// ── Bezier curve ─────────────────────────────────────────

interface BranchCurve {
  start: Vec2;
  end: Vec2;
  cp1: Vec2;
  cp2: Vec2;
  zStart: number;
  zEnd: number;
  hueStart: number;
  hueEnd: number;
  depth: number;
}

function buildCurves(nodes: TreeNode[], childrenMap: Map<string, string[]>): BranchCurve[] {
  const curves: BranchCurve[] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Build parent→child curves
  for (const [parentId, childIds] of childrenMap) {
    const parent = nodeMap.get(parentId);
    if (!parent || parent.type === 'leaf' || parent.type === 'file') continue;

    for (const cid of childIds) {
      const child = nodeMap.get(cid);
      if (!child) continue;

      const sx = parent.pos.x;
      const sy = parent.pos.y;
      const ex = child.pos.x;
      const ey = child.pos.y;
      const dx = ex - sx;
      const dy = ey - sy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      curves.push({
        start: { x: sx, y: sy },
        end: { x: ex, y: ey },
        cp1: { x: sx + dx * 0.2, y: sy + dy * 0.45 },
        cp2: { x: ex - dx * 0.15, y: ey - dy * 0.45 },
        zStart: parent.z,
        zEnd: child.z,
        hueStart: parent.hue,
        hueEnd: child.hue,
        depth: parent.depth,
      });
    }
  }

  // Also build curves for memory children not in childrenMap (from tree structure)
  for (const n of nodes) {
    for (const child of n.children) {
      const exists = curves.some(c =>
        Math.abs(c.start.x - n.pos.x) < 0.001 &&
        Math.abs(c.start.y - n.pos.y) < 0.001 &&
        Math.abs(c.end.x - child.pos.x) < 0.001 &&
        Math.abs(c.end.y - child.pos.y) < 0.001
      );
      if (exists) continue;

      const sx = n.pos.x;
      const sy = n.pos.y;
      const ex = child.pos.x;
      const ey = child.pos.y;
      const dx = ex - sx;
      const dy = ey - sy;

      curves.push({
        start: { x: sx, y: sy },
        end: { x: ex, y: ey },
        cp1: { x: sx + dx * 0.25, y: sy + dy * 0.4 },
        cp2: { x: ex - dx * 0.2, y: ey - dy * 0.4 },
        zStart: n.z,
        zEnd: child.z,
        hueStart: n.hue,
        hueEnd: child.hue,
        depth: n.depth,
      });
    }
  }

  return curves;
}

// ── Bezier evaluation ────────────────────────────────────

function bezierPoint(t: number, p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function lerpHue(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * t;
}

// ── Particle types ───────────────────────────────────────

interface StaticParticle {
  x: number; y: number;
  z: number;
  hue: number;
  alpha: number;
  radius: number;
}

interface FlowParticle {
  curveIdx: number;
  t: number;
  speed: number;
  alpha: number;
}

interface StarParticle {
  x: number; y: number;
  z: number;        // 0=deep space, 1=tree plane, >1=foreground
  radius: number;
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
  hue: number;
}

interface DriftParticle {
  x: number; y: number;
  z: number;
  vx: number; vy: number;
  radius: number;
  alpha: number;
  hue: number;
}

interface NebulaWisp {
  x: number; y: number;
  radius: number;
  hue: number;
  baseAlpha: number;
  phase: number;
}

// ── Main component ───────────────────────────────────────

const STATIC_PARTICLES_PER_CURVE = 80;
const FLOW_PARTICLES_PER_CURVE = 4;
const MAX_PARTICLES = 1500;

export function PixelTree({ treeNodes, searchQuery, onNodeClick, onNodeDoubleClick, highlightedNodeId }: PixelTreeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const dimsRef = useRef({ w: 800, h: 600 });
  const mouseRef = useRef<Vec2 | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const curvesRef = useRef<BranchCurve[]>([]);
  const nodePositionsRef = useRef<{ id: string; x: number; y: number; z: number; hue: number; type: string }[]>([]);
  const staticParticlesRef = useRef<StaticParticle[]>([]);
  const flowParticlesRef = useRef<FlowParticle[]>([]);
  const isSeedRef = useRef(true);
  const cameraRef = useRef<Vec2>({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; startMouse: Vec2; startCamera: Vec2 }>({ active: false, startMouse: { x: 0, y: 0 }, startCamera: { x: 0, y: 0 } });
  const searchRef = useRef('');
  const timeRef = useRef(0);
  const starsRef = useRef<StarParticle[]>([]);
  const driftRef = useRef<DriftParticle[]>([]);
  const nebulaRef = useRef<NebulaWisp[]>([]);

  useEffect(() => { searchRef.current = searchQuery || ''; }, [searchQuery]);

  // Initialize void elements — stars, drift, nebula wisps (once on mount)
  useEffect(() => {
    // ── 3D Starfield: 5 depth layers ──
    // z: 0.05=deep-space backdrop, 0.25=far, 0.5=mid (behind tree), 0.75=near (tree plane), 1.1=foreground
    const layerDefs = [
      { zMin: 0.02, zMax: 0.12, count: 120, rMin: 0.1, rMax: 0.4, aMin: 0.08, aMax: 0.25, hueRange: [210, 240] }, // deep space — tiny cold blue specks
      { zMin: 0.15, zMax: 0.35, count: 130, rMin: 0.2, rMax: 0.7, aMin: 0.12, aMax: 0.40, hueRange: [200, 230] }, // far — small blue-white
      { zMin: 0.40, zMax: 0.60, count: 100, rMin: 0.4, rMax: 1.2, aMin: 0.18, aMax: 0.55, hueRange: [195, 250] }, // mid (tree behind) — medium
      { zMin: 0.65, zMax: 0.85, count: 70,  rMin: 0.6, rMax: 1.8, aMin: 0.25, aMax: 0.70, hueRange: [30, 220]  }, // near — larger, mixed warm/cool
      { zMin: 0.90, zMax: 1.20, count: 40,  rMin: 1.0, rMax: 3.0, aMin: 0.30, aMax: 0.85, hueRange: [30, 180]  }, // foreground — big bright stars in front
    ];

    const stars: StarParticle[] = [];
    for (const ld of layerDefs) {
      for (let i = 0; i < ld.count; i++) {
        stars.push({
          x: Math.random(),
          y: Math.random(),
          z: ld.zMin + Math.random() * (ld.zMax - ld.zMin),
          radius: ld.rMin + Math.random() * (ld.rMax - ld.rMin),
          baseAlpha: ld.aMin + Math.random() * (ld.aMax - ld.aMin),
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.2 + Math.random() * 2.0,
          hue: ld.hueRange[0] + Math.random() * (ld.hueRange[1] - ld.hueRange[0]),
        });
      }
    }
    starsRef.current = stars;

    // ── 3D Drift particles ──
    const drifts: DriftParticle[] = [];
    for (let i = 0; i < 100; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.002 + Math.random() * 0.018;
      const z = Math.random() < 0.3 ? 0.1 + Math.random() * 0.3 : 0.4 + Math.random() * 0.7; // mostly mid-to-near
      drifts.push({
        x: Math.random(),
        y: Math.random(),
        z,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 0.3 + Math.random() * 2.5 * z,
        alpha: (0.02 + Math.random() * 0.10) * (0.5 + z * 0.5),
        hue: [200, 210, 220, 260, 280, 300, 40][Math.floor(Math.random() * 7)],
      });
    }
    driftRef.current = drifts;

    // Nebula wisps — 3 large, faint cosmic clouds at different depths
    const nebulae: NebulaWisp[] = [
      { x: 0.25, y: 0.35, radius: 0.4, hue: 260, baseAlpha: 0.025, phase: 0 },
      { x: 0.7, y: 0.45, radius: 0.35, hue: 210, baseAlpha: 0.02, phase: 1.5 },
      { x: 0.5, y: 0.7, radius: 0.45, hue: 42, baseAlpha: 0.018, phase: 3.0 },
    ];
    nebulaRef.current = nebulae;
  }, []);

  // Build default 3D seed tree — lush, volumetric, branches spread in full 360°
  const buildSeedTree = useCallback((): { curves: BranchCurve[]; nodes: { id: string; x: number; y: number; z: number; hue: number; type: string }[] } => {
    const seedCurves: BranchCurve[] = [];
    const leafNodes: { id: string; x: number; y: number; z: number; hue: number; type: string }[] = [];
    const root = { x: 0.5, y: 0.88, z: 0 };
    const TRUNK_HUE = 45;
    const HUE_PALETTE = [42, 42, 150, 150, 195, 195, 260, 260];

    // Trunk — 4 segments, slight z-wobble for organic feel
    const trunkSegs = [{ y: 0.80, z: 0.0 }, { y: 0.72, z: 0.01 }, { y: 0.63, z: -0.01 }, { y: 0.53, z: 0.0 }];
    for (let i = 0; i < trunkSegs.length; i++) {
      const prev = i === 0 ? root : { x: 0.5, y: trunkSegs[i - 1].y, z: trunkSegs[i - 1].z };
      const end = { x: 0.5, y: trunkSegs[i].y, z: trunkSegs[i].z };
      seedCurves.push({
        start: { x: prev.x, y: prev.y }, end: { x: end.x, y: end.y },
        cp1: { x: 0.5, y: prev.y - 0.03 }, cp2: { x: 0.5, y: end.y + 0.03 },
        zStart: prev.z, zEnd: end.z,
        hueStart: TRUNK_HUE, hueEnd: TRUNK_HUE, depth: 0,
      });
    }

    const trunkTop = { x: 0.5, y: 0.53, z: 0 };

    // Root flare — 4 curves at base
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * 0.4 - 0.2;
      const ez = Math.sin(a * 3) * 0.04;
      seedCurves.push({
        start: { x: root.x, y: root.y }, end: { x: 0.5 + a, y: 0.92 },
        cp1: { x: 0.5 + a * 0.7, y: root.y - 0.02 }, cp2: { x: 0.5 + a, y: 0.92 },
        zStart: 0, zEnd: ez, hueStart: TRUNK_HUE, hueEnd: 42, depth: 0,
      });
    }

    // ── 3D Branching: 8 primary branches in full 360° spiral around trunk ──
    let leafId = 0;
    for (let i = 0; i < 8; i++) {
      const theta = (i / 8) * Math.PI * 2; // angle around trunk
      const hue = HUE_PALETTE[i];
      // Z-depth from angle: branches pointing toward viewer (sin~0) get z near 0, left/right get max z
      const pz = Math.sin(theta) * 0.10;
      const pxSpread = Math.cos(theta) * 0.22;
      const pyLift = 0.16 + Math.random() * 0.06;

      const px1 = 0.5 + pxSpread;
      const py1 = trunkTop.y - pyLift;

      // Primary branch
      seedCurves.push({
        start: { x: trunkTop.x, y: trunkTop.y }, end: { x: px1, y: py1 },
        cp1: { x: 0.5 + pxSpread * 0.35, y: trunkTop.y - 0.06 },
        cp2: { x: px1 - pxSpread * 0.15, y: py1 + 0.04 },
        zStart: trunkTop.z, zEnd: pz,
        hueStart: TRUNK_HUE, hueEnd: hue, depth: 1,
      });

      // ── 3-4 secondary branches per primary ──
      const secCount = 3 + Math.floor(Math.random() * 2);
      for (let j = 0; j < secCount; j++) {
        const subAngle = theta + (j - (secCount - 1) / 2) * 0.35;
        const sz = pz + Math.sin(subAngle) * 0.06;
        const sxSpread = px1 + Math.cos(subAngle) * 0.10;
        const syLift = py1 - 0.05 - Math.random() * 0.05;

        const sx1 = sxSpread;
        const sy1 = Math.max(0.08, syLift);

        seedCurves.push({
          start: { x: px1, y: py1 }, end: { x: sx1, y: sy1 },
          cp1: { x: px1 + (sx1 - px1) * 0.3, y: py1 - 0.03 },
          cp2: { x: sx1, y: sy1 + 0.02 },
          zStart: pz, zEnd: sz,
          hueStart: hue, hueEnd: hue, depth: 2,
        });

        // ── 2-3 tertiary twigs per secondary ──
        const twigCount = 2 + Math.floor(Math.random() * 2);
        for (let k = 0; k < twigCount; k++) {
          const twigAngle = subAngle + (k - (twigCount - 1) / 2) * 0.25;
          const tz = sz + Math.sin(twigAngle) * 0.03;
          const txSpread = sx1 + Math.cos(twigAngle) * 0.06;
          const tyLift = sy1 - 0.03 - Math.random() * 0.04;

          const tx1 = txSpread;
          const ty1 = Math.max(0.04, tyLift);

          seedCurves.push({
            start: { x: sx1, y: sy1 }, end: { x: tx1, y: ty1 },
            cp1: { x: sx1 + (tx1 - sx1) * 0.45, y: sy1 - 0.02 },
            cp2: { x: tx1, y: ty1 + 0.015 },
            zStart: sz, zEnd: tz,
            hueStart: hue, hueEnd: hue, depth: 3,
          });

          // Leaf node at twig tip
          leafNodes.push({
            id: `seed-${leafId++}`,
            x: tx1, y: ty1, z: tz,
            hue, type: 'leaf',
          });
        }
      }
    }

    // ── Extra: a few "wandering" smaller branches that break the radial pattern ──
    for (let i = 0; i < 6; i++) {
      const baseY = 0.70 - i * 0.05;
      const side = (i % 2 === 0) ? 1 : -1;
      const bx = 0.5 + side * (0.06 + Math.random() * 0.12);
      const by = baseY + (Math.random() - 0.5) * 0.03;
      const bz = side * (0.02 + Math.random() * 0.06);
      const hue = [150, 195, 260, 42, 150, 195][i];

      seedCurves.push({
        start: { x: 0.5, y: baseY }, end: { x: bx, y: by },
        cp1: { x: 0.5 + side * 0.04, y: baseY - 0.02 },
        cp2: { x: bx - side * 0.02, y: by + 0.015 },
        zStart: 0, zEnd: bz,
        hueStart: TRUNK_HUE, hueEnd: hue, depth: 1,
      });

      // One sub-twig from this wandering branch
      const sx = bx + side * (0.03 + Math.random() * 0.05);
      const sy = by - 0.02 - Math.random() * 0.04;
      const sz = bz + (Math.random() - 0.5) * 0.04;
      seedCurves.push({
        start: { x: bx, y: by }, end: { x: sx, y: Math.max(0.04, sy) },
        cp1: { x: bx + (sx - bx) * 0.3, y: by - 0.015 },
        cp2: { x: sx, y: sy + 0.01 },
        zStart: bz, zEnd: sz,
        hueStart: hue, hueEnd: hue, depth: 2,
      });

      leafNodes.push({
        id: `seed-w${i}`,
        x: sx, y: Math.max(0.04, sy), z: sz,
        hue, type: 'leaf',
      });
    }

    return { curves: seedCurves, nodes: leafNodes };
  }, []);

  // Build skeleton from treeNodes
  useEffect(() => {
    let curves: BranchCurve[];
    let nodePositions: { id: string; x: number; y: number; z: number; hue: number; type: string }[];

    if (treeNodes.length === 0) {
      // Seed mode — no data yet
      const seed = buildSeedTree();
      curves = seed.curves;
      nodePositions = seed.nodes;
    } else {
      const childrenMap = new Map<string, string[]>();
      for (const n of treeNodes) {
        for (const c of n.children) {
          if (!childrenMap.has(n.id)) childrenMap.set(n.id, []);
          childrenMap.get(n.id)!.push(c.id);
        }
      }

      curves = buildCurves(treeNodes, childrenMap);
      nodePositions = treeNodes.map(n => ({
        id: n.id,
        x: n.pos.x,
        y: n.pos.y,
        z: n.z,
        hue: n.hue,
        type: n.type,
      }));
    }

    curvesRef.current = curves;
    nodePositionsRef.current = nodePositions;

    // Generate static particles along curves
    const statics: StaticParticle[] = [];
    const isSeed = treeNodes.length === 0;
    const baseParticleCount = isSeed ? 1200 : Math.min(MAX_PARTICLES, curves.length * STATIC_PARTICLES_PER_CURVE);

    for (const c of curves) {
      const count = Math.max(60, Math.floor(baseParticleCount / Math.max(1, curves.length)));
      for (let i = 0; i < count; i++) {
        const t = i / count;
        const pt = bezierPoint(t, c.start, c.cp1, c.cp2, c.end);
        const hue = lerpHue(c.hueStart, c.hueEnd, t);
        const zAt = c.zStart + (c.zEnd - c.zStart) * t;
        const spread = (0.025 - c.depth * 0.004) * (0.4 + Math.random() * 1.0);
        statics.push({
          x: pt.x + (Math.random() - 0.5) * spread,
          y: pt.y + (Math.random() - 0.5) * spread,
          z: zAt + (Math.random() - 0.5) * 0.03,
          hue: (hue + 360) % 360,
          alpha: 0.18 + Math.random() * 0.55,
          radius: 1.0 + Math.random() * 3.2,
        });
      }
    }

    // Ambient scattered particles around the tree for atmosphere
    if (isSeed) {
      for (let i = 0; i < 200; i++) {
        const angle = Math.random() * Math.PI * 0.8 - Math.PI * 0.4;
        const dist = 0.12 + Math.random() * 0.50;
        const x = 0.5 + Math.cos(angle - Math.PI / 2) * dist;
        const y = 0.5 + Math.sin(angle - Math.PI / 2) * dist;
        statics.push({
          x: Math.max(0.05, Math.min(0.95, x)),
          y: Math.max(0.05, Math.min(0.95, y)),
          z: (Math.random() - 0.5) * 0.06,
          hue: [42, 150, 195, 210, 260][Math.floor(Math.random() * 5)],
          alpha: 0.04 + Math.random() * 0.12,
          radius: 0.6 + Math.random() * 1.4,
        });
      }
    }
    isSeedRef.current = treeNodes.length === 0;
    staticParticlesRef.current = statics;

    // Generate flow particles
    const flows: FlowParticle[] = [];
    for (let ci = 0; ci < curves.length; ci++) {
      const flowCount = isSeed ? 6 : FLOW_PARTICLES_PER_CURVE;
      for (let j = 0; j < flowCount; j++) {
        flows.push({
          curveIdx: ci,
          t: Math.random(),
          speed: 0.04 + Math.random() * 0.12,
          alpha: 0.5 + Math.random() * 0.5,
        });
      }
    }
    flowParticlesRef.current = flows;
  }, [treeNodes, buildSeedTree]);

  // Canvas loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dimsRef.current = { w, h };
    };
    resize();
    window.addEventListener('resize', resize);

    const handleMouse = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      mouseRef.current = { x: mx, y: my };

      // Drag rotation (3D orbit)
      if (dragRef.current.active) {
        const cam = cameraRef.current;
        cam.x = dragRef.current.startCamera.x + (mx - dragRef.current.startMouse.x) * 2.5;
        cam.y = dragRef.current.startCamera.y + (my - dragRef.current.startMouse.y) * 1.5;
        cam.x = Math.max(-1.2, Math.min(1.2, cam.x));
        cam.y = Math.max(-0.6, Math.min(0.6, cam.y));
        return;
      }

      // Check hover on nodes using 3D projection
      const { cosX, cosY, sinX, sinY } = (() => {
        const cam = cameraRef.current;
        return { cosX: Math.cos(cam.y), cosY: Math.cos(cam.x), sinX: Math.sin(cam.y), sinY: Math.sin(cam.x) };
      })();
      const nodes = nodePositionsRef.current;
      let found: string | null = null;
      for (const n of nodes) {
        const rx = n.x - 0.5;
        const ry = n.y - 0.5;
        const rx2 = rx * cosY - n.z * sinY;
        const rz2 = rx * sinY + n.z * cosY;
        const ry2 = ry * cosX - rz2 * sinX;
        const rz3 = ry * sinX + rz2 * cosX;
        const persp = 1 / (1 + rz3 * 0.35);
        const sx = 0.5 + rx2 * persp;
        const sy = 0.5 + ry2 * persp;
        const dx = sx - mx;
        const dy = sy - my;
        if (Math.sqrt(dx * dx + dy * dy) < 0.04) { found = n.id; break; }
      }
      if (hoveredNodeRef.current !== found) {
        hoveredNodeRef.current = found;
        if (canvas) canvas.style.cursor = found ? 'pointer' : dragRef.current.active ? 'grabbing' : 'grab';
      }
    };
    const handleLeave = () => {
      mouseRef.current = null;
      hoveredNodeRef.current = null;
      dragRef.current.active = false;
      if (canvas) canvas.style.cursor = 'grab';
    };
    const handleDown = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const { cosX, cosY, sinX, sinY } = { cosX: Math.cos(cam.y), cosY: Math.cos(cam.x), sinX: Math.sin(cam.y), sinY: Math.sin(cam.x) };
      const nodes = nodePositionsRef.current;
      let hitNode = false;
      for (const n of nodes) {
        const rx = n.x - 0.5;
        const ry = n.y - 0.5;
        const rx2 = rx * cosY - n.z * sinY;
        const rz2 = rx * sinY + n.z * cosY;
        const ry2 = ry * cosX - rz2 * sinX;
        const rz3 = ry * sinX + rz2 * cosX;
        const persp = 1 / (1 + rz3 * 0.35);
        const sx = 0.5 + rx2 * persp;
        const sy = 0.5 + ry2 * persp;
        if (Math.sqrt((sx - mx) ** 2 + (sy - my) ** 2) < 0.04) { hitNode = true; break; }
      }
      if (hitNode) return;

      dragRef.current = {
        active: true,
        startMouse: { x: mx, y: my },
        startCamera: { x: cam.x, y: cam.y },
      };
      if (canvas) canvas.style.cursor = 'grabbing';
    };
    const handleUp = (e: MouseEvent) => {
      if (dragRef.current.active) {
        const mx = e.clientX / window.innerWidth;
        const my = e.clientY / window.innerHeight;
        const dx = mx - dragRef.current.startMouse.x;
        const dy = my - dragRef.current.startMouse.y;
        dragRef.current.active = false;
        if (canvas) canvas.style.cursor = hoveredNodeRef.current ? 'pointer' : 'grab';
        if (Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) {
          onNodeClick?.('', 0, 0);
          return;
        }
      }
    };
    const handleClick = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const { cosX, cosY, sinX, sinY } = { cosX: Math.cos(cam.y), cosY: Math.cos(cam.x), sinX: Math.sin(cam.y), sinY: Math.sin(cam.x) };
      const nodes = nodePositionsRef.current;
      for (const n of nodes) {
        const rx = n.x - 0.5;
        const ry = n.y - 0.5;
        const rx2 = rx * cosY - n.z * sinY;
        const rz2 = rx * sinY + n.z * cosY;
        const ry2 = ry * cosX - rz2 * sinX;
        const rz3 = ry * sinX + rz2 * cosX;
        const persp = 1 / (1 + rz3 * 0.35);
        const sx = 0.5 + rx2 * persp;
        const sy = 0.5 + ry2 * persp;
        if (Math.sqrt((sx - mx) ** 2 + (sy - my) ** 2) < 0.04) {
          onNodeClick?.(n.id, e.clientX, e.clientY);
          break;
        }
      }
    };
    const handleDblClick = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const { cosX, cosY, sinX, sinY } = { cosX: Math.cos(cam.y), cosY: Math.cos(cam.x), sinX: Math.sin(cam.y), sinY: Math.sin(cam.x) };
      const nodes = nodePositionsRef.current;
      for (const n of nodes) {
        const rx = n.x - 0.5;
        const ry = n.y - 0.5;
        const rx2 = rx * cosY - n.z * sinY;
        const rz2 = rx * sinY + n.z * cosY;
        const ry2 = ry * cosX - rz2 * sinX;
        const rz3 = ry * sinX + rz2 * cosX;
        const persp = 1 / (1 + rz3 * 0.35);
        const sx = 0.5 + rx2 * persp;
        const sy = 0.5 + ry2 * persp;
        if (Math.sqrt((sx - mx) ** 2 + (sy - my) ** 2) < 0.04) {
          onNodeDoubleClick?.(n.id);
          break;
        }
      }
    };

    window.addEventListener('mousemove', handleMouse);
    window.addEventListener('mouseleave', handleLeave);
    window.addEventListener('mousedown', handleDown);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('click', handleClick);
    window.addEventListener('dblclick', handleDblClick);

    const loop = () => {
      const { w, h } = dimsRef.current;
      timeRef.current += 0.016;
      const time = timeRef.current;
      const mouse = mouseRef.current;
      const curves = curvesRef.current;
      const statics = staticParticlesRef.current;
      const flows = flowParticlesRef.current;
      const highlighted = highlightedNodeId;
      const hovered = hoveredNodeRef.current;
      const cam = cameraRef.current;
      const search = searchRef.current;
      const isSeed = isSeedRef.current;

      // ── 3D projection helper ──────────────────────────────
      const cosX = Math.cos(cam.y);
      const sinX = Math.sin(cam.y);
      const cosY = Math.cos(cam.x);
      const sinY = Math.sin(cam.x);
      const project = (wx: number, wy: number, wz: number) => {
        const rx = wx - 0.5;
        const ry = wy - 0.5;
        // Rotate around Y
        const rx2 = rx * cosY - wz * sinY;
        const rz2 = rx * sinY + wz * cosY;
        // Rotate around X
        const ry2 = ry * cosX - rz2 * sinX;
        const rz3 = ry * sinX + rz2 * cosX;
        const persp = 1 / (1 + rz3 * 0.35);
        return {
          sx: (0.5 + rx2 * persp) * w,
          sy: (0.5 + ry2 * persp) * h,
          depth: rz3,
        };
      };

      // ── Deep Void background ──────────────────────────────
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.6, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      bg.addColorStop(0, '#06041a');
      bg.addColorStop(0.35, '#030210');
      bg.addColorStop(0.7, '#010006');
      bg.addColorStop(1, '#000002');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // ── Nebula wisps ──────────────────────────────────────
      for (const neb of nebulaRef.current) {
        const driftX = Math.sin(time * 0.08 + neb.phase) * 0.04;
        const driftY = Math.cos(time * 0.06 + neb.phase) * 0.03;
        const nx = (neb.x + driftX) * w;
        const ny = (neb.y + driftY) * h;
        const nr = neb.radius * w;
        const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
        const pulseAlpha = neb.baseAlpha * (0.85 + 0.15 * Math.sin(time * 0.3 + neb.phase));
        ng.addColorStop(0, `hsla(${neb.hue}, 40%, 35%, ${pulseAlpha})`);
        ng.addColorStop(0.5, `hsla(${neb.hue}, 30%, 25%, ${pulseAlpha * 0.5})`);
        ng.addColorStop(1, 'transparent');
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── 3D Starfield with depth parallax ─────────────────
      const mpx = mouse ? (mouse.x - 0.5) * 0.03 : 0;
      const mpy = mouse ? (mouse.y - 0.5) * 0.03 : 0;

      for (const star of starsRef.current) {
        const parallaxX = cam.x * star.z + mpx * star.z;
        const parallaxY = cam.y * star.z + mpy * star.z;
        const sx = (star.x + parallaxX) * w;
        const sy = (star.y + parallaxY) * h;
        if (sx < -5 || sx > w + 5 || sy < -5 || sy > h + 5) continue;

        const twinkle = 0.5 + 0.5 * Math.sin(time * star.twinkleSpeed + star.twinklePhase);
        const twinkleBoost = 0.3 + 0.7 * star.z;
        let alpha = star.baseAlpha * (1 - twinkleBoost * 0.5 + twinkleBoost * 0.5 * twinkle);

        if (mouse) {
          const dm = Math.sqrt((mouse.x - star.x - parallaxX) ** 2 + (mouse.y - star.y - parallaxY) ** 2);
          const range = 0.04 + star.z * 0.06;
          if (dm < range) alpha *= 1 + (1 - dm / range) * (1 + star.z);
        }
        if (alpha < 0.02) continue;

        if (alpha > 0.25 && star.z > 0.6) {
          const spikeLen = star.radius * 4 * star.z;
          ctx.save();
          ctx.globalAlpha = alpha * 0.35;
          ctx.strokeStyle = `hsl(${star.hue}, 30%, 75%)`;
          ctx.lineWidth = 0.2 + star.z * 0.3;
          ctx.beginPath();
          ctx.moveTo(sx - spikeLen, sy); ctx.lineTo(sx + spikeLen, sy);
          ctx.moveTo(sx, sy - spikeLen); ctx.lineTo(sx, sy + spikeLen);
          ctx.stroke();
          ctx.restore();
        }

        const hueShift = star.z < 0.3 ? star.hue - 10 : star.hue;
        ctx.beginPath();
        ctx.arc(sx, sy, star.radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hueShift}, ${15 + star.z * 15}%, ${60 + star.z * 25}%, ${alpha})`;
        ctx.fill();
      }

      // ── 3D Drift particles ────────────────────────────────
      for (const dp of driftRef.current) {
        dp.x += dp.vx * 0.016;
        dp.y += dp.vy * 0.016;
        if (dp.x < -0.02) dp.x = 1.02;
        if (dp.x > 1.02) dp.x = -0.02;
        if (dp.y < -0.02) dp.y = 1.02;
        if (dp.y > 1.02) dp.y = -0.02;

        const parallaxX = cam.x * dp.z + mpx * dp.z;
        const parallaxY = cam.y * dp.z + mpy * dp.z;
        const px = (dp.x + parallaxX) * w;
        const py = (dp.y + parallaxY) * h;
        if (px < -10 || px > w + 10 || py < -10 || py > h + 10) continue;

        let boost = 1;
        if (mouse) {
          const dm = Math.sqrt((mouse.x - dp.x - parallaxX) ** 2 + (mouse.y - dp.y - parallaxY) ** 2);
          if (dm < 0.08) boost = 1 + (1 - dm / 0.08) * 3;
        }
        const pulse = 0.7 + 0.3 * Math.sin(time * 0.7 + dp.x * 3);
        const alpha = dp.alpha * pulse * boost;
        if (alpha < 0.01) continue;

        ctx.beginPath();
        ctx.arc(px, py, dp.radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${dp.hue}, 30%, 55%, ${alpha})`;
        ctx.fill();
      }

      // ── Faint nebula blobs at key node positions ──────────
      const nodePos = nodePositionsRef.current;
      for (const n of nodePos) {
        if (n.type === 'branch' || n.type === 'trunk') {
          const p = project(n.x, n.y, n.z);
          const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, w * 0.12);
          grad.addColorStop(0, `hsla(${n.hue}, 50%, 40%, 0.04)`);
          grad.addColorStop(1, 'transparent');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, w * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Mouse nebula
      if (mouse) {
        const mg = ctx.createRadialGradient(mouse.x * w, mouse.y * h, 0, mouse.x * w, mouse.y * h, w * 0.15);
        mg.addColorStop(0, 'hsla(200, 50%, 50%, 0.05)');
        mg.addColorStop(1, 'transparent');
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.arc(mouse.x * w, mouse.y * h, w * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Root pulse & canopy glow (at z=0 plane) ──────────
      const rootP = project(0.5, 0.88, 0);
      const rootPulse = 0.6 + 0.4 * Math.sin(time * 1.8);
      const rootR = w * 0.08;
      const rg = ctx.createRadialGradient(rootP.sx, rootP.sy, 0, rootP.sx, rootP.sy, rootR * 2);
      rg.addColorStop(0, `hsla(42, 70%, 55%, ${0.15 * rootPulse})`);
      rg.addColorStop(0.4, `hsla(42, 60%, 45%, ${0.07 * rootPulse})`);
      rg.addColorStop(1, 'transparent');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(rootP.sx, rootP.sy, rootR * 2, 0, Math.PI * 2);
      ctx.fill();

      const canopyP = project(0.5, 0.4, 0);
      const canopyR = w * 0.45;
      const canopyGlow = ctx.createRadialGradient(canopyP.sx, canopyP.sy, canopyR * 0.15, canopyP.sx, canopyP.sy, canopyR);
      const canopyPulse = 0.8 + 0.2 * Math.sin(time * 0.6);
      canopyGlow.addColorStop(0, `hsla(45, 30%, 40%, ${0.03 * canopyPulse})`);
      canopyGlow.addColorStop(0.4, `hsla(42, 25%, 30%, ${0.015 * canopyPulse})`);
      canopyGlow.addColorStop(0.7, `hsla(260, 20%, 20%, ${0.006 * canopyPulse})`);
      canopyGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = canopyGlow;
      ctx.beginPath();
      ctx.arc(canopyP.sx, canopyP.sy, canopyR, 0, Math.PI * 2);
      ctx.fill();

      // ── Depth-sort curves for back-to-front rendering ─────
      const curveDepths = curves.map((c, i) => {
        const midZ = (c.zStart + c.zEnd) / 2;
        const midX = (c.start.x + c.end.x) / 2;
        const midY = (c.start.y + c.end.y) / 2;
        const p = project(midX, midY, midZ);
        return { idx: i, depth: p.depth };
      });
      curveDepths.sort((a, b) => a.depth - b.depth);

      // Search dimming prep
      const searchLower = search.toLowerCase();
      const searchMatch = new Set<string>();
      if (searchLower && nodePos.length > 0) {
        for (const n of nodePos) {
          if (n.id.toLowerCase().includes(searchLower)) searchMatch.add(n.id);
        }
      }

      // ── Draw branch backbones (depth-sorted) ──────────────
      for (const cd of curveDepths) {
        const c = curves[cd.idx];
        const ps = project(c.start.x, c.start.y, c.zStart);
        const pe = project(c.end.x, c.end.y, c.zEnd);
        const pcp1 = project(c.cp1.x, c.cp1.y, (c.zStart * 0.7 + c.zEnd * 0.3));
        const pcp2 = project(c.cp2.x, c.cp2.y, (c.zStart * 0.3 + c.zEnd * 0.7));

        // Mouse proximity boost (use projected mid-point for screen-space check)
        const midSX = (ps.sx + pe.sx) / 2;
        const midSY = (ps.sy + pe.sy) / 2;
        let mouseBoost = 1;
        if (mouse) {
          const dm = Math.sqrt((mouse.x * w - midSX) ** 2 + (mouse.y * h - midSY) ** 2) / w;
          if (dm < 0.1) mouseBoost = 1 + (1 - dm / 0.1) * 2.5;
        }

        const trunkFactor = c.depth === 0 ? 2 : 1;
        const depthFade = 1 / (1 + ps.depth * 0.6); // far branches dimmer
        const glowAlpha = (isSeed ? 0.12 : 0.08) * mouseBoost * depthFade;

        // Outer glow
        ctx.beginPath();
        ctx.moveTo(ps.sx, ps.sy);
        ctx.bezierCurveTo(pcp1.sx, pcp1.sy, pcp2.sx, pcp2.sy, pe.sx, pe.sy);
        ctx.strokeStyle = `hsla(${c.hueStart}, 50%, 40%, ${glowAlpha * trunkFactor})`;
        ctx.lineWidth = (4 + (4 - c.depth) * 2) * trunkFactor;
        ctx.shadowColor = `hsla(${c.hueStart}, 60%, 50%, ${0.15 * mouseBoost * depthFade})`;
        ctx.shadowBlur = 10 * mouseBoost;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Mid glow
        ctx.beginPath();
        ctx.moveTo(ps.sx, ps.sy);
        ctx.bezierCurveTo(pcp1.sx, pcp1.sy, pcp2.sx, pcp2.sy, pe.sx, pe.sy);
        ctx.strokeStyle = `hsla(${c.hueStart}, 60%, 55%, ${0.07 * trunkFactor * mouseBoost * depthFade})`;
        ctx.lineWidth = (2 + (3 - c.depth)) * trunkFactor;
        ctx.stroke();

        // Core
        ctx.beginPath();
        ctx.moveTo(ps.sx, ps.sy);
        ctx.bezierCurveTo(pcp1.sx, pcp1.sy, pcp2.sx, pcp2.sy, pe.sx, pe.sy);
        ctx.strokeStyle = `hsla(${c.hueStart}, 70%, 65%, ${0.05 * trunkFactor * mouseBoost * depthFade})`;
        ctx.lineWidth = 1.2 * trunkFactor;
        ctx.stroke();
      }

      // ── Update & draw flow particles (3D projected) ───────
      for (const fp of flows) {
        if (fp.curveIdx >= curves.length) continue;
        const c = curves[fp.curveIdx];
        const pt = bezierPoint(fp.t, c.start, c.cp1, c.cp2, c.end);
        const zt = c.zStart + (c.zEnd - c.zStart) * fp.t;
        const p = project(pt.x, pt.y, zt);

        let speedMul = 1;
        if (mouse) {
          const dm = Math.sqrt((mouse.x * w - p.sx) ** 2 + (mouse.y * h - p.sy) ** 2) / w;
          if (dm < 0.08) speedMul = 1 + (1 - dm / 0.08) * 4;
        }
        fp.t += fp.speed * speedMul * 0.016;
        if (fp.t > 1) fp.t -= 1;
        if (fp.t < 0) fp.t += 1;

        const hue = lerpHue(c.hueStart, c.hueEnd, fp.t);
        const pulse = 0.7 + 0.3 * Math.sin(time * 3 + fp.t * 10);
        const glowAlpha = fp.alpha * pulse * Math.min(2, speedMul);

        const glowSize = 8 * Math.min(1.8, speedMul);
        const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowSize);
        glow.addColorStop(0, `hsla(${(hue + 360) % 360}, 80%, 70%, ${glowAlpha})`);
        glow.addColorStop(0.4, `hsla(${(hue + 360) % 360}, 60%, 50%, ${glowAlpha * 0.5})`);
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, glowSize, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${(hue + 360) % 360}, 80%, 85%, ${glowAlpha * 1.2})`;
        ctx.fill();
      }

      // ── Draw static particles (3D projected, depth-sorted) ─
      if (statics.length > 0) {
        // Build depth-sorted indices
        const sortedStatics = statics.map((sp, i) => {
          const p = project(sp.x, sp.y, sp.z);
          return { i, depth: p.depth, sx: p.sx, sy: p.sy };
        });
        sortedStatics.sort((a, b) => b.depth - a.depth); // back to front

        for (const ss of sortedStatics) {
          const sp = statics[ss.i];
          const sx = ss.sx;
          const sy = ss.sy;
          if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;

          let boost = 1;
          if (mouse) {
            const dm = Math.sqrt((mouse.x * w - sx) ** 2 + (mouse.y * h - sy) ** 2);
            if (dm < 80) boost = 1 + (1 - dm / 80) * 2;
          }

          let searchDim = 1;
          if (searchLower && nodePos.length > 0) {
            searchDim = searchMatch.size > 0 ? 0.15 : 1;
          }

          const pulse = 0.8 + 0.2 * Math.sin(time * 1.5 + sp.x * 0.01 + sp.y * 0.01);
          let alpha = sp.alpha * pulse * boost * searchDim;

          if (highlighted && !hovered) alpha *= 0.25;
          if (alpha < 0.04) continue;

          if (sp.alpha > 0.3 || boost > 1) {
            ctx.beginPath();
            ctx.arc(sx, sy, sp.radius * 2.5, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${sp.hue}, 50%, 55%, ${alpha * 0.35})`;
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(sx, sy, sp.radius, 0, Math.PI * 2);
          const lightness = sp.alpha > 0.35 || boost > 1 ? 75 : 55;
          ctx.fillStyle = `hsla(${sp.hue}, 45%, ${lightness}%, ${alpha})`;
          ctx.fill();
        }
      }

      // ── Draw leaf nodes (3D projected, depth-sorted) ──────
      const projectedLeaves = nodePos
        .filter(n => n.type === 'leaf' || n.type === 'file')
        .map(n => ({ ...project(n.x, n.y, n.z), node: n }))
        .sort((a, b) => b.depth - a.depth);

      for (const pl of projectedLeaves) {
        const n = pl.node;
        const pulse = 0.6 + 0.4 * Math.sin(time * 2.2 + n.x * 5);
        const isHighlighted = highlighted === n.id;
        const isHovered = hovered === n.id;

        let vibX = 0, vibY = 0;
        if (isHovered) {
          vibX = Math.sin(time * 25) * 3;
          vibY = Math.cos(time * 23) * 3;
        }

        const size = isHighlighted || isHovered ? 16 : 10;
        const alpha = isHighlighted || isHovered ? 0.9 : 0.5 * pulse;

        const nx = pl.sx + vibX;
        const ny = pl.sy + vibY;

        const lg = ctx.createRadialGradient(nx, ny, 0, nx, ny, size * 3);
        lg.addColorStop(0, `hsla(${n.hue}, 70%, 60%, ${alpha * 0.6})`);
        lg.addColorStop(0.5, `hsla(${n.hue}, 50%, 40%, ${alpha * 0.2})`);
        lg.addColorStop(1, 'transparent');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(nx, ny, size * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(nx, ny, isHighlighted || isHovered ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${n.hue}, 60%, ${isHighlighted || isHovered ? 85 : 70}%, ${alpha})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(nx, ny, size, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${n.hue}, 60%, 60%, ${alpha * (isHovered ? 0.7 : 0.4)})`;
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouse);
      window.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('mousedown', handleDown);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('dblclick', handleDblClick);
    };
  }, [onNodeClick, onNodeDoubleClick, highlightedNodeId]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0"
      style={{ background: '#010005', zIndex: 0, cursor: 'grab' }}
    />
  );
}

export { layoutTree, TIER_HUES, TRUNK_HUE, FILE_HUE };
export type { TreeNode, MemoryNode, FileEntry };
