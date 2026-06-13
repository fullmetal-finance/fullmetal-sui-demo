import Logo from "./Logo";
import { CONTACT, SITE } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="border-t-[0.5px] border-line px-6 py-12 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div className="max-w-[320px]">
          <Logo size="sm" />
          <p className="mt-4 text-[13px] leading-[1.75] text-muted">{SITE.tagline}</p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Contact
          </div>
          <a
            href={`mailto:${CONTACT.email}`}
            className="text-[13px] text-ink-soft transition-colors hover:text-ink"
          >
            {CONTACT.email}
          </a>
          <a
            href={CONTACT.telegramUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-ink-soft transition-colors hover:text-ink"
          >
            {CONTACT.telegramHandle}
          </a>
        </div>
      </div>

      <div className="mt-12 border-t-[0.5px] border-line pt-6">
        <p className="m-0 text-[12px] text-muted">
          © {new Date().getFullYear()} {SITE.name}. Sui testnet demo.
        </p>
      </div>
    </footer>
  );
}
