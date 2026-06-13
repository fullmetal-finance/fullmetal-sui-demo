import Logo from "./Logo";
import ConnectWallet from "./ConnectWallet";
import { NAV_LINKS } from "@/lib/site";

export default function Nav() {
  return (
    <nav className="relative z-30 flex items-center justify-between px-6 py-5 sm:px-8">
      <Logo size="md" />

      <div className="flex items-center gap-6 max-sm:gap-4">
        {NAV_LINKS.map((l) => (
          <a
            key={l.label}
            href={l.href}
            {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="text-[12px] tracking-[0.08em] text-ink-soft transition-colors hover:text-ink max-sm:hidden"
          >
            {l.label}
          </a>
        ))}
        <ConnectWallet />
      </div>
    </nav>
  );
}
