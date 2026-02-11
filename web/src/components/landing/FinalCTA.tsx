'use client';

import Link from 'next/link';

export default function FinalCTA() {
  return (
    <section className="landing-section relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 hero-gradient opacity-50" />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        {/* Headline */}
        <h2 className="landing-h2 text-zk-text mb-4">
          Ready for private transactions?
        </h2>
        <p className="text-zk-text-muted text-lg mb-8 max-w-xl mx-auto">
          Start using ZeroK today. Self-custodial, verifiable, private.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="https://devnet.zerok.app/app"
            className="btn-cta text-base px-10 py-4 text-lg"
          >
            Launch App
          </a>
          <a
            href="https://docs.zerok.app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost text-base px-8 py-3"
          >
            Read the Docs
          </a>
        </div>

        {/* Trust chips */}
        <div className="mt-8 flex flex-wrap justify-center gap-3 text-zk-text-muted text-sm">
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            No KYC required
          </span>
          <span className="text-zk-border">•</span>
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Self-custodial
          </span>
          <span className="text-zk-border">•</span>
          <span className="flex items-center gap-1.5">
            <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Open source
          </span>
        </div>
      </div>
    </section>
  );
}
