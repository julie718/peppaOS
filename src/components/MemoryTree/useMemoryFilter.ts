import { useMemo } from 'react';
import { TreeNode3D, BranchCurve3D, TimelineState } from './types';

export interface FilteredData {
  nodes: TreeNode3D[];
  curves: BranchCurve3D[];
}

/** Filter nodes & curves by timeline cutoff only. Search dimming is handled in the 3D scene. */
export function useMemoryFilter(
  nodes: TreeNode3D[],
  curves: BranchCurve3D[],
  timeline: TimelineState,
): FilteredData {
  return useMemo(() => {
    if (!timeline.before) return { nodes, curves };

    const cutoff = new Date(timeline.before).getTime();
    const visibleIds = new Set(
      nodes
        .filter(n => {
          const createdAt = n.memoryData?.createdAt || n.fileData?.createdAt;
          if (!createdAt) return true;
          return new Date(createdAt).getTime() <= cutoff;
        })
        .map(n => n.id),
    );

    // Include parent/ancestor nodes
    for (const n of nodes) {
      if (visibleIds.has(n.id) && n.memoryData?.parentId) {
        visibleIds.add(n.memoryData.parentId);
      }
    }

    const timeFiltered = nodes.filter(n => visibleIds.has(n.id));
    const curveFiltered = curves.filter(c => {
      const endPos = c.curve.v2;
      return timeFiltered.some(n => n.position.distanceToSquared(endPos) < 0.001);
    });

    return { nodes: timeFiltered, curves: curveFiltered };
  }, [nodes, curves, timeline]);
}
