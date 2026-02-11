'use client';

import { useState } from 'react';

const steps = [
  {
    number: 1,
    title: 'Deposit',
    shortDesc: 'Add SOL to a pool',
    fullDesc: 'Send a fixed amount of SOL (0.1, 1, or 10) to the smart contract. Your deposit is added to a Merkle tree as a cryptographic commitment.',
    icon: 'deposit',
    techChips: ['Poseidon Hash', 'Merkle Tree'],
  },
  {
    number: 2,
    title: 'Wait',
    shortDesc: 'Build anonymity set',
    fullDesc: 'As more users deposit, the anonymity set grows. The larger the set, the stronger your privacy. Your identity becomes one among many.',
    icon: 'wait',
    techChips: ['Anonymity Set'],
  },
  {
    number: 3,
    title: 'Withdraw',
    shortDesc: 'Prove & receive',
    fullDesc: 'Generate a zero-knowledge proof that you made a deposit without revealing which one. The contract verifies and sends SOL to any address.',
    icon: 'withdraw',
    techChips: ['Groth16 ZK Proof', 'Nullifier'],
  },
];

export default function HowItWorks() {
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);

  return (
    <section id="how-it-works" className="landing-section bg-zk-surface/30">
      <div className="text-center mb-16">
        <span className="tech-chip mb-4 inline-block">How It Works</span>
        <h2 className="landing-h2 text-zk-text mb-4">
          Three steps to private transactions
        </h2>
        <p className="text-zk-text-muted max-w-2xl mx-auto">
          ZeroK uses zero-knowledge proofs to break the on-chain link between your deposit and withdrawal.
        </p>
      </div>

      {/* Steps Container */}
      <div className="relative">
        {/* Connection Lines (Desktop) */}
        <div className="hidden md:block absolute top-24 left-1/2 -translate-x-1/2 w-2/3 h-0.5 bg-gradient-to-r from-zk-teal/20 via-zk-teal/40 to-zk-teal/20" />

        {/* Steps Grid */}
        <div className="grid md:grid-cols-3 gap-8 md:gap-6 relative">
          {steps.map((step, index) => (
            <div
              key={step.number}
              className="relative"
              onMouseEnter={() => setHoveredStep(step.number)}
              onMouseLeave={() => setHoveredStep(null)}
            >
              {/* Mobile Connection Line */}
              {index < steps.length - 1 && (
                <div className="md:hidden absolute left-1/2 -translate-x-1/2 top-full h-8 w-0.5 bg-gradient-to-b from-zk-teal/40 to-transparent" />
              )}

              <div
                className={`landing-card text-center transition-all duration-300 ${
                  hoveredStep === step.number
                    ? 'border-zk-teal/40 shadow-lg shadow-zk-teal/10 scale-[1.02]'
                    : ''
                }`}
              >
                {/* Step Number */}
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-zk-teal flex items-center justify-center text-zk-bg font-bold text-sm">
                  {step.number}
                </div>

                {/* Icon */}
                <div className="w-16 h-16 mx-auto mb-4 mt-4 rounded-2xl bg-zk-teal/10 flex items-center justify-center">
                  {step.icon === 'deposit' && (
                    <svg className="w-8 h-8 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  )}
                  {step.icon === 'wait' && (
                    <svg className="w-8 h-8 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                  {step.icon === 'withdraw' && (
                    <svg className="w-8 h-8 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  )}
                </div>

                {/* Title */}
                <h3 className="text-xl font-semibold text-zk-text mb-2">{step.title}</h3>

                {/* Description - toggles based on hover */}
                <p className="text-zk-text-muted text-sm mb-4 min-h-[60px]">
                  {hoveredStep === step.number ? step.fullDesc : step.shortDesc}
                </p>

                {/* Tech Chips */}
                <div className={`flex flex-wrap justify-center gap-2 transition-opacity duration-300 ${
                  hoveredStep === step.number ? 'opacity-100' : 'opacity-60'
                }`}>
                  {step.techChips.map((chip) => (
                    <span key={chip} className="tech-chip text-xs">
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Visual Flow Indicator */}
      <div className="mt-12 flex justify-center items-center gap-4 text-zk-text-muted">
        <span className="text-sm">Your Funds</span>
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
        <span className="text-sm">ZK Pool</span>
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
        <span className="text-sm font-medium text-zk-teal">Private Withdrawal</span>
      </div>

      {/* Docs Link */}
      <div className="mt-6 flex justify-center">
        <a
          href="https://docs.zerok.app/how-it-works"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-zk-text-muted hover:text-zk-teal transition-colors flex items-center gap-1.5"
        >
          Learn more in the docs
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
          </svg>
        </a>
      </div>
    </section>
  );
}
