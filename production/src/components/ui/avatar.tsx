/**
 * Avatar — circle with initials or image.
 *
 * @example
 * <Avatar initials="PA" color="amber" />
 * <Avatar src="/users/rajesh.jpg" alt="Rajesh K" fallback="RK" />
 * <Avatar initials="RB" status="online" size="lg" />
 */
import Image from "next/image";
import { cva, type VariantProps } from "class-variance-authority";
import { cn, initials as makeInitials } from "@/lib/utils";

// Pixel sizes mirroring the Tailwind size variants. Used to give next/image
// concrete width/height props (it needs them when not using `fill`).
const sizePx: Record<NonNullable<AvatarProps["size"]>, number> = {
  xs: 20,
  sm: 28,
  md: 36,
  lg: 48,
  xl: 64,
};

const avatarVariants = cva(
  "inline-flex items-center justify-center rounded-full font-semibold flex-shrink-0 select-none",
  {
    variants: {
      size: {
        xs: "w-5 h-5 text-3xs",
        sm: "w-7 h-7 text-2xs",
        md: "w-9 h-9 text-xs",
        lg: "w-12 h-12 text-sm",
        xl: "w-16 h-16 text-lg",
      },
      color: {
        ink:     "bg-ink text-paper",
        amber:   "bg-amber text-white",
        emerald: "bg-emerald text-white",
        indigo:  "bg-indigo text-white",
        rose:    "bg-rose text-white",
        slate:   "bg-slate text-white",
        muted:   "bg-paper-2 text-ink-2",
      },
    },
    defaultVariants: {
      size: "md",
      color: "ink",
    },
  }
);

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  /** Image URL — if set, image is preferred over initials */
  src?: string;
  /** Alt text for the image (required if src is set) */
  alt?: string;
  /** Initials (max 2 chars). Auto-generated from `name` if not provided. */
  initials?: string;
  /** Full name — used to auto-generate initials if `initials` is not set */
  name?: string;
  /** Online status indicator */
  status?: "online" | "offline" | "busy" | "away";
  /** Container className */
  className?: string;
}

export function Avatar({
  src,
  alt,
  initials,
  name,
  status,
  size = "md",
  color = "ink",
  className,
}: AvatarProps) {
  const displayInitials = initials ?? (name ? makeInitials(name) : "?");

  return (
    <div className={cn("relative inline-block", className)}>
      {src ? (
        <Image
          src={src}
          alt={alt ?? `Avatar of ${name ?? displayInitials}`}
          width={sizePx[size ?? "md"]}
          height={sizePx[size ?? "md"]}
          className={cn(avatarVariants({ size }), "object-cover")}
        />
      ) : (
        <span className={avatarVariants({ size, color })} aria-label={name ?? `Avatar ${displayInitials}`}>
          {displayInitials}
        </span>
      )}
      {status && <AvatarStatus status={status} size={size ?? "md"} />}
    </div>
  );
}

function AvatarStatus({
  status,
  size,
}: {
  status: NonNullable<AvatarProps["status"]>;
  size: NonNullable<AvatarProps["size"]>;
}) {
  const sizeMap = {
    xs: "w-1.5 h-1.5",
    sm: "w-2 h-2",
    md: "w-2.5 h-2.5",
    lg: "w-3 h-3",
    xl: "w-3.5 h-3.5",
  };
  const colorMap = {
    online:  "bg-emerald",
    offline: "bg-ink-3",
    busy:    "bg-rose",
    away:    "bg-amber",
  };
  return (
    <span
      className={cn(
        "absolute bottom-0 right-0 rounded-full ring-2 ring-paper",
        sizeMap[size],
        colorMap[status]
      )}
      aria-label={`Status: ${status}`}
    />
  );
}

/**
 * Avatar group — stacked avatars (for team members, attendees, etc.)
 */
export function AvatarGroup({
  avatars,
  max = 3,
  size = "sm",
}: {
  avatars: AvatarProps[];
  max?: number;
  size?: AvatarProps["size"];
}) {
  const visible = avatars.slice(0, max);
  const extra = avatars.length - max;

  return (
    <div className="flex -space-x-2">
      {visible.map((a, i) => (
        <div key={i} className="ring-2 ring-paper rounded-full">
          <Avatar {...a} size={size} />
        </div>
      ))}
      {extra > 0 && (
        <div className="ring-2 ring-paper rounded-full">
          <Avatar initials={`+${extra}`} color="muted" size={size} />
        </div>
      )}
    </div>
  );
}
