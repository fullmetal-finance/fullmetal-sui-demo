import Image from "next/image";
import Link from "next/link";
import { SITE } from "@/lib/site";

/* Brand logo, ported from fullmetal-web. We use logo-transparent.png (the flat
   background keyed out) so the page/header background shows through in BOTH
   themes — `dark:invert` then only flips the grayscale wordmark to light for
   dark mode, with no mismatched rectangle behind it. */

const SIZES = {
  lg: "h-16 w-[248px]",
  md: "h-10 w-[155px] sm:h-12 sm:w-[186px]",
  sm: "h-8 w-[124px]",
} as const;

export default function Logo({
  size = "md",
  className = "",
}: {
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <Link href="/" aria-label={SITE.name} className={`inline-block ${className}`}>
      <span className={`relative block ${SIZES[size]}`}>
        <Image
          src="/logo-transparent.png"
          alt={`${SITE.name} logo`}
          fill
          priority
          sizes="248px"
          className="object-cover object-center dark:invert"
        />
      </span>
    </Link>
  );
}
