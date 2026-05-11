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
  x: number; y: number;  // world-space (0-1)
  hue: number;
  alpha: number;
  radius: number;
}

interface FlowParticle {
  curveIdx: number;
  t: number;          // position along curve (0-1)
  speed: number;
  alpha: number;
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
  const nodePositionsRef = useRef<{ id: string; x: number; y: number; hue: number; type: string }[]>([]);
  const staticParticlesRef = useRef<StaticParticle[]>([]);
  const flowParticlesRef = useRef<FlowParticle[]>([]);
  const isSeedRef = useRef(true);
  const cameraRef = useRef<Vec2>({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; startMouse: Vec2; startCamera: Vec2 }>({ active: false, startMouse: { x: 0, y: 0 }, startCamera: { x: 0, y: 0 } });
  const searchRef = useRef('');
  const timeRef = useRef(0);

  useEffect(() => { searchRef.current = searchQuery || ''; }, [searchQuery]);

  // Build default seed tree — impressive from first open
  const buildSeedTree = useCallback((): { curves: BranchCurve[]; nodes: { id: string; x: number; y: number; hue: number; type: string }[] } => {
    const seedCurves: BranchCurve[] = [];
    const root = { x: 0.5, y: 0.88 };
    const trunkHue = 45;

    // Main trunk — thicker at base, tapering up in segments
    const trunkSegments = [
      { y: 0.80, w: 0.03 },
      { y: 0.72, w: 0.02 },
      { y: 0.63, w: 0.015 },
      { y: 0.54, w: 0.01 },
    ];
    for (let i = 0; i < trunkSegments.length; i++) {
      const start = i === 0 ? root : { x: 0.5, y: trunkSegments[i - 1].y };
      const end = { x: 0.5, y: trunkSegments[i].y };
      seedCurves.push({
        start, end,
        cp1: { x: 0.5, y: start.y - 0.03 }, cp2: { x: 0.5, y: end.y + 0.03 },
        hueStart: trunkHue, hueEnd: trunkHue, depth: 0,
      });
    }

    const trunkTop = { x: 0.5, y: 0.54 };

    // Primary branches — wider spread, more dramatic
    const primaryBranches = [
      { end: { x: 0.28, y: 0.38 }, cpx: 0.38, hue: 42 },
      { end: { x: 0.46, y: 0.30 }, cpx: 0.48, hue: 150 },
      { end: { x: 0.54, y: 0.30 }, cpx: 0.52, hue: 150 },
      { end: { x: 0.72, y: 0.38 }, cpx: 0.62, hue: 195 },
      { end: { x: 0.20, y: 0.48 }, cpx: 0.35, hue: 42 },
      { end: { x: 0.80, y: 0.48 }, cpx: 0.65, hue: 260 },
    ];

    for (const pb of primaryBranches) {
      seedCurves.push({
        start: trunkTop, end: pb.end,
        cp1: { x: pb.cpx, y: trunkTop.y - 0.06 },
        cp2: { x: pb.end.x, y: pb.end.y + 0.04 },
        hueStart: trunkHue, hueEnd: pb.hue, depth: 1,
      });
    }

    // Secondary branches
    const secondaryBranches = [
      { parent: primaryBranches[0].end, end: { x: 0.18, y: 0.22 }, hue: 42 },
      { parent: primaryBranches[0].end, end: { x: 0.32, y: 0.24 }, hue: 42 },
      { parent: primaryBranches[1].end, end: { x: 0.40, y: 0.16 }, hue: 150 },
      { parent: primaryBranches[2].end, end: { x: 0.60, y: 0.16 }, hue: 150 },
      { parent: primaryBranches[3].end, end: { x: 0.68, y: 0.22 }, hue: 195 },
      { parent: primaryBranches[3].end, end: { x: 0.82, y: 0.24 }, hue: 260 },
      { parent: primaryBranches[4].end, end: { x: 0.14, y: 0.28 }, hue: 42 },
      { parent: primaryBranches[5].end, end: { x: 0.86, y: 0.28 }, hue: 260 },
    ];

    for (const sb of secondaryBranches) {
      seedCurves.push({
        start: sb.parent, end: sb.end,
        cp1: { x: sb.parent.x + (sb.end.x - sb.parent.x) * 0.25, y: sb.parent.y - 0.04 },
        cp2: { x: sb.end.x, y: sb.end.y + 0.03 },
        hueStart: sb.hue, hueEnd: sb.hue, depth: 2,
      });
    }

    // Tertiary twigs
    const twigs = [
      { parent: secondaryBranches[0].end, end: { x: 0.13, y: 0.14 }, hue: 42 },
      { parent: secondaryBranches[1].end, end: { x: 0.30, y: 0.15 }, hue: 42 },
      { parent: secondaryBranches[2].end, end: { x: 0.38, y: 0.09 }, hue: 150 },
      { parent: secondaryBranches[3].end, end: { x: 0.62, y: 0.09 }, hue: 150 },
      { parent: secondaryBranches[4].end, end: { x: 0.70, y: 0.15 }, hue: 195 },
      { parent: secondaryBranches[5].end, end: { x: 0.87, y: 0.16 }, hue: 260 },
      { parent: secondaryBranches[6].end, end: { x: 0.10, y: 0.18 }, hue: 42 },
      { parent: secondaryBranches[7].end, end: { x: 0.90, y: 0.18 }, hue: 260 },
    ];

    for (const tw of twigs) {
      seedCurves.push({
        start: tw.parent, end: tw.end,
        cp1: { x: tw.parent.x + (tw.end.x - tw.parent.x) * 0.4, y: tw.parent.y - 0.03 },
        cp2: { x: tw.end.x, y: tw.end.y + 0.02 },
        hueStart: tw.hue, hueEnd: tw.hue, depth: 3,
      });
    }

    // Root flare — short curves at the base spreading outward
    const rootFlare = [
      { end: { x: 0.42, y: 0.92 }, hue: 42 },
      { end: { x: 0.58, y: 0.92 }, hue: 45 },
    ];
    for (const rf of rootFlare) {
      seedCurves.push({
        start: root, end: rf.end,
        cp1: { x: rf.end.x, y: root.y - 0.02 },
        cp2: { x: rf.end.x, y: rf.end.y },
        hueStart: trunkHue, hueEnd: rf.hue, depth: 0,
      });
    }

    const leafNodes = twigs.map((tw, i) => ({
      id: `seed-${i}`,
      x: tw.end.x,
      y: tw.end.y,
      hue: tw.hue,
      type: 'leaf' as const,
    }));

    return { curves: seedCurves, nodes: leafNodes };
  }, []);

  // Build skeleton from treeNodes
  useEffect(() => {
    let curves: BranchCurve[];
    let nodePositions: { id: string; x: number; y: number; hue: number; type: string }[];

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
        hue: n.hue,
        type: n.type,
      }));
    }

    curvesRef.current = curves;
    nodePositionsRef.current = nodePositions;

    // Generate static particles along curves
    const statics: StaticParticle[] = [];
    const isSeed = treeNodes.length === 0;
    const baseParticleCount = isSeed ? 600 : Math.min(MAX_PARTICLES, curves.length * STATIC_PARTICLES_PER_CURVE);

    for (const c of curves) {
      const count = Math.max(40, Math.floor(baseParticleCount / Math.max(1, curves.length)));
      for (let i = 0; i < count; i++) {
        const t = i / count;
        const pt = bezierPoint(t, c.start, c.cp1, c.cp2, c.end);
        const hue = lerpHue(c.hueStart, c.hueEnd, t);
        const spread = (0.022 - c.depth * 0.004) * (0.5 + Math.random() * 0.9);
        statics.push({
          x: pt.x + (Math.random() - 0.5) * spread,
          y: pt.y + (Math.random() - 0.5) * spread,
          hue: (hue + 360) % 360,
          alpha: 0.2 + Math.random() * 0.55,
          radius: 1.2 + Math.random() * 2.8,
        });
      }
    }

    // Ambient scattered particles around the tree for atmosphere
    if (isSeed) {
      for (let i = 0; i < 150; i++) {
        const angle = Math.random() * Math.PI * 0.8 - Math.PI * 0.4;
        const dist = 0.15 + Math.random() * 0.45;
        const x = 0.5 + Math.cos(angle - Math.PI / 2) * dist;
        const y = 0.5 + Math.sin(angle - Math.PI / 2) * dist;
        statics.push({
          x: Math.max(0.05, Math.min(0.95, x)),
          y: Math.max(0.05, Math.min(0.95, y)),
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

      // Drag panning
      if (dragRef.current.active) {
        const cam = cameraRef.current;
        cam.x = dragRef.current.startCamera.x + (mx - dragRef.current.startMouse.x);
        cam.y = dragRef.current.startCamera.y + (my - dragRef.current.startMouse.y);
        // Clamp camera
        cam.x = Math.max(-0.3, Math.min(0.3, cam.x));
        cam.y = Math.max(-0.2, Math.min(0.2, cam.y));
        return;
      }

      // Check hover on nodes (accounting for camera offset)
      const cam = cameraRef.current;
      const nodes = nodePositionsRef.current;
      let found: string | null = null;
      for (const n of nodes) {
        const dx = (n.x + cam.x) - mx;
        const dy = (n.y + cam.y) - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.04) { found = n.id; break; }
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
      // Check if clicking on a node first
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const nodes = nodePositionsRef.current;
      let hitNode = false;
      for (const n of nodes) {
        const dx = (n.x + cam.x) - mx;
        const dy = (n.y + cam.y) - my;
        if (Math.sqrt(dx * dx + dy * dy) < 0.04) { hitNode = true; break; }
      }
      if (hitNode) return; // Let click handler deal with it

      dragRef.current = {
        active: true,
        startMouse: { x: mx, y: my },
        startCamera: { x: cam.x, y: cam.y },
      };
      if (canvas) canvas.style.cursor = 'grabbing';
    };
    const handleUp = (e: MouseEvent) => {
      if (dragRef.current.active) {
        // If barely moved, treat as click on empty space (deselect)
        const mx = e.clientX / window.innerWidth;
        const my = e.clientY / window.innerHeight;
        const dx = mx - dragRef.current.startMouse.x;
        const dy = my - dragRef.current.startMouse.y;
        dragRef.current.active = false;
        if (canvas) canvas.style.cursor = hoveredNodeRef.current ? 'pointer' : 'grab';
        if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) {
          // Click on empty space
          onNodeClick?.('', 0, 0);
          return;
        }
      }
    };
    const handleClick = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const nodes = nodePositionsRef.current;
      for (const n of nodes) {
        const dx = (n.x + cam.x) - mx;
        const dy = (n.y + cam.y) - my;
        if (Math.sqrt(dx * dx + dy * dy) < 0.04) {
          onNodeClick?.(n.id, e.clientX, e.clientY);
          break;
        }
      }
    };
    const handleDblClick = (e: MouseEvent) => {
      const mx = e.clientX / window.innerWidth;
      const my = e.clientY / window.innerHeight;
      const cam = cameraRef.current;
      const nodes = nodePositionsRef.current;
      for (const n of nodes) {
        const dx = (n.x + cam.x) - mx;
        const dy = (n.y + cam.y) - my;
        if (Math.sqrt(dx * dx + dy * dy) < 0.04) {
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

      // Deep space background — radial gradient
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.65, 0, w * 0.5, h * 0.5, Math.max(w, h));
      bg.addColorStop(0, '#08061a');
      bg.addColorStop(0.5, '#040310');
      bg.addColorStop(1, '#010005');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Faint nebula blobs at key node positions
      const nodePos = nodePositionsRef.current;
      for (const n of nodePos) {
        if (n.type === 'branch' || n.type === 'trunk') {
          const nx = (n.x + cam.x) * w;
          const ny = (n.y + cam.y) * h;
          const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, w * 0.12);
          grad.addColorStop(0, `hsla(${n.hue}, 50%, 40%, 0.04)`);
          grad.addColorStop(1, 'transparent');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(nx, ny, w * 0.12, 0, Math.PI * 2);
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

      // Root pulse — glowing heartbeat at the tree base
      const rootPulse = 0.6 + 0.4 * Math.sin(time * 1.8);
      const rootX = (0.5 + cam.x) * w;
      const rootY = (0.88 + cam.y) * h;
      const rootR = w * 0.08;
      const rg = ctx.createRadialGradient(rootX, rootY, 0, rootX, rootY, rootR * 2);
      rg.addColorStop(0, `hsla(42, 70%, 55%, ${0.15 * rootPulse})`);
      rg.addColorStop(0.4, `hsla(42, 60%, 45%, ${0.07 * rootPulse})`);
      rg.addColorStop(1, 'transparent');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(rootX, rootY, rootR * 2, 0, Math.PI * 2);
      ctx.fill();

      // Check if any node name matches search (for dimming)
      const searchLower = search.toLowerCase();
      const searchMatch = new Set<string>();
      if (searchLower && nodePos.length > 0) {
        for (const n of nodePos) {
          if (n.id.toLowerCase().includes(searchLower)) searchMatch.add(n.id);
        }
      }

      // Draw branch backbone glows — dramatic beams behind particles
      const isSeed = isSeedRef.current;
      for (const c of curves) {
        const sx = (c.start.x + cam.x) * w, sy = (c.start.y + cam.y) * h;
        const ex = (c.end.x + cam.x) * w, ey = (c.end.y + cam.y) * h;
        const csx = (c.cp1.x + cam.x) * w, csy = (c.cp1.y + cam.y) * h;
        const cex = (c.cp2.x + cam.x) * w, cey = (c.cp2.y + cam.y) * h;

        // Mouse proximity boost
        let mouseBoost = 1;
        if (mouse) {
          const midX = (sx + ex) / 2 / w;
          const midY = (sy + ey) / 2 / h;
          const dm = Math.sqrt((mouse.x - midX) ** 2 + (mouse.y - midY) ** 2);
          if (dm < 0.1) mouseBoost = 1 + (1 - dm / 0.1) * 2.5;
        }

        const trunkFactor = c.depth === 0 ? 2 : 1;
        const glowAlpha = (isSeed ? 0.12 : 0.08) * mouseBoost;

        // Outer glow
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(csx, csy, cex, cey, ex, ey);
        ctx.strokeStyle = `hsla(${c.hueStart}, 50%, 40%, ${glowAlpha * trunkFactor})`;
        ctx.lineWidth = (4 + (4 - c.depth) * 2) * trunkFactor;
        ctx.shadowColor = `hsla(${c.hueStart}, 60%, 50%, ${0.15 * mouseBoost})`;
        ctx.shadowBlur = 10 * mouseBoost;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Mid glow
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(csx, csy, cex, cey, ex, ey);
        ctx.strokeStyle = `hsla(${c.hueStart}, 60%, 55%, ${0.07 * trunkFactor * mouseBoost})`;
        ctx.lineWidth = (2 + (3 - c.depth)) * trunkFactor;
        ctx.stroke();

        // Bright core
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(csx, csy, cex, cey, ex, ey);
        ctx.strokeStyle = `hsla(${c.hueStart}, 70%, 65%, ${0.05 * trunkFactor * mouseBoost})`;
        ctx.lineWidth = 1.2 * trunkFactor;
        ctx.stroke();
      }

      // Update & draw flow particles — with mouse proximity acceleration
      for (const fp of flows) {
        if (fp.curveIdx >= curves.length) continue;
        const c = curves[fp.curveIdx];
        const pt = bezierPoint(fp.t, c.start, c.cp1, c.cp2, c.end);

        // Mouse proximity: accelerate flow
        let speedMul = 1;
        if (mouse) {
          const dm = Math.sqrt((mouse.x - (pt.x + cam.x)) ** 2 + (mouse.y - (pt.y + cam.y)) ** 2);
          if (dm < 0.08) speedMul = 1 + (1 - dm / 0.08) * 4;
        }
        fp.t += fp.speed * speedMul * 0.016;
        if (fp.t > 1) fp.t -= 1;
        if (fp.t < 0) fp.t += 1;

        const hue = lerpHue(c.hueStart, c.hueEnd, fp.t);

        // Pulsing glow — brighter near mouse
        const pulse = 0.7 + 0.3 * Math.sin(time * 3 + fp.t * 10);
        const glowAlpha = fp.alpha * pulse * Math.min(2, speedMul);

        const px = (pt.x + cam.x) * w;
        const py = (pt.y + cam.y) * h;
        const glowSize = 8 * Math.min(1.8, speedMul);

        // Outer glow
        const glow = ctx.createRadialGradient(px, py, 0, px, py, glowSize);
        glow.addColorStop(0, `hsla(${(hue + 360) % 360}, 80%, 70%, ${glowAlpha})`);
        glow.addColorStop(0.4, `hsla(${(hue + 360) % 360}, 60%, 50%, ${glowAlpha * 0.5})`);
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(px, py, glowSize, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${(hue + 360) % 360}, 80%, 85%, ${glowAlpha * 1.2})`;
        ctx.fill();
      }

      // Draw static particles
      if (statics.length > 0) {
        for (const sp of statics) {
          const sx = (sp.x + cam.x) * w;
          const sy = (sp.y + cam.y) * h;

          // Skip off-screen
          if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;

          // Mouse proximity boost
          let boost = 1;
          if (mouse) {
            const dm = Math.sqrt((mouse.x * w - sx) ** 2 + (mouse.y * h - sy) ** 2);
            if (dm < 80) boost = 1 + (1 - dm / 80) * 2;
          }

          // Search dimming
          let searchDim = 1;
          if (searchLower && nodePos.length > 0) {
            searchDim = searchMatch.size > 0 ? 0.15 : 1;
          }

          // Subtle pulse
          const pulse = 0.8 + 0.2 * Math.sin(time * 1.5 + sp.x * 0.01 + sp.y * 0.01);
          let alpha = sp.alpha * pulse * boost * searchDim;

          // Dim when a node is highlighted but this isn't in the glow zone
          if (highlighted && !hovered) alpha *= 0.25;

          if (alpha < 0.04) continue;

          // Tiny glow for brighter particles
          if (sp.alpha > 0.3 || boost > 1) {
            ctx.beginPath();
            ctx.arc(sx, sy, sp.radius * 2.5, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${sp.hue}, 50%, 55%, ${alpha * 0.35})`;
            ctx.fill();
          }

          // Particle core
          ctx.beginPath();
          ctx.arc(sx, sy, sp.radius, 0, Math.PI * 2);
          const lightness = sp.alpha > 0.35 || boost > 1 ? 75 : 55;
          ctx.fillStyle = `hsla(${sp.hue}, 45%, ${lightness}%, ${alpha})`;
          ctx.fill();
        }
      }

      // Draw leaf node glows (pulsing, with hover vibration)
      for (const n of nodePos) {
        if (n.type === 'leaf' || n.type === 'file') {
          const pulse = 0.6 + 0.4 * Math.sin(time * 2.2 + n.x * 5);
          const isHighlighted = highlighted === n.id;
          const isHovered = hovered === n.id;

          // Vibration offset when hovered
          let vibX = 0, vibY = 0;
          if (isHovered) {
            vibX = Math.sin(time * 25) * 3;
            vibY = Math.cos(time * 23) * 3;
          }

          const size = isHighlighted || isHovered ? 16 : 10;
          const alpha = isHighlighted || isHovered ? 0.9 : 0.5 * pulse;

          const nx = (n.x + cam.x) * w + vibX;
          const ny = (n.y + cam.y) * h + vibY;

          // Outer glow
          const lg = ctx.createRadialGradient(nx, ny, 0, nx, ny, size * 3);
          lg.addColorStop(0, `hsla(${n.hue}, 70%, 60%, ${alpha * 0.6})`);
          lg.addColorStop(0.5, `hsla(${n.hue}, 50%, 40%, ${alpha * 0.2})`);
          lg.addColorStop(1, 'transparent');
          ctx.fillStyle = lg;
          ctx.beginPath();
          ctx.arc(nx, ny, size * 3, 0, Math.PI * 2);
          ctx.fill();

          // Bright core
          ctx.beginPath();
          ctx.arc(nx, ny, isHighlighted || isHovered ? 5 : 3, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${n.hue}, 60%, ${isHighlighted || isHovered ? 85 : 70}%, ${alpha})`;
          ctx.fill();

          // Ring — thicker when hovered
          ctx.beginPath();
          ctx.arc(nx, ny, size, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${n.hue}, 60%, 60%, ${alpha * (isHovered ? 0.7 : 0.4)})`;
          ctx.lineWidth = isHovered ? 2 : 1;
          ctx.stroke();
        }
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
