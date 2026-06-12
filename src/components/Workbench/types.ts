// Infinite Canvas Workbench — type definitions

export type CardType =
  | 'user_request'
  | 'stage_header'
  | 'tool_call'
  | 'source_citation'
  | 'artifact'
  | 'reasoning_text'
  | 'final_output'
  | 'error';

export interface CanvasCard {
  id: string;
  type: CardType;
  text: string;
  detail?: string;
  timestamp: number;
  groupId: string;
  parentId?: string;
  status?: 'running' | 'done' | 'error';
  metadata?: Record<string, any>;
}

export interface CanvasSession {
  id: string;
  title: string;
  taskText: string;
  cards: CanvasCard[];
  status: 'active' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface PositionedCard extends CanvasCard {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasSessionSummary {
  id: string;
  title: string;
  taskText: string;
  status: string;
  cardCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ViewportState {
  scale: number;
  translateX: number;
  translateY: number;
}
