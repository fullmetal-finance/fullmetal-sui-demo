import Image from "next/image";
import Link from "next/link";
import { SITE } from "@/lib/site";

/* Brand logo (public/logo.png), ported from fullmetal-web.
   Grayscale art on near-white, so `dark:invert` covers dark mode. */

const SIZES = {
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
          src="/logo.png"
          alt={`${SITE.name} logo`}
          fill
          priority
          sizes="186px"
          className="object-cover object-center dark:invert"
        />
      </span>
    </Link>
  );
}
