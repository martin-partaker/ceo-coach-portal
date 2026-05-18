import { CeoAvatar } from '@/components/ui/ceo-avatar';
import { cn } from '@/lib/utils';

/**
 * Stacked-avatar group for a coaching team. Renders up to `max` member
 * avatars with negative spacing and a ring-background separator so the
 * overlap reads cleanly; overflow becomes a "+N" chip with the hidden
 * member names in the tooltip.
 *
 * Uses `rounded-full` on each avatar (overriding CeoAvatar's default
 * rounded-lg) — the stacked look only works with circles; chunky
 * rounded-square overlaps were the visual weirdness Megan flagged.
 *
 * One canonical implementation so the roster row and the Manager view
 * stay visually consistent.
 */

interface TeamAvatarsProps {
  members: Array<{
    id: string;
    name: string;
    avatarUrl: string | null;
    memberRole?: string | null;
  }>;
  /** ID of the "anchor" / lead member — gets a subtle dark ring so it's
   *  distinguishable when the team has 3+ members. Optional. */
  leadId?: string;
  size?: 'xs' | 'sm' | 'md';
  /** How many to render before collapsing the rest into a "+N" chip. */
  max?: number;
  className?: string;
}

const SIZE_BOX: Record<NonNullable<TeamAvatarsProps['size']>, string> = {
  xs: 'h-6 w-6 text-[9px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
};

const CEO_AVATAR_SIZE: Record<
  NonNullable<TeamAvatarsProps['size']>,
  'sm' | 'md'
> = {
  xs: 'sm', // CeoAvatar's smallest is sm (h-8) — we shrink via wrapper class
  sm: 'sm',
  md: 'md',
};

export function TeamAvatars({
  members,
  leadId,
  size = 'sm',
  max = 3,
  className,
}: TeamAvatarsProps) {
  const visible = members.slice(0, max);
  const hidden = members.slice(max);
  return (
    <div className={cn('flex shrink-0 -space-x-1.5', className)}>
      {visible.map((m) => (
        <CeoAvatar
          key={m.id}
          name={m.name}
          avatarUrl={m.avatarUrl}
          size={CEO_AVATAR_SIZE[size]}
          className={cn(
            // Override CeoAvatar's rounded-lg — stacked groups read best as
            // circles. Ring-background crisps the boundary between
            // overlapping avatars.
            'rounded-full ring-2 ring-background',
            // The wrapper sizes for xs are slightly smaller than CeoAvatar's
            // built-in sm; we re-size via the explicit class here.
            size === 'xs' && 'h-6 w-6 text-[9px]',
            leadId && m.id === leadId && 'ring-foreground/25',
          )}
        />
      ))}
      {hidden.length > 0 && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background',
            SIZE_BOX[size],
          )}
          title={hidden.map((m) => m.name).join(', ')}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}
