import type { RawInput, Cycle, Ceo } from '@/db/schema';

export interface ProjectionContext {
  rawInput: RawInput;
  cycle: Cycle | null;
  ceo: Ceo;
}

export type Projector = (ctx: ProjectionContext) => Promise<void>;
