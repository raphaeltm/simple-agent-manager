/**
 * SAM's head with a slow glow behind it: the host of first-run setup and onboarding.
 * The glow holds still for reduced motion.
 */
export function SamHero({
  celebrate = false,
  size = 'lg',
}: {
  celebrate?: boolean;
  /** `sm` sits beside a heading; `lg` leads a screen. */
  size?: 'sm' | 'lg';
}) {
  const small = size === 'sm';
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center ${
        small ? 'h-12 w-12' : 'mx-auto mb-6 h-28 w-28 sm:h-32 sm:w-32'
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgb(132_204_22/0.45),rgb(34_197_94/0.12)_55%,transparent_72%)] blur-md motion-safe:animate-pulse"
      />
      {celebrate && (
        <span
          aria-hidden="true"
          className="absolute -inset-3 rounded-full border border-accent/40 motion-safe:animate-ping"
        />
      )}
      <img
        src="/sam-head.png"
        alt=""
        width={small ? 40 : 112}
        height={small ? 40 : 112}
        className={`relative drop-shadow-[0_8px_24px_rgb(34_197_94/0.35)] ${
          small ? 'h-10 w-10' : 'h-24 w-24 sm:h-28 sm:w-28'
        }`}
      />
    </div>
  );
}
