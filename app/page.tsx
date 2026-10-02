import Image from "next/image";
import Link from "next/link";
import styles from "./landing.module.css";

const heroVideo = "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260319_055001_8e16d972-3b2b-441c-86ad-2901a54682f9.mp4";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <video className={styles.backgroundVideo} autoPlay muted loop playsInline preload="metadata" aria-hidden="true">
        <source src={heroVideo} type="video/mp4" />
      </video>
      <div className={styles.backdrop} aria-hidden="true" />

      <header className={styles.header}>
        <Link className={styles.brand} href="/markets" aria-label="Gargantua">
          <Image className={styles.logo} src="/gargantua-emblem.png" alt="" width={1535} height={1024} priority />
          <span>Gargantua</span>
        </Link>
        <nav className={styles.nav} aria-label="Community and waitlist">
          <span className={styles.socialMark} role="img" aria-label="X">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.9-7.5L5.4 22H2.3l7.3-8.4L1 2h6.4l4.4 6.9L18.9 2Zm-1.1 17.9h1.7L7.3 4H5.5l12.3 15.9Z" /></svg>
          </span>
          <span className={styles.socialMark} role="img" aria-label="Discord">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.7 5.2a18.2 18.2 0 0 0-4.5-1.4l-.6 1.2a16.8 16.8 0 0 0-5.2 0l-.6-1.2a18.2 18.2 0 0 0-4.5 1.4C1.5 9.4.7 13.5 1.1 17.5a18.4 18.4 0 0 0 5.5 2.8l1.2-2a11.9 11.9 0 0 1-1.9-.9l.5-.4a13.1 13.1 0 0 0 11.2 0l.5.4a11.9 11.9 0 0 1-1.9.9l1.2 2a18.4 18.4 0 0 0 5.5-2.8c.5-4.7-.8-8.8-3.2-12.3ZM8.7 14.9c-1.1 0-2-.9-2-2.1s.9-2.1 2-2.1 2 .9 2 2.1-.9 2.1-2 2.1Zm6.6 0c-1.1 0-2-.9-2-2.1s.9-2.1 2-2.1 2 .9 2 2.1-.9 2.1-2 2.1Z" /></svg>
          </span>
          <span className={styles.waitlist} role="img" aria-label="Waitlist">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5A1.5 1.5 0 0 1 4 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M6 7h8M6 10h8M6 13h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span>Waitlist</span>
          </span>
        </nav>
      </header>

      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroCopy}>
          <h1 id="hero-title">Derivatives layer for<br />prediction markets</h1>
          <p>Express multiple worldviews in a single leveraged position.</p>
          <Link className={styles.cta} href="/markets">Start trading</Link>
        </div>
      </section>

      <aside className={styles.poweredBy} aria-label="Powered by Solana">
        <span className={styles.poweredLabel}>POWERED BY</span>
        <span className={styles.solana}>
          <Image className={styles.solanaLogo} src="/solana-logo-mark.png" alt="" width={100} height={96} />
          <span>Solana</span>
        </span>
      </aside>
    </main>
  );
}
