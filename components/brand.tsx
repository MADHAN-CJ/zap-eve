import { cn } from '@/lib/utils';

/** The /markets wordmark: drawn slash plus the word, inheriting the local text colour. */
export function Wordmark({ className }: { readonly className?: string }) {
  return (
    <span className={cn('whitespace-nowrap font-medium', className)}>
      <span aria-hidden="true" className="markets-slash">
        /
      </span>
      markets
    </span>
  );
}

/** Inline /markets badge for prose, per the brand rule for descriptions. */
export function MarketsLabel() {
  return (
    <span className="markets-label">
      <Wordmark />
    </span>
  );
}

export function Logomark({
  className,
  mono = true,
}: {
  readonly className?: string;
  readonly mono?: boolean;
}) {
  return (
    // biome-ignore lint/performance/noImgElement: static brand asset, no optimisation needed
    <img
      alt=""
      aria-hidden="true"
      className={cn('h-7 w-auto', className)}
      height={44}
      src={mono ? '/brand/markets-logomark-mono.svg' : '/brand/markets-logomark.svg'}
      width={80}
    />
  );
}

export function BrandHeader({ className }: { readonly className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Logomark />
      <Wordmark className="text-lg" />
    </span>
  );
}
