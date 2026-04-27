import { cn } from '@/lib/utils';

interface CeoAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<CeoAvatarProps['size']>, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-base',
};

export function CeoAvatar({ name, avatarUrl, size = 'md', className }: CeoAvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-amber-200/40 font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
        SIZE_CLASSES[size],
        className
      )}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={name}
          className="h-full w-full object-cover"
          onError={(e) => {
            // Hide the broken image so the initials show through.
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : null}
      <span className={avatarUrl ? 'absolute inset-0 -z-10 flex items-center justify-center' : ''}>
        {initials}
      </span>
    </div>
  );
}
