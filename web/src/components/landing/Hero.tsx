'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const headlines = [
  'Private transactions, verified in zero-knowledge.',
  'Break the on-chain link between deposit and withdrawal.',
  'Privacy first \u2014 self-custodial, verifiable, fast.',
  'Your transactions. Your business.',
];

const trustChips = [
  { icon: 'shield', text: 'Self-custodial' },
  { icon: 'check', text: 'Proof verified on-chain' },
  { icon: 'zap', text: 'Fast' },
];

export default function Hero() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % headlines.length);
        setIsAnimating(false);
      }, 500);
    }, 4000);

    return () => clearInterval(interval);
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <section className="relative min-h-screen flex items-center justify-center hero-gradient overflow-hidden">
      {/* Background decorations */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-zk-teal/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-zk-teal/3 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Main Headline */}
        <div className="h-32 sm:h-40 flex items-center justify-center mb-6">
          <h1
            className={`landing-h1 text-zk-text transition-all duration-500 ${
              isAnimating ? 'opacity-0 translate-y-4' : 'opacity-100 translate-y-0'
            }`}
          >
            {headlines[currentIndex]}
          </h1>
        </div>

        {/* Headline Indicators */}
        <div className="flex justify-center gap-2 mb-8">
          {headlines.map((_, index) => (
            <button
              key={index}
              onClick={() => {
                setIsAnimating(true);
                setTimeout(() => {
                  setCurrentIndex(index);
                  setIsAnimating(false);
                }, 300);
              }}
              className={`w-2 h-2 rounded-full transition-all duration-300 ${
                index === currentIndex
                  ? 'bg-zk-teal w-8'
                  : 'bg-zk-border hover:bg-zk-text-muted'
              }`}
              aria-label={`Go to headline ${index + 1}`}
            />
          ))}
        </div>

        {/* Subheadline */}
        <p className="text-lg sm:text-xl text-zk-text-muted max-w-2xl mx-auto mb-10">
          Deposit into fixed pools. Withdraw later with a ZK proof.
          <br className="hidden sm:block" />
          No direct link between sender and recipient.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
          <a href="https://devnet.zerok.app/app" className="btn-cta text-base px-8 py-3">
            Launch App
          </a>
          <button
            onClick={() => scrollToSection('how-it-works')}
            className="btn-ghost text-base px-8 py-3 flex items-center gap-2"
          >
            How it Works
            <svg
              className="w-4 h-4 scroll-indicator"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          </button>
        </div>
        <div className="flex justify-center mb-12">
          <a
            href="https://docs.zerok.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zk-text-muted hover:text-zk-teal transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            Read the Docs
          </a>
        </div>

        {/* Trust Chips */}
        <div className="flex flex-wrap justify-center gap-3">
          {trustChips.map((chip) => (
            <div key={chip.text} className="trust-chip">
              {chip.icon === 'shield' && (
                <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              )}
              {chip.icon === 'check' && (
                <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              {chip.icon === 'zap' && (
                <svg className="w-4 h-4 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              )}
              {chip.text}
            </div>
          ))}
        </div>
      </div>

      {/* Scroll indicator at bottom */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
        <button
          onClick={() => scrollToSection('problem')}
          className="text-zk-text-muted hover:text-zk-teal transition-colors"
          aria-label="Scroll to next section"
        >
          <svg
            className="w-6 h-6 scroll-indicator"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
        </button>
      </div>
    </section>
  );
}
