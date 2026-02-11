'use client';

const features = [
  {
    icon: 'shield',
    title: 'Zero-Knowledge Privacy',
    description: 'Cryptographic proofs verify your withdrawal eligibility without revealing which deposit is yours.',
  },
  {
    icon: 'key',
    title: 'Self-Custodial',
    description: 'Your funds, your control. The protocol never holds your private keys. Only you can withdraw with your note.',
  },
  {
    icon: 'layers',
    title: 'Fixed Denominations',
    description: 'Fixed pool sizes (1, 10, 100 SOL, etc.) maximize privacy by ensuring all deposits look identical.',
  },
  {
    icon: 'zap',
    title: 'Sub-Second Speed',
    description: 'Sub-second deposits. Withdrawals verified on-chain in ~400ms.',
  },
  {
    icon: 'lock',
    title: 'Verifiable Security',
    description: 'Open-source circuits. On-chain proof verification. Cryptographically verifiable at every step.',
  },
];

export default function ValueBlocks() {
  return (
    <section id="features" className="landing-section">
      <div className="text-center mb-16">
        <span className="tech-chip mb-4 inline-block">Why ZeroK</span>
        <h2 className="landing-h2 text-zk-text mb-4">
          Privacy without compromise
        </h2>
        <p className="text-zk-text-muted max-w-2xl mx-auto">
          ZeroK combines battle-tested cryptography with Solana&apos;s performance to deliver practical privacy.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="landing-card group hover:border-zk-teal/30 transition-all duration-300"
          >
            {/* Icon */}
            <div className="w-12 h-12 mb-4 rounded-xl bg-zk-teal/10 flex items-center justify-center group-hover:bg-zk-teal/20 transition-colors">
              {feature.icon === 'shield' && (
                <svg className="w-6 h-6 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              )}
              {feature.icon === 'key' && (
                <svg className="w-6 h-6 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              )}
              {feature.icon === 'layers' && (
                <svg className="w-6 h-6 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              )}
              {feature.icon === 'zap' && (
                <svg className="w-6 h-6 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              )}
              {feature.icon === 'lock' && (
                <svg className="w-6 h-6 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              )}
            </div>

            {/* Content */}
            <h3 className="text-lg font-semibold text-zk-text mb-2">{feature.title}</h3>
            <p className="text-zk-text-muted text-sm leading-relaxed">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
